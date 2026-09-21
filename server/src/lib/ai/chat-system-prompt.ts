/**
 * Chat system-prompt assembly with cache-stable ordering (#700, epic #696).
 *
 * The interactive chat/stream routes (`server/src/routes/ai.ts`) prepend a set
 * of system messages to every call: the session's agent persona, its loaded
 * skills, the per-project Chronicle memory block, and an optional user-supplied
 * `systemMessage` override. Historically these were emitted with the VOLATILE
 * Chronicle block FIRST — so the leading bytes of the system array changed
 * whenever a memory entry was added, which defeats prefix-based prompt caching
 * (both the gateway's transparent caching and the provider-honoured
 * `promptCaching.system` directive rely on a byte-stable leading prefix; see the
 * data-boundary discipline in `analysis/agent-loop.ts`).
 *
 * This module separates the assembly into a **byte-stable lead block** (agent
 * persona + loaded skills — constant for the life of a session) and a
 * **volatile tail** (Chronicle memory + the per-request user `systemMessage`),
 * so the stable block can sit ahead of the gateway cachePoint unchanged across
 * turns. It is a pure, side-effect-free function so prompt-assembly tests can
 * assert byte-stability without standing up a provider or hitting the DB.
 *
 * Prompt SEMANTICS are unchanged: every message that reached the model before
 * still reaches it, carrying the same content — only the ordering of the system
 * messages is adjusted so the stable ones lead.
 */
import type { ChatMessage } from "./types.js";

/**
 * #715 (epic #712) — the static source-citation policy. This is fixed prompt
 * text (never per-request data), so it rides in the BYTE-STABLE lead alongside
 * the #713 tool schemas — changing the cached prefix once per deploy, never per
 * request. The per-request rendered locators (actual `filePath:startLine-endLine`
 * values) live in the volatile retrieved-knowledge / fused-code block, NOT here.
 *
 * It teaches the model to (a) cite the concrete `filePath:startLine-endLine`
 * locator carried by a retrieved code symbol or a code-search tool result, and
 * (b) degrade gracefully when no such locator exists — answer from the
 * document-level RAG without FABRICATING a file path or line numbers, and
 * without falling back to a vague "reconstructed from the knowledge base"
 * disclaimer.
 */
export const CITATION_INSTRUCTION = [
  "## Source citation policy",
  "When you ground an answer in a retrieved code symbol that carries a",
  "`filePath:startLine-endLine` locator — whether from the retrieved-knowledge /",
  "retrieved-code block or from a code-search tool result — cite that exact",
  "locator inline, e.g. `server/src/lib/foo.ts:12-40`, so the reader can open the",
  "real source. Do NOT emit vague disclaimers such as",
  '"reconstructed from the knowledge base".',
  "When no code-symbol locator is available for what you are answering, rely on",
  "the document-level retrieved context and do NOT fabricate a filePath or line",
  "numbers: cite the document excerpt by its filename, or state plainly that the",
  "exact source location is unavailable.",
].join("\n");

/** Raw pieces gathered by the route before ordering. */
export interface ChatSystemParts {
  /**
   * Stable — the agent persona system message bound to the session. Resolved
   * from the session's `agentId`; constant for the session's lifetime.
   */
  persona?: string | null;
  /**
   * Stable — rendered skill instruction blocks, in the session's load order.
   * The set of loaded skills is fixed for a session unless explicitly changed.
   */
  skillBlocks?: readonly string[];
  /**
   * Stable — the deterministically-ordered code-search tool schemas (#713),
   * rendered by `formatToolSchemas` (sorted by tool name). Static for a given
   * flag state + tool set, so it rides in the byte-stable lead AFTER the skill
   * blocks (opposite of #714's per-request fused code context, which is
   * volatile). Empty/absent when the code-tools flag is off ⇒ the lead is
   * byte-identical to before this feature.
   */
  toolSchemas?: string | null;
  /**
   * Stable — the #715 static source-citation policy ({@link CITATION_INSTRUCTION}).
   * Fixed prompt text, so it rides in the byte-stable lead AFTER the tool schemas
   * (same discipline as #713). Empty/absent ⇒ the lead is byte-identical to
   * before this feature. The actual per-request locator VALUES are rendered into
   * the volatile retrieved-knowledge block, never here.
   */
  citationInstruction?: string | null;
  /**
   * Volatile — the per-project Chronicle memory block. Grows as memory entries
   * are added, so it must NOT sit ahead of the cachePoint.
   */
  chronicle?: string | null;
  /**
   * Volatile — the user-supplied per-request `systemMessage` override. Unique
   * per request; kept in the volatile tail.
   */
  userSystemMessage?: string | null;
}

/** Ordered result: a byte-stable lead and a volatile tail. */
export interface AssembledChatSystem {
  /** Byte-stable lead — safe to precede the gateway cachePoint. */
  stable: ChatMessage[];
  /** Volatile tail — per-request/-project content, kept AFTER the stable lead. */
  volatile: ChatMessage[];
  /** Convenience: `stable` followed by `volatile`, in wire order. */
  all: ChatMessage[];
}

function sys(content: string): ChatMessage {
  return { role: "system", content };
}

/**
 * Assemble the chat system messages into a stable lead + volatile tail.
 *
 * Ordering (wire order): `persona`, then each non-empty `skillBlock`, then the
 * `toolSchemas` block, then the `citationInstruction` (all stable), then
 * `chronicle`, then `userSystemMessage` (volatile). Empty/whitespace-only pieces
 * are dropped, exactly as the previous inline assembly did.
 *
 * Pure and deterministic: identical `parts` always yield identical output, and
 * the `stable` array is independent of the volatile fields — so changing the
 * Chronicle or the user override never perturbs the cacheable lead.
 */
export function assembleChatSystem(parts: ChatSystemParts): AssembledChatSystem {
  const stable: ChatMessage[] = [];
  if (parts.persona && parts.persona.trim().length > 0) {
    stable.push(sys(parts.persona));
  }
  for (const block of parts.skillBlocks ?? []) {
    if (block && block.trim().length > 0) stable.push(sys(block));
  }
  // #713 — tool schemas are static for the flag/tool set, so they belong in the
  // byte-stable lead, after the skill blocks and before the volatile boundary.
  if (parts.toolSchemas && parts.toolSchemas.trim().length > 0) {
    stable.push(sys(parts.toolSchemas));
  }
  // #715 — the static source-citation policy is fixed prompt text, so it rides in
  // the byte-stable lead after the tool schemas (never in the volatile tail). The
  // per-request rendered locator VALUES stay in the volatile retrieved-knowledge
  // block; only this static instruction leads.
  if (parts.citationInstruction && parts.citationInstruction.trim().length > 0) {
    stable.push(sys(parts.citationInstruction));
  }

  const volatile: ChatMessage[] = [];
  if (parts.chronicle && parts.chronicle.trim().length > 0) {
    volatile.push(sys(parts.chronicle));
  }
  if (parts.userSystemMessage && parts.userSystemMessage.trim().length > 0) {
    volatile.push(sys(parts.userSystemMessage));
  }

  return { stable, volatile, all: [...stable, ...volatile] };
}

/**
 * Serialize the byte-stable lead block to a single string — the exact prefix a
 * prefix-matching cache keys on. Tests assert this is identical across two
 * consecutive requests in one session (the #700 byte-stability AC), and that it
 * is invariant to volatile-tail changes.
 */
export function stableLeadText(assembled: AssembledChatSystem): string {
  return assembled.stable.map((m) => m.content).join("\n");
}
