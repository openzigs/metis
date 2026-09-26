/**
 * Epic #127 / #139 — resume and fork, built on the server transcript.
 *
 * Resume used to hand back the session `snapshot` — a copy of whatever the
 * client had last sent. It now reads the transcript table and the session row
 * only, so what a resumed chat shows is exactly what the server recorded.
 *
 * Fork starts a new session from an earlier assistant reply. The new session
 * copies the source's transcript up to and including that reply (same
 * ordinals) and its state — model, reasoning effort, agent, loaded skills,
 * plan-mode flag, project scope — so it is authorised exactly as its source is:
 * same owner, same project, same checks.
 */
import type { AISession } from "@prisma/client";
import type {
  AuthPayload,
  ForkSessionResponse,
  ResumeSessionResponse,
  SdkReasoningEffort,
} from "@metis/shared";
import { prisma } from "../../prisma.js";
import { AppError } from "../../../middleware/error-handler.js";
import { audit } from "../../audit/audit-service.js";
import { loadAuthorizedSession } from "./session-access.js";
import {
  copyTranscriptPrefix,
  getMessageByOrdinal,
  listActiveMessages,
  listMessages,
  toDto,
} from "./transcript-store.js";
import { importLegacySnapshot } from "./legacy-snapshot.js";
import { calibrationSamples, loadChatTurnConfig, writeDerivedSnapshot } from "./turn.js";
import type { AIProvider } from "../types.js";
import { effectiveModel } from "../model-switch.js";
import { buildHistory } from "./context-builder.js";
import { estimateMessagesTokens, resolveTokenRatio } from "./token-estimator.js";
import { resolveContextWindow } from "../../analysis/context-watermark.js";
import { compactTranscript, providerSummarizer } from "../../async/compaction.js";
import { assertWithinBudget } from "../../finops/budget-enforcer.js";

/** Hours after its last activity that a session can still be resumed. */
function resumeTtlHours(): number {
  const n = Number(process.env.SESSION_RESUME_TTL_HOURS ?? 24);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function parseSkillIds(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function sessionStateDto(s: AISession): ResumeSessionResponse["session"] {
  return {
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    provider: s.provider,
    model: s.model,
    currentModel: s.currentModel,
    currentReasoningEffort: (s.currentReasoningEffort as SdkReasoningEffort | null) ?? null,
    agentId: s.agentId,
    loadedSkillIds: parseSkillIds(s.loadedSkillIds),
    planModeActive: s.planModeActive,
    status: s.status,
    forkedFromSessionId: s.forkedFromSessionId,
    forkedFromOrdinal: s.forkedFromOrdinal,
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** The full transcript of a session the caller may read. */
export async function readTranscript(user: AuthPayload | undefined, sessionId: string) {
  const session = await loadAuthorizedSession(user, sessionId);
  let rows = await listMessages(session.id);
  if (rows.length === 0 && session.snapshot) {
    if ((await importLegacySnapshot(session.id, session.snapshot)) > 0) {
      rows = await listMessages(session.id);
    }
  }
  return { session, messages: rows.map(toDto) };
}

export async function resumeSession(
  user: AuthPayload | undefined,
  sessionId: string,
): Promise<ResumeSessionResponse> {
  // Expiry first: an expired session is refused before any legacy import
  // writes rows for it (PR #205 review).
  const authorized = await loadAuthorizedSession(user, sessionId);
  const last = authorized.snapshotUpdatedAt ?? authorized.updatedAt;
  if (last.getTime() < Date.now() - resumeTtlHours() * 3600 * 1000) {
    throw new AppError(404, "SESSION_RESUME", "Session has expired and cannot be resumed");
  }
  const { session, messages } = await readTranscript(user, sessionId);
  return { session: sessionStateDto(session), messages };
}

const MAX_TITLE = 200;

export async function forkSession(
  user: AuthPayload | undefined,
  sessionId: string,
  fromOrdinal: number,
): Promise<ForkSessionResponse> {
  const source = await loadAuthorizedSession(user, sessionId);
  const at = await getMessageByOrdinal(source.id, fromOrdinal);
  if (!at || at.kind !== "message" || at.role !== "assistant") {
    throw new AppError(
      400,
      "FORK_POINT_INVALID",
      "A fork must start from an assistant reply in this session's transcript.",
    );
  }
  const title = `${source.title} (fork)`.slice(0, MAX_TITLE);
  const { session, copied } = await prisma.$transaction(async (tx) => {
    const created = await tx.aISession.create({
      data: {
        userId: source.userId,
        projectId: source.projectId,
        title,
        provider: source.provider,
        model: source.model,
        policy: source.policy,
        providerSecretRef: source.providerSecretRef,
        agentId: source.agentId,
        agentSnapshot: source.agentSnapshot,
        loadedSkillIds: source.loadedSkillIds,
        currentModel: source.currentModel,
        currentReasoningEffort: source.currentReasoningEffort,
        planModeActive: source.planModeActive,
        forkedFromSessionId: source.id,
        forkedFromOrdinal: fromOrdinal,
      },
    });
    const n = await copyTranscriptPrefix(source.id, created.id, fromOrdinal, tx);
    return { session: created, copied: n };
  });
  await writeDerivedSnapshot(session);
  const refreshed = (await prisma.aISession.findUnique({ where: { id: session.id } })) ?? session;
  audit({
    actor: { id: source.userId },
    action: "ai.session.fork",
    target: { type: "ai_session", id: session.id },
    metadata: { sourceSessionId: source.id, fromOrdinal, copiedMessages: copied },
  });
  return { session: sessionStateDto(refreshed), copiedMessages: copied };
}

export interface ManualCompactionResult {
  compacted: boolean;
  /** Estimated tokens of the conversation history before and after. */
  before: number;
  after: number;
  /** Transcript rows folded into the summary (kept, marked compacted). */
  summarizedTurns: number;
}

/**
 * #138 — `POST /api/ai/sessions/:id/compact`: fold everything but the newest
 * turn into the summary now, whatever the size. Same machinery as the
 * automatic path; the rows folded are kept and marked, never deleted.
 */
export async function compactSessionOnDemand(
  user: AuthPayload | undefined,
  sessionId: string,
  resolveProvider: (session: AISession) => Promise<AIProvider>,
  signal?: AbortSignal,
): Promise<ManualCompactionResult> {
  const session = await loadAuthorizedSession(user, sessionId);
  // A summary is a paid model call: gate it on the project budget like a chat
  // turn (PR #205 review). Throws BudgetExceededError (402) before any spend.
  if (session.projectId) await assertWithinBudget(session.projectId);
  const provider = await resolveProvider(session);
  const model = effectiveModel(session);
  const config = loadChatTurnConfig();
  const rows = await listActiveMessages(session.id);
  const ratio = resolveTokenRatio({
    provider: provider.key,
    model,
    samples: calibrationSamples(rows, model),
  });
  const build = {
    toolResultMaxChars: Math.floor(config.toolResultMaxTokens * ratio.charsPerToken),
  };
  const before = estimateMessagesTokens(buildHistory(rows), ratio);
  const outcome = await compactTranscript({
    sessionId: session.id,
    activeRows: rows,
    ratio,
    build,
    contextWindow: resolveContextWindow(provider.key, model, {
      fallback: config.contextWindowFallback,
    }),
    fixedTokens: 0,
    estimatedTokensBefore: before,
    summarizer: providerSummarizer(provider, {
      model,
      signal,
      maxTokens: config.summaryMaxTokens,
      meter: { sessionId: session.id, userId: session.userId, projectId: session.projectId },
    }),
    force: true,
    provider: provider.key,
    model,
  });
  if (!outcome) return { compacted: false, before, after: before, summarizedTurns: 0 };
  await writeDerivedSnapshot(session);
  return {
    compacted: true,
    before,
    after: outcome.estimatedTokensAfter,
    summarizedTurns: outcome.compactedMessages,
  };
}
