/**
 * /api/ai routes (Phase 4 / issues #31–#36).
 *
 * Endpoints
 * ─────────
 *   POST /api/ai/sessions               — create an `AISession` row
 *   GET  /api/ai/sessions/:id           — read session metadata + policy
 *   PATCH /api/ai/sessions/:id          — update title/policy
 *   GET  /api/ai/sessions/:id/usage     — return aggregated usage rows
 *   GET  /api/ai/sessions/:id/approvals — return approval audit rows
 *   GET  /api/ai/usage/today            — daily rollup for the caller
 *   GET  /api/ai/tools                  — list registered tools (name+risk)
 *   POST /api/ai/chat                   — non-streaming completion
 *   POST /api/ai/stream                 — Server-Sent-Events streaming
 *
 * Provider construction is centralised in {@link getProvider}; tests can
 * inject a stub via {@link setAIProviderForTests}.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse, SdkReasoningEffort } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { aiRateLimiter } from "../middleware/ai-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit/audit-service.js";
import { buildSystemBlock as buildChronicleBlock } from "../lib/memory/chronicle.js";
import { prisma } from "../lib/prisma.js";
import { getVaultService } from "../lib/vault/vault-service.js";
import { getSessionRuntime, SessionRuntimeError } from "../lib/library/index.js";
import { getProjectLibraryAllowlist } from "../lib/library/index.js";
import { createChildLogger } from "../lib/logger.js";
import { applySafety, SafetyDeniedError } from "../lib/safety/index.js";
import {
  recordUsage as recordProjectUsage,
  assertWithinBudget,
  BudgetExceededError,
} from "../lib/finops/index.js";
import {
  buildProvider,
  loadAIConfig,
  parsePolicyJson,
  policyToJson,
  normalizePolicy,
  hashPrompt,
  getTokenTracker,
  getToolRegistry,
  resolveCopilotHomeForSession,
  assembleChatSystem,
  CITATION_INSTRUCTION,
} from "../lib/ai/index.js";
import type {
  AIProvider,
  AssembledChatSystem,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatResponse,
} from "../lib/ai/index.js";
import { buildChatCodeToolRuntime, runChatCodeToolTurn } from "../lib/ai/chat-code-tool-runtime.js";
import {
  withIdleTimeout,
  StreamIdleTimeoutError,
  STREAM_IDLE_TIMEOUT_CODE,
} from "../lib/ai/stream-idle.js";
import { writeSnapshot } from "../lib/ai/session-snapshot.js";
import { getOnlineEvalScorer } from "../lib/eval/online/scorer.js";
import { messageText } from "../lib/ai/index.js";
import { AIError, AIOfflineError } from "../lib/ai/errors.js";
import { getSemanticCache, shouldSkipCache } from "../lib/ai/semantic-cache.js";
import { getKnowledgeService } from "../lib/rag/knowledge-service.js";
import {
  buildFusedCodeBlock,
  type FusedCodeSearcher,
  type FusedRagChunkRef,
  type SymbolLineLookup,
} from "../lib/rag/fused-code-context.js";
import {
  createDefaultCodeSearcher,
  createDefaultSymbolLineLookup,
} from "../lib/code-graph/project-code-searcher.js";
import { getConfigService } from "../lib/config/config-service.js";

const log = createChildLogger("ai-routes");

/** Injectable fused code-graph retrieval seam (#714); overridable in tests. */
export interface FusedCodeDeps {
  searcher: FusedCodeSearcher;
  lineLookup: SymbolLineLookup;
}

function defaultFusedCodeDeps(): FusedCodeDeps {
  return {
    searcher: createDefaultCodeSearcher(),
    lineLookup: createDefaultSymbolLineLookup(),
  };
}

// SSE protections — see M1 in the route below.
//
// Read on every request so tests can poke env vars between calls. Defaults
// match the review brief: 60s socket idle timeout, 15s heartbeat, 5min hard
// ceiling.
const intEnv = (raw: string | undefined, fallback: number, min = 1): number => {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
function streamLimits(): {
  socketTimeoutMs: number;
  heartbeatIntervalMs: number;
  hardCeilingMs: number;
  idleTimeoutMs: number;
} {
  return {
    socketTimeoutMs: intEnv(process.env.AI_STREAM_SOCKET_TIMEOUT_MS, 60_000, 1000),
    heartbeatIntervalMs: intEnv(process.env.AI_STREAM_HEARTBEAT_MS, 15_000, 1),
    hardCeilingMs: intEnv(process.env.AI_STREAM_MAX_DURATION_MS, 5 * 60_000, 1),
    // #1366 — no TOKEN for this long ends the turn. Distinct from the socket
    // timeout (which the heartbeat keeps resetting) and from the hard ceiling
    // (a total-duration cap that cannot see a stall inside a long turn). Set to
    // 0 to disable.
    idleTimeoutMs: intEnv(process.env.AI_STREAM_IDLE_TIMEOUT_MS, 90_000, 0),
  };
}

let providerOverride: AIProvider | null = null;
function provider(opts: { apiKeyOverride?: string } = {}): AIProvider {
  if (providerOverride) return providerOverride;
  return buildProvider({ config: loadAIConfig(), apiKeyOverride: opts.apiKeyOverride });
}

/** Test seam — tests inject a deterministic stub. */
export function setAIProviderForTests(p: AIProvider | null): void {
  providerOverride = p;
}

/**
 * #700 — the prompt-cache posture shared by the non-stream `/chat` and SSE
 * `/stream` routes. `callType` attributes both to the "chat" workload in the
 * cache-hit telemetry (#699); `promptCaching.system` requests caching of the
 * byte-stable system prefix (persona + skills lead; see
 * {@link buildLibrarySystemMessages}). `messages` is deliberately omitted: each
 * chat turn's final user block is unique, so caching it would only pay the write
 * premium with no reuse (#389). These flags are honoured on the
 * BedrockDirect/native-Anthropic paths and are an inert no-op on the Copilot
 * SDK/gateway path, where transparent gateway caching applies instead.
 */
export const CHAT_CACHE_OPTS = {
  callType: "chat",
  promptCaching: { system: true },
} as const satisfies Pick<ChatOptions, "callType" | "promptCaching">;

/**
 * Epic #647 / Issue #654 — Sliding window that keeps only the last N
 * user/assistant turn pairs. System messages are always preserved.
 */
export function windowHistory(messages: ChatMessage[], maxTurns: number): ChatMessage[] {
  if (maxTurns <= 0) return messages;

  const system: ChatMessage[] = [];
  const nonSystem: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      system.push(msg);
    } else {
      nonSystem.push(msg);
    }
  }

  // Find the index of the Nth-from-last user message — include from there.
  const userIndices: number[] = [];
  for (let i = 0; i < nonSystem.length; i++) {
    if (nonSystem[i].role === "user") userIndices.push(i);
  }

  if (userIndices.length <= maxTurns) return [...system, ...nonSystem];

  // Keep the last `maxTurns` user messages and everything after the cut point
  const cutAt = userIndices[userIndices.length - maxTurns];
  return [...system, ...nonSystem.slice(cutAt)];
}

/**
 * Epic #647 / Issue #653 — Estimate per-component token breakdown.
 * Uses 4 chars ≈ 1 token approximation.
 */
export function estimateBreakdown(parts: {
  systemMessages: ChatMessage[];
  libraryMessages: ChatMessage[];
  historyMessages: ChatMessage[];
  userMessage: string;
  codeContext?: string;
  toolsJson?: string;
}): Record<string, number> {
  const est = (text: string) => Math.ceil(text.length / 4);
  return {
    system_prompt: parts.systemMessages.reduce((sum, m) => sum + est(messageText(m)), 0),
    library_context: parts.libraryMessages.reduce((sum, m) => sum + est(messageText(m)), 0),
    chat_history: parts.historyMessages.reduce((sum, m) => sum + est(messageText(m)), 0),
    user_message: est(parts.userMessage),
    code_context: parts.codeContext ? est(parts.codeContext) : 0,
    tools: parts.toolsJson ? est(parts.toolsJson) : 0,
  };
}

/**
 * Resolve a per-session BYOK API key via the Phase-2 vault.
 *
 * Returns the plaintext when `providerSecretRef` is set on the session;
 * `undefined` otherwise (callers fall back to env-based credentials).
 * Vault read failures are surfaced as a 502 so the caller sees a clear
 * "credentials unreachable" error rather than a confusing 401 from the
 * upstream provider.
 */
async function resolveProviderKey(ref: string | null | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  try {
    const { plaintext } = await getVaultService().read(ref);
    return plaintext;
  } catch (err) {
    log.error("Vault read failed for AI session BYOK key", {
      ref,
      error: (err as Error).message,
    });
    throw new AppError(502, "AI_PROVIDER_KEY_UNAVAILABLE", "Provider credentials unreachable");
  }
}

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().min(1).max(40_000),
  name: z.string().max(120).optional(),
  toolCallId: z.string().max(120).optional(),
});

const chatBodySchema = z.object({
  sessionId: z.string().min(1),
  messages: z.array(messageSchema).min(1).max(100),
  model: z.string().max(120).optional(),
  systemMessage: z.string().max(20_000).optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
});

const policySchema = z.object({
  low: z.enum(["auto", "prompt-once", "always-prompt", "deny"]),
  medium: z.enum(["auto", "prompt-once", "always-prompt", "deny"]),
  high: z.enum(["auto", "prompt-once", "always-prompt", "deny"]),
});

const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  projectId: z.string().min(1).max(120).optional(),
  projectIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  model: z.string().max(120).optional(),
  policy: policySchema.partial().optional(),
  providerSecretRef: z.string().max(200).optional(),
  /// Phase 10 — optional Agent persona to bind to this session.
  agentId: z.string().min(1).max(120).optional(),
  agentKey: z.string().min(1).max(120).optional(),
  /// Phase 10 — explicit skill ids to pre-load (in addition to any the
  /// agent declares as defaults).
  skillIds: z.array(z.string().min(1).max(120)).max(16).optional(),
});

const updateSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  policy: policySchema.partial().optional(),
  status: z.enum(["active", "archived", "terminated"]).optional(),
});

function userIdOrThrow(req: Request): string {
  const id = req.user?.userId;
  if (!id) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return id;
}

async function loadSession(sessionId: string, userId: string) {
  const session = await prisma.aISession.findFirst({
    where: { id: sessionId, userId, deletedAt: null },
  });
  if (!session) throw new AppError(404, "AI_SESSION_NOT_FOUND", "Session not found");
  return session;
}

/** Epic #164 — fetch the project's current safetyMode (cached per request). */
async function loadSafetyMode(projectId: string): Promise<"strict" | "standard" | "off"> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { safetyMode: true },
  });
  const v = row?.safetyMode ?? "standard";
  return v === "strict" || v === "off" ? v : "standard";
}

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/** Parse a JSON-encoded string column into a string[], tolerating corruption. */
function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function aiErrorToAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof AIOfflineError) {
    return new AppError(503, err.code, err.message);
  }
  if (err instanceof AIError) {
    return new AppError(
      err.status,
      err.code,
      err.message,
      (err.details as Record<string, unknown>) ?? undefined,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AppError(500, "AI_PROVIDER_ERROR", message);
}

/** * Auto-RAG: retrieve relevant knowledge chunks for the user's query and
 * return a system message with the context. Returns empty string when no
 * knowledge is available or retrieval fails.
 *
 * The instruction is deliberately explicit about which project "the project"
 * refers to. Chat history is resent in full on every turn (the client has no
 * server-side transcript store), so a long-running session can drift onto
 * unrelated topics (e.g. the user asking about the METIS tool itself). Without
 * naming the bound project, a later ambiguous question like "give an overview
 * of the project" can get answered from stale conversational topic drift
 * instead of the freshly retrieved, project-scoped chunks below.
 */
export interface RagContextCapture {
  /**
   * The individual retrieved contexts exactly as they were handed to the
   * model — one entry per doc chunk, plus the fused code block (#714) as its
   * own entry when present.
   *
   * Issue #1321: the online-eval observer needs these. It gets them from the
   * builder rather than by re-splitting the assembled block on its separator,
   * which silently mis-parses any chunk that itself contains `\n\n---\n\n`
   * (an ordinary markdown horizontal rule) and glues the fused block onto the
   * last context.
   */
  contexts: string[];
}

export async function buildAutoRagContext(
  projectId: string | null,
  messages: ChatMessage[],
  fusedDeps: FusedCodeDeps = defaultFusedCodeDeps(),
  capture?: RagContextCapture,
): Promise<string> {
  // Extract the last user message as the retrieval query.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser || !projectId) return "";
  const query = messageText(lastUser).slice(0, 2048);
  if (!query.trim()) return "";

  // #714 — fused code-graph retrieval is env-gated and OFF by default. Read the
  // flag once so the disabled path issues no code-graph query and is
  // byte-identical to the original doc-RAG-only block.
  const cfg = getConfigService();
  const fusedEnabled = cfg.getBool("CHAT_FUSED_CODE_RETRIEVAL", false);

  try {
    const service = getKnowledgeService();
    const { hits } = await service.search(projectId, query, { k: 8 });

    // Build the doc-level RAG block (unchanged wording) when there are hits.
    let ragBlock = "";
    let ragChunks: FusedRagChunkRef[] = [];
    if (hits.length > 0) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true },
      });
      const projectName = project?.name?.trim() || "this project";
      const chunkList = hits.map(
        (h, i) => `[${i + 1}] ${h.filename}#${h.position} (score=${h.score.toFixed(3)})\n${h.text}`,
      );
      if (capture) capture.contexts.push(...chunkList);
      const chunks = chunkList.join("\n\n---\n\n");
      ragBlock =
        `## Retrieved Knowledge (project-scoped RAG)\n` +
        `This chat session is scoped to the project "${projectName}". The excerpts below were ` +
        `retrieved from "${projectName}"'s own knowledge base and are the authoritative source for ` +
        `any question about "the project" or "this project" — that phrase always means "${projectName}", ` +
        `never METIS (the platform this chat runs on) and never any other topic raised earlier in this ` +
        `conversation. Prefer these excerpts over your own background knowledge or earlier chat history:\n\n${chunks}`;
      ragChunks = hits.map((h) => ({ filename: h.filename }));
    }

    // #714 — passively merge deduped, budgeted code-graph symbol hits. A no-op
    // (empty block, no searcher call) when the flag is off or no code graph
    // exists, so `ragBlock` is returned exactly as before in that case.
    const fused = await buildFusedCodeBlock({
      projectId,
      query,
      ragChunks,
      enabled: fusedEnabled,
      tokenBudget: cfg.getNumber("CHAT_FUSED_CODE_TOKEN_BUDGET", 1500),
      maxSymbols: cfg.getNumber("CHAT_FUSED_CODE_MAX_SYMBOLS", 12),
      searcher: fusedDeps.searcher,
      lineLookup: fusedDeps.lineLookup,
    });

    if (capture && fused.block) capture.contexts.push(fused.block);
    if (!ragBlock && !fused.block) return "";
    if (!fused.block) return ragBlock;
    if (!ragBlock) return fused.block;
    return `${ragBlock}\n\n${fused.block}`;
  } catch (err) {
    // A partially-filled capture would misrepresent what the model saw.
    if (capture) capture.contexts.length = 0;
    log.debug("Auto-RAG retrieval failed, continuing without context", {
      projectId,
      error: (err as Error).message,
    });
    return "";
  }
}

/** * Phase 10 / #700 \u2014 build the library-injected system messages for a chat
 * call from the agent persona + currently-loaded skills + per-project Chronicle
 * block on the session row.
 *
 * The pieces are assembled into a **byte-stable lead** (persona + skills, which
 * are constant for the session) and a **volatile tail** (the Chronicle memory
 * block, which grows over time) via {@link assembleChatSystem}, so the stable
 * lead can precede the gateway/provider cachePoint unchanged across turns. The
 * caller appends the user-supplied `systemMessage` after this, in the volatile
 * region, so explicit per-call overrides still take effect.
 */
export async function buildLibrarySystemMessages(
  session: {
    agentId: string | null;
    loadedSkillIds: string;
    projectId?: string | null;
  },
  /**
   * #713 — the deterministically-ordered code-tool schema block, injected into
   * the byte-stable lead after skills. `""`/absent (flag off) ⇒ the lead is
   * byte-identical to before this feature.
   */
  toolSchemas?: string,
): Promise<AssembledChatSystem> {
  // Stable — agent persona bound to the session.
  let persona: string | null = null;
  if (session.agentId) {
    try {
      const resolved = await getSessionRuntime().resolveAgentForSession({
        agentId: session.agentId,
      });
      persona = resolved.systemMessage;
    } catch {
      // Agent might have been disabled mid-session; the existing snapshot on
      // the session row stays authoritative for audit, but we skip injection.
    }
  }

  // Stable — loaded skill instruction blocks, in the session's load order.
  const skillBlocks: string[] = [];
  let skillIds: string[] = [];
  try {
    const v = JSON.parse(session.loadedSkillIds) as unknown;
    if (Array.isArray(v)) skillIds = v.filter((x): x is string => typeof x === "string");
  } catch {
    skillIds = [];
  }
  if (skillIds.length > 0) {
    const rows = await prisma.skill.findMany({
      where: { id: { in: skillIds }, deletedAt: null, enabled: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of skillIds) {
      const row = byId.get(id);
      if (!row) continue;
      const header = `[skill:${row.key}@${row.version}] ${row.name}`;
      const desc = row.description ? `\n${row.description}` : "";
      const body = row.instructions.trim();
      skillBlocks.push(body.length === 0 ? `${header}${desc}` : `${header}${desc}\n\n${body}`);
    }
  }

  // Volatile — per-project Chronicle memory block (#157). Small (~1KB, bounded
  // by entry count/value length) but grows over time, so it rides AFTER the
  // stable lead rather than ahead of it (#700).
  let chronicle: string | null = null;
  if (session.projectId) {
    try {
      const block = await buildChronicleBlock(session.projectId);
      if (block.length > 0) chronicle = block;
    } catch {
      // Chronicle failures must never break the chat path.
    }
  }

  // #715 — the static source-citation policy is fixed prompt text, so it rides in
  // the byte-stable lead (after persona/skills/tool schemas). Always present: it
  // teaches the model to cite `filePath:startLine-endLine` when a retrieved code
  // symbol carries one, and to degrade gracefully (no fabricated file:line) when
  // none does. This shifts the cached prefix once per deploy, never per request.
  return assembleChatSystem({
    persona,
    skillBlocks,
    toolSchemas,
    citationInstruction: CITATION_INSTRUCTION,
    chronicle,
  });
}

/**
 * Issue #113 — materialise the session's loaded skills into the per-session
 * COPILOT_HOME so the GitHub Copilot SDK picks them up natively. Returns the
 * `skillDirectories` + `disabledSkills` arrays that should be forwarded to
 * `provider.chat` / `provider.stream`. Falls back to `{}` when the session
 * has no loaded skills, when materialisation fails (best-effort — the
 * system-message injection path keeps working), or when the session is
 * bound to a project whose allow-list rejects every loaded skill.
 *
 * The disabled-skills array is sourced from `ProjectSkillAllowlist` rows
 * with `enabled = false` so users can mute a default-skill on a per-project
 * basis without having to delete the agent binding.
 */
export async function buildSdkSkillRuntime(session: {
  id: string;
  loadedSkillIds: string;
  projectId: string | null;
}): Promise<{ skillDirectories?: string[]; disabledSkills?: string[]; disableTools?: boolean }> {
  let skillIds: string[] = [];
  try {
    const v = JSON.parse(session.loadedSkillIds) as unknown;
    if (Array.isArray(v)) skillIds = v.filter((x): x is string => typeof x === "string");
  } catch {
    skillIds = [];
  }
  let disabledSkillKeys: string[] = [];
  if (session.projectId) {
    try {
      const rows = await getProjectLibraryAllowlist().listSkills(session.projectId);
      disabledSkillKeys = rows.filter((r) => !r.enabled).map((r) => r.skillKey);
    } catch {
      // Fall through — the global allow path below stays authoritative.
    }
  }
  if (skillIds.length === 0 && disabledSkillKeys.length === 0) return { disableTools: true };
  // #1368 — an UNSCOPED session must not get the SDK's built-in filesystem and
  // shell tools. METIS's own curated code tools were already gated on
  // `projectId` (see `buildChatCodeToolRuntime`), but the SDK's built-ins were
  // not: they were withheld only when `disableTools` happened to be set above,
  // so any session that had loaded a skill kept `bash` regardless of scope.
  // With no project corpus to search, the only tree those tools can reach is
  // METIS's own — which is exactly the observed failure, where a user asking
  // about their codebase got an answer grepped out of `server/src`. Skills still
  // load; only the tools are withheld.
  const unscoped = !session.projectId;
  try {
    const copilotHome = resolveCopilotHomeForSession(session.id);
    const result = await getSessionRuntime().materializeSkillsForSession({
      sessionId: session.id,
      copilotHome,
      loadedSkillIds: skillIds,
      disabledSkillKeys,
    });
    const out: { skillDirectories?: string[]; disabledSkills?: string[]; disableTools?: boolean } =
      {};
    if (result.written.length > 0) out.skillDirectories = [result.skillsDir];
    if (result.disabledSkills.length > 0) out.disabledSkills = result.disabledSkills;
    if (unscoped) out.disableTools = true;
    return out;
  } catch (err) {
    log.warn("Failed to materialise SDK skills, falling back to system-message only", {
      sessionId: session.id,
      error: (err as Error).message,
    });
    return { disableTools: true };
  }
}

export function aiRouter(): Router {
  const r = Router();

  // ── Sessions ─────────────────────────────────────────────────────────────
  r.post("/sessions", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const parsed = createSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid session payload", {
        issues: parsed.error.flatten(),
      });
    }
    const cfg = loadAIConfig();
    const policy = normalizePolicy({
      ...{ low: "auto", medium: "prompt-once", high: "always-prompt" },
      ...(parsed.data.policy ?? {}),
    });

    // v1.0.1 issue #134 — when the session is bound to a project that has
    // a per-project AI provider override, that override wins for the
    // lifetime of the session. Stored on the session row so usage rows /
    // streaming code paths read it back without re-querying the project.
    // v1.2.0 — same fallback rule applies to `aiModel`. The per-session
    // model in the request body still takes precedence over the project
    // override.
    let resolvedProvider: typeof cfg.provider = cfg.provider;
    let resolvedModel: string = parsed.data.model ?? cfg.model;

    // Resolve the effective project scope up-front. Ids may arrive as
    // `projectId` or via the `projectIds` scope selector — both are
    // client-supplied hints persisted in the browser. Two degradation paths
    // exist, and BOTH must be reported back to the client explicitly
    // (issue #607 — never silently drop a requested scope):
    //  - 2+ ids: sessions bind at most one project (the per-project provider /
    //    model override below reads exactly one row), so a multi-project
    //    request degrades to an unscoped session with
    //    reason "multi-project-unsupported".
    //  - a stale id that no longer resolves (deleted project, reset local DB)
    //    degrades to an unscoped session with reason "stale-project" rather
    //    than being handed to Prisma and surfacing as a raw foreign-key
    //    error (HTTP 500).
    // Validate existence once here and reuse the row for the per-project
    // provider / model override below.
    const requestedProjectIds: string[] = parsed.data.projectId
      ? [parsed.data.projectId]
      : (parsed.data.projectIds ?? []);
    let scopeDegradationReason: "multi-project-unsupported" | "stale-project" | null = null;
    let effectiveProjectId: string | null =
      requestedProjectIds.length === 1 ? requestedProjectIds[0] : null;
    if (requestedProjectIds.length > 1) {
      scopeDegradationReason = "multi-project-unsupported";
      log.warn("Multi-project session scope unsupported; creating unscoped session", {
        userId,
        requestedProjectIds,
      });
    }
    if (effectiveProjectId) {
      const project = await prisma.project.findFirst({
        where: { id: effectiveProjectId, deletedAt: null },
        select: { aiProviderId: true, aiModel: true },
      });
      if (!project) {
        log.warn("Session project scope not found; creating unscoped session", {
          userId,
          projectId: effectiveProjectId,
        });
        effectiveProjectId = null;
        scopeDegradationReason = "stale-project";
      } else {
        if (project.aiProviderId) {
          // Validated at write time in project-service against
          // SUPPORTED_PROVIDER_KEYS, so the cast is safe at session-bind.
          resolvedProvider = project.aiProviderId as typeof cfg.provider;
        }
        if (project.aiModel && parsed.data.model === undefined) {
          resolvedModel = project.aiModel;
        }
      }
    }

    // Phase 10 \u2014 optional Agent binding. Resolves the agent persona + its
    // defaultSkills up-front so we can store the snapshot + the loaded
    // skill ids on the new session row. Failures here surface as 4xx via
    // SessionRuntimeError; the session is never created in that case.
    let agentSnapshot: string | null = null;
    let resolvedAgentId: string | null = null;
    let initialSkillIds: string[] = [];
    if (parsed.data.agentId || parsed.data.agentKey) {
      try {
        const resolved = await getSessionRuntime().resolveAgentForSession({
          agentId: parsed.data.agentId,
          agentKey: parsed.data.agentKey,
        });
        resolvedAgentId = resolved.agent.id;
        agentSnapshot = JSON.stringify({
          key: resolved.agent.key,
          name: resolved.agent.name,
          version: resolved.agent.version,
          model: resolved.agent.model,
        });
        initialSkillIds = [...resolved.autoLoadedSkillIds];
      } catch (err) {
        if (err instanceof SessionRuntimeError) {
          throw new AppError(err.status, err.code, err.message);
        }
        throw err;
      }
    }
    if (parsed.data.skillIds && parsed.data.skillIds.length > 0) {
      const dedup = parsed.data.skillIds.filter((id) => !initialSkillIds.includes(id));
      const found = await prisma.skill.findMany({
        where: { id: { in: dedup }, deletedAt: null, archivedAt: null, enabled: true },
        select: { id: true },
      });
      const valid = new Set(found.map((r) => r.id));
      const missing = dedup.filter((id) => !valid.has(id));
      if (missing.length > 0) {
        throw new AppError(
          400,
          "SKILL_REF_NOT_FOUND",
          `Unknown or disabled skill ids: ${missing.join(", ")}`,
        );
      }
      initialSkillIds.push(...dedup);
    }

    const session = await prisma.aISession.create({
      data: {
        userId,
        projectId: effectiveProjectId,
        title: parsed.data.title ?? "New Chat",
        provider: resolvedProvider,
        model: resolvedModel,
        policy: policyToJson(policy),
        providerSecretRef: parsed.data.providerSecretRef ?? null,
        agentId: resolvedAgentId,
        agentSnapshot,
        loadedSkillIds: JSON.stringify(initialSkillIds),
      },
    });
    audit({
      actor: { id: userId },
      action: "ai.session.create",
      target: { type: "ai_session", id: session.id },
      metadata: {
        provider: session.provider,
        model: session.model,
        agentId: resolvedAgentId,
        skillCount: initialSkillIds.length,
      },
    });
    // #607 — echo the applied scope so the client can surface a degraded
    // (requested ≠ applied) scope instead of silently chatting unscoped.
    res.status(201).json(
      ok({
        session: { ...session, policy },
        scope: {
          requestedProjectIds,
          appliedProjectId: session.projectId,
          degraded: scopeDegradationReason !== null,
          ...(scopeDegradationReason ? { reason: scopeDegradationReason } : {}),
        },
      }),
    );
  });

  r.get("/sessions/:id", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const session = await loadSession(String(req.params.id), userId);
    res.json(ok({ session: { ...session, policy: parsePolicyJson(session.policy) } }));
  });

  r.patch("/sessions/:id", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const parsed = updateSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid session update", {
        issues: parsed.error.flatten(),
      });
    }
    const existing = await loadSession(String(req.params.id), userId);
    const policy = parsed.data.policy
      ? policyToJson(
          normalizePolicy({ ...parsePolicyJson(existing.policy), ...parsed.data.policy }),
        )
      : existing.policy;
    const updated = await prisma.aISession.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        policy,
      },
    });

    // M3 — when a session transitions to a terminal state, tear down its
    // per-session COPILOT_HOME directory and any in-memory SDK session. We
    // best-effort the call (logged on failure) so a cleanup hiccup never
    // blocks the user from archiving a session.
    const becameTerminal = parsed.data.status === "archived" || parsed.data.status === "terminated";
    const wasActive = existing.status !== parsed.data.status;
    if (becameTerminal && wasActive) {
      try {
        const p = provider();
        const maybeDestroy = (p as { destroySession?: (id: string) => Promise<void> })
          .destroySession;
        if (typeof maybeDestroy === "function") {
          await maybeDestroy.call(p, existing.id);
        }
      } catch (err) {
        log.warn("AI session cleanup failed", {
          sessionId: existing.id,
          error: (err as Error).message,
        });
      }
    }

    res.json(ok({ session: { ...updated, policy: parsePolicyJson(updated.policy) } }));
  });

  r.get("/sessions/:id/usage", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const session = await loadSession(String(req.params.id), userId);
    const rows = await prisma.aITokenUsage.findMany({
      where: { sessionId: session.id },
      orderBy: { ts: "desc" },
      take: 200,
    });
    const totals = rows.reduce(
      (acc, r) => ({
        promptTokens: acc.promptTokens + r.promptTokens,
        completionTokens: acc.completionTokens + r.completionTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        cacheWriteTokens: acc.cacheWriteTokens + r.cacheWriteTokens,
      }),
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    );
    res.json(ok({ session: { id: session.id }, totals, rows }));
  });

  r.get("/sessions/:id/approvals", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const session = await loadSession(String(req.params.id), userId);
    const tool = typeof req.query.tool === "string" ? req.query.tool : undefined;
    const rows = await prisma.aIToolApproval.findMany({
      where: {
        sessionId: session.id,
        ...(tool ? { toolName: tool } : {}),
      },
      orderBy: { ts: "desc" },
      take: 200,
    });
    res.json(ok({ rows }));
  });

  r.get("/usage/today", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const usage = await getTokenTracker().dailyRollup(userId);
    res.json(ok(usage));
  });

  // Phase 10 \u2014 list and load skills for a session.
  r.get("/sessions/:id/skills", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    try {
      const items = await getSessionRuntime().listLoadedSkills(String(req.params.id), {
        id: userId,
      });
      res.json(ok({ items }));
    } catch (err) {
      if (err instanceof SessionRuntimeError) {
        throw new AppError(err.status, err.code, err.message);
      }
      throw err;
    }
  });

  r.post("/sessions/:id/skills", requireAuth, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const parsed = z
      .object({ skillId: z.string().min(1).optional(), skillKey: z.string().min(1).optional() })
      .refine((v) => Boolean(v.skillId || v.skillKey), {
        message: "skillId or skillKey required",
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid load-skill payload");
    }
    try {
      const result = await getSessionRuntime().loadSkillIntoSession(
        { sessionId: String(req.params.id), ...parsed.data },
        { id: userId },
      );
      res.status(result.alreadyLoaded ? 200 : 201).json(ok(result));
    } catch (err) {
      if (err instanceof SessionRuntimeError) {
        throw new AppError(err.status, err.code, err.message);
      }
      throw err;
    }
  });

  // ── Tool inspection ─────────────────────────────────────────────────────
  r.get("/tools", requireAuth, (_req: Request, res: Response) => {
    res.json(ok({ tools: getToolRegistry().list() }));
  });

  // ── Chat (non-stream) ────────────────────────────────────────────────────
  r.post("/chat", requireAuth, aiRateLimiter, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const parsed = chatBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid chat payload", {
        issues: parsed.error.flatten(),
      });
    }
    const session = await loadSession(parsed.data.sessionId, userId);
    // #713 — decide whether the agentic code-search tools are offered this
    // request (env flag + project-scoped session). Their schemas ride in the
    // byte-stable prompt lead; when disabled the schema block is "" and the
    // prompt + dispatch are byte-identical to today.
    const codeTools = buildChatCodeToolRuntime({
      enabled: getConfigService().getBool("CHAT_CODE_SEARCH_TOOLS", false),
      projectId: session.projectId,
    });
    const messages: ChatMessage[] = [];
    const librarySystem = await buildLibrarySystemMessages(session, codeTools.schemaBlock);
    // #700 — emit the byte-stable lead (persona + skills + tool schemas) first,
    // then the volatile tail (Chronicle), then the per-request user
    // `systemMessage` override, so the cacheable prefix stays byte-identical.
    messages.push(...librarySystem.stable);
    messages.push(...librarySystem.volatile);
    if (parsed.data.systemMessage) {
      messages.push({ role: "system", content: parsed.data.systemMessage });
    }
    messages.push(...parsed.data.messages);

    // Auto-RAG: inject relevant knowledge context for project-scoped sessions.
    // Issue #1321 — the observer needs the retrieved contexts as the model saw
    // them; the builder hands them over directly (no re-parsing of its block).
    const ragCapture: RagContextCapture = { contexts: [] };
    const ragContext = await buildAutoRagContext(
      session.projectId,
      messages,
      undefined,
      ragCapture,
    );
    if (ragContext) {
      messages.splice(messages.length - 1, 0, { role: "system", content: ragContext });
    }

    // Epic #647 / Issue #654 — sliding window for chat history
    const maxTurns = intEnv(process.env.AI_MAX_HISTORY_TURNS, 20, 0);
    const windowedMessages = maxTurns > 0 ? windowHistory(messages, maxTurns) : messages;

    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    res.on("close", () => {
      if (!res.writableEnded) ac.abort();
    });

    try {
      const apiKeyOverride = await resolveProviderKey(session.providerSecretRef);
      const sdkOpts = await buildSdkSkillRuntime(session);

      // Epic #164 — budget gate (fail fast, before paying for tokens).
      if (session.projectId) {
        await assertWithinBudget(session.projectId);
      }
      // Epic #164 — input safety pass on the last user message.
      const lastUser = [...windowedMessages].reverse().find((m) => m.role === "user");
      if (lastUser && session.projectId) {
        const safe = await applySafety(messageText(lastUser), {
          projectId: session.projectId,
          sessionId: session.id,
          provider: session.provider,
          mode: await loadSafetyMode(session.projectId),
          direction: "input",
        });
        if (safe.redacted) lastUser.content = safe.text;
      }

      // Epic #647 / Issue #651 — semantic cache lookup
      const semanticCache = getSemanticCache();
      const providerInstance = provider({ apiKeyOverride });
      let cachedEmbedding: number[] | undefined;
      let cachedSystemHash: string | undefined;
      if (semanticCache.enabled && lastUser) {
        try {
          const embedResult = await providerInstance.embed([messageText(lastUser)]);
          cachedEmbedding = embedResult.vectors[0];
          cachedSystemHash = hashPrompt(
            windowedMessages
              .filter((m) => m.role === "system")
              .map((m) => messageText(m))
              .join("\n"),
          );
          const cacheHit = await semanticCache.lookup(
            cachedEmbedding,
            parsed.data.model ?? session.model,
            cachedSystemHash,
            session.projectId ?? undefined,
          );
          if (cacheHit && !shouldSkipCache(cacheHit.response)) {
            // Issue #1321 — deliberately NOT observed. A cached answer was
            // generated against a different request's retrieval, so scoring it
            // against *this* request's contexts would measure the semantic
            // cache's neighbour radius, not the RAG pipeline, and would quietly
            // bias the trend by the cache hit rate.
            res.json(
              ok({
                response: {
                  content: cacheHit.response,
                  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
                  model: parsed.data.model ?? session.model,
                  provider: loadAIConfig().provider,
                  cached: true,
                },
              }),
            );
            return;
          }
        } catch (err) {
          log.debug("Semantic cache lookup failed, proceeding without cache", {
            error: (err as Error).message,
          });
        }
      }

      const chatProviderOptions: Partial<ChatOptions> = {
        sessionId: session.id,
        model: parsed.data.model ?? session.model,
        signal: ac.signal,
        // #700 — chat cache posture (see CHAT_CACHE_OPTS): tag the workload for
        // telemetry and cache the byte-stable system prefix only.
        ...CHAT_CACHE_OPTS,
        ...(parsed.data.reasoningEffort ? { reasoningEffort: parsed.data.reasoningEffort } : {}),
        ...sdkOpts,
      };

      // #713 — when the code-search tools are offered for this project-scoped
      // session, run a bounded agent loop (shared with analysis) that can call
      // search_code_graph / search_code_symbols scoped to session.projectId,
      // then answer. Otherwise, the single non-loop provider call as before.
      let response: ChatResponse;
      if (codeTools.enabled && session.projectId) {
        const turn = await runChatCodeToolTurn(
          providerInstance,
          {
            messages: windowedMessages,
            tools: codeTools.tools,
            projectId: session.projectId,
          },
          { signal: ac.signal, providerChatOptions: chatProviderOptions },
        );
        response = {
          content: turn.finalResponse,
          usage: turn.usage,
          model: parsed.data.model ?? session.model,
          provider: loadAIConfig().provider,
        };
      } else {
        response = await providerInstance.chat(windowedMessages, chatProviderOptions);
      }

      // Epic #164 — output safety pass + per-project usage telemetry.
      let outContent = response.content;
      if (session.projectId) {
        const safeOut = await applySafety(response.content, {
          projectId: session.projectId,
          sessionId: session.id,
          provider: response.provider,
          mode: await loadSafetyMode(session.projectId),
          direction: "output",
        });
        outContent = safeOut.text;
        recordProjectUsage({
          projectId: session.projectId,
          sessionId: session.id,
          provider: response.provider,
          model: response.model,
          inputTokens: response.usage.promptTokens,
          outputTokens: response.usage.completionTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
        });
      }

      // Epic #647 / Issue #653 — per-request token breakdown
      const systemMsgs = windowedMessages.filter((m) => m.role === "system");
      const historyMsgs = windowedMessages.filter((m) => m.role !== "system");
      const breakdown = estimateBreakdown({
        systemMessages: systemMsgs.filter((m) => !librarySystem.all.includes(m)),
        libraryMessages: librarySystem.all,
        historyMessages: historyMsgs.slice(0, -1),
        userMessage: lastUser ? messageText(lastUser) : "",
      });

      getTokenTracker().record({
        sessionId: session.id,
        userId,
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        prompt: windowedMessages.map((m) => messageText(m)).join("\n"),
        // Issue #428 — stamp the direct projectId so the AITokenUsage row is
        // discoverable by both the direct-column and session-relation filters
        // in UsageService.projectUsage, keeping detail views consistent with
        // the KPI/by-provider aggregates.
        projectId: session.projectId ?? undefined,
        breakdown,
      });

      // Epic #647 / Issue #651 — store in semantic cache on miss
      if (
        semanticCache.enabled &&
        lastUser &&
        cachedEmbedding &&
        cachedSystemHash &&
        !shouldSkipCache(outContent)
      ) {
        try {
          await semanticCache.store(
            cachedEmbedding,
            response.model,
            cachedSystemHash,
            outContent,
            session.projectId ?? undefined,
          );
        } catch (err) {
          log.debug("Semantic cache store failed", { error: (err as Error).message });
        }
      }

      audit({
        actor: { id: userId },
        action: "ai.chat",
        target: { type: "ai_session", id: session.id },
        metadata: {
          provider: response.provider,
          model: response.model,
          promptHash: hashPrompt(windowedMessages.map((m) => messageText(m)).join("\n")),
          tokens: response.usage,
          offline: response.offline ?? false,
        },
      });
      res.json(ok({ response: { ...response, content: outContent } }));

      // Issue #1321 — online eval observer. Deliberately AFTER the response is
      // written and deliberately NOT awaited: `observe` returns void, defers
      // every byte of work to a later event-loop turn and swallows its own
      // failures, so it can neither add latency to this request nor change what
      // the user just received. Default OFF (`ONLINE_EVAL_ENABLED`).
      getOnlineEvalScorer().observe({
        surface: "chat",
        question: lastUser ? messageText(lastUser) : "",
        answer: outContent,
        contexts: ragCapture.contexts,
      });
    } catch (err) {
      if (err instanceof SafetyDeniedError) {
        throw new AppError(err.status, err.code, err.message, { findings: err.findings });
      }
      if (err instanceof BudgetExceededError) {
        throw new AppError(err.status, err.code, err.message, {
          usedTokens: err.usedTokens,
          budget: err.budget,
        });
      }
      throw aiErrorToAppError(err);
    }
  });

  // ── Chat (SSE stream) ────────────────────────────────────────────────────
  r.post("/stream", requireAuth, aiRateLimiter, async (req: Request, res: Response) => {
    const userId = userIdOrThrow(req);
    const parsed = chatBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid chat payload", {
        issues: parsed.error.flatten(),
      });
    }
    const session = await loadSession(parsed.data.sessionId, userId);
    // #713 — decide whether the agentic code-search tools are offered this
    // request (env flag + project-scoped session). Their schemas ride in the
    // byte-stable prompt lead; when disabled the schema block is "" and the
    // prompt + dispatch are byte-identical to today.
    const codeTools = buildChatCodeToolRuntime({
      enabled: getConfigService().getBool("CHAT_CODE_SEARCH_TOOLS", false),
      projectId: session.projectId,
    });
    const messages: ChatMessage[] = [];
    const librarySystem = await buildLibrarySystemMessages(session, codeTools.schemaBlock);
    // #700 — emit the byte-stable lead (persona + skills + tool schemas) first,
    // then the volatile tail (Chronicle), then the per-request user
    // `systemMessage` override, so the cacheable prefix stays byte-identical.
    messages.push(...librarySystem.stable);
    messages.push(...librarySystem.volatile);
    if (parsed.data.systemMessage) {
      messages.push({ role: "system", content: parsed.data.systemMessage });
    }
    messages.push(...parsed.data.messages);

    // Auto-RAG: inject relevant knowledge context for project-scoped sessions.
    // Issue #1321 — see the /chat route: contexts come from the builder.
    const ragCapture: RagContextCapture = { contexts: [] };
    const ragContext = await buildAutoRagContext(
      session.projectId,
      messages,
      undefined,
      ragCapture,
    );
    if (ragContext) {
      messages.splice(messages.length - 1, 0, { role: "system", content: ragContext });
    }

    // Epic #647 / Issue #654 — sliding window for stream history
    const streamMaxTurns = intEnv(process.env.AI_MAX_HISTORY_TURNS, 20, 0);
    const windowedMessages =
      streamMaxTurns > 0 ? windowHistory(messages, streamMaxTurns) : messages;

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const ac = new AbortController();
    let ended = false;
    const safeEnd = (): void => {
      if (ended) return;
      ended = true;
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
    };

    // M1 — Slowloris / hung-upstream protections.
    //
    //   • Socket-level idle timeout. Heartbeats below keep the timer reset
    //     for healthy streams; a truly idle socket gets reaped.
    //   • SSE keep-alive comment ping so proxies/load balancers don't
    //     close the connection on their own idle policy.
    //   • Hard ceiling per stream — no provider call should ever
    //     legitimately exceed this. Sends an `error` SSE frame then ends.
    //
    // All three timers are cleared in the `finally` block below so they
    // never leak past the request lifetime.
    const limits = streamLimits();
    res.setTimeout(limits.socketTimeoutMs, () => {
      ac.abort();
      safeEnd();
    });
    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, limits.heartbeatIntervalMs);
    const hardCeiling = setTimeout(() => {
      // #1366 — this used to write `{ error: "timeout" }`, a shape the client's
      // `parseSseFrame` does not read (it takes `message`/`code`), so even the
      // one timeout the server DID detect surfaced as a blank error.
      log.warn("AI stream exceeded its hard duration ceiling", {
        sessionId: session.id,
        userId,
        hardCeilingMs: limits.hardCeilingMs,
      });
      try {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            code: "STREAM_MAX_DURATION",
            message: `The response was stopped after ${Math.round(limits.hardCeilingMs / 1000)}s. Any partial answer above is incomplete.`,
          })}\n\n`,
        );
      } catch {
        /* nothing left to write */
      }
      ac.abort();
      safeEnd();
    }, limits.hardCeilingMs);
    // Keep timers from blocking process exit during graceful shutdown tests.
    heartbeat.unref?.();
    hardCeiling.unref?.();

    req.on("aborted", () => ac.abort());
    res.on("close", () => ac.abort());

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let aggregateUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

    // Issue #1321 — online eval observer. `/api/ai/stream` is the route the
    // product actually calls (`ui/src/lib/ai-client.ts` `streamChat`, used by
    // the chat and workbench pages), so sampling only `/chat` would sample
    // nothing. The answer is not otherwise materialised here — deltas are
    // written straight to the socket — so it is accumulated ONLY when the
    // sampler is on. `enabled()` is a synchronous config read; with the feature
    // OFF (the default) this path is one boolean and the loop below is
    // byte-identical to before.
    const onlineEval = getOnlineEvalScorer();
    const observeOnline = onlineEval.enabled();
    let observedAnswer = "";
    // #1367 — the answer is also needed unconditionally now, to snapshot the
    // turn. Kept separate from `observedAnswer` so the eval sampler's own
    // enable/disable semantics are unchanged.
    let finalAnswer = "";

    try {
      const apiKeyOverride = await resolveProviderKey(session.providerSecretRef);
      const sdkOpts = await buildSdkSkillRuntime(session);

      const streamProvider = provider({ apiKeyOverride });

      const streamProviderOptions: Partial<ChatOptions> = {
        sessionId: session.id,
        model: parsed.data.model ?? session.model,
        signal: ac.signal,
        // #700 — same cache posture as the non-stream /chat route.
        ...CHAT_CACHE_OPTS,
        ...(parsed.data.reasoningEffort ? { reasoningEffort: parsed.data.reasoningEffort } : {}),
        ...sdkOpts,
      };

      if (codeTools.enabled && session.projectId) {
        // #713 — bounded agent loop (shared with analysis) runs the model turns
        // NON-streaming via provider.chat, so the #718 tool-tag stream parser is
        // never involved and no protocol string leaks as a delta. Each executed
        // tool call surfaces as a structured `tool_call` frame; the final answer
        // is streamed as one delta. Tools are scoped to session.projectId.
        const turn = await runChatCodeToolTurn(
          streamProvider,
          {
            messages: windowedMessages,
            tools: codeTools.tools,
            projectId: session.projectId,
          },
          {
            signal: ac.signal,
            providerChatOptions: streamProviderOptions,
            onToolCall: (c) =>
              send("tool_call", { type: "tool_call", name: c.tool, arguments: c.args }),
          },
        );
        if (turn.finalResponse) send("delta", { type: "delta", content: turn.finalResponse });
        if (observeOnline) observedAnswer = turn.finalResponse;
        finalAnswer = turn.finalResponse;
        aggregateUsage = {
          ...turn.usage,
          cacheReadTokens: turn.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: turn.usage.cacheWriteTokens ?? 0,
        };
        send("usage", { type: "usage", usage: turn.usage });
        send("done", { type: "done" });
      } else {
        // #1366 — the provider iterable is wrapped so a stream that goes silent
        // mid-answer throws instead of hanging. Every chunk already yielded has
        // been written to the socket, so the partial answer survives; the catch
        // below turns the throw into a user-visible `error` frame.
        const guarded = withIdleTimeout(
          streamProvider.stream(windowedMessages, streamProviderOptions),
          limits.idleTimeoutMs,
          () => ac.abort(),
        );
        for await (const chunk of guarded) {
          const c = chunk as ChatChunk;
          if (c.type === "usage")
            aggregateUsage = {
              ...c.usage,
              cacheReadTokens: c.usage.cacheReadTokens ?? 0,
              cacheWriteTokens: c.usage.cacheWriteTokens ?? 0,
            };
          if (observeOnline && c.type === "delta") observedAnswer += c.content;
          if (c.type === "delta") finalAnswer += c.content;
          send(c.type, c);
          if (c.type === "done") break;
        }
      }
      // #1367 — persist the turn so the session is resumable.
      //
      // Which of the issue's two candidate causes was it? Both, in layers, and
      // the distinction matters. The AISession ROW was always written at
      // session-create, so the session record existed and was merely unlisted —
      // but its CONVERSATION was never persisted at all, because nothing in the
      // product ever called `writeSnapshot`. `snapshotUpdatedAt` therefore
      // stayed null forever, and `listResumable` filters on
      // `snapshotUpdatedAt: { gte: cutoff }`, which a null can never satisfy.
      // So the fix is to START WRITING snapshots, not to relax the list query:
      // relaxing it would have listed sessions that had nothing to resume.
      //
      // Snapshotting on every completed turn (rather than every Nth message)
      // means a reload never loses more than the turn in flight. Failures are
      // logged and swallowed: the user already has their answer, and losing
      // resumability must never fail a successful stream.
      try {
        await writeSnapshot(session.id, {
          v: 1,
          messages: [
            ...parsed.data.messages.map((m) => ({
              role: m.role,
              content: messageText(m),
              ...(m.name ? { name: m.name } : {}),
            })),
            { role: "assistant" as const, content: finalAnswer },
          ],
          currentModel: session.currentModel ?? session.model,
          currentReasoningEffort:
            (session.currentReasoningEffort as SdkReasoningEffort | null) ?? null,
          loadedSkillIds: safeJsonArray(session.loadedSkillIds),
          customAgentIds: session.agentId ? [session.agentId] : [],
        });
      } catch (snapshotErr) {
        log.warn("Failed to snapshot AI session after stream turn", {
          sessionId: session.id,
          userId,
          error: snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr),
        });
      }

      getTokenTracker().record({
        sessionId: session.id,
        userId,
        provider: loadAIConfig().provider,
        model: parsed.data.model ?? session.model,
        usage: aggregateUsage,
        prompt: windowedMessages.map((m) => messageText(m)).join("\n"),
        // Issue #428 — stamp the direct projectId (see streaming path above).
        projectId: session.projectId ?? undefined,
      });
      audit({
        actor: { id: userId },
        action: "ai.stream",
        target: { type: "ai_session", id: session.id },
        metadata: {
          tokens: aggregateUsage,
          promptHash: hashPrompt(windowedMessages.map((m) => messageText(m)).join("\n")),
        },
      });

      // Deliberately AFTER every byte is on the wire and deliberately NOT
      // awaited: `observe` returns void, defers all work to a later event-loop
      // turn and swallows its own failures, so it can neither add latency to
      // this stream nor change what the user just received. Only reached on the
      // success path — a stream that errored has no answer worth scoring.
      if (observeOnline && observedAnswer) {
        const lastUserMsg = [...windowedMessages].reverse().find((m) => m.role === "user");
        onlineEval.observe({
          surface: "chat",
          question: lastUserMsg ? messageText(lastUserMsg) : "",
          answer: observedAnswer,
          contexts: ragCapture.contexts,
        });
      }
    } catch (err) {
      if (err instanceof StreamIdleTimeoutError) {
        // #1366 AC — logged with the session id so a stall can be diagnosed
        // afterwards. The silent 13-minute hang left no server-side trace at all.
        log.warn("AI stream stalled with no output; idle timeout fired", {
          sessionId: session.id,
          userId,
          idleMs: err.idleMs,
          model: parsed.data.model ?? session.model,
        });
        send("error", {
          code: STREAM_IDLE_TIMEOUT_CODE,
          message: `The model stopped responding after ${Math.round(err.idleMs / 1000)}s of silence. Any partial answer above is incomplete — try again.`,
        });
      } else {
        send("error", {
          code: err instanceof AIError ? err.code : "AI_PROVIDER_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(hardCeiling);
      safeEnd();
    }
  });

  return r;
}
