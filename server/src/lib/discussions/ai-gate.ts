/**
 * Epic #475 (Phase 3, #483) — LLM participation gate.
 *
 * A discussion thread carries a 3-state `aiResponseMode` (the epic's confirmed
 * product decision, mirroring Slack / Teams / ChatGPT group-chat participation
 * modes — see epic Research):
 *
 *   - `off`        — the AI NEVER auto-responds, even when @AI-mentioned.
 *   - `on_mention` — DEFAULT — the AI replies only when explicitly @AI-mentioned.
 *   - `auto`       — proactive — the AI replies whenever a clear question or
 *                    request is detected, AND on an explicit @AI mention.
 *
 * `shouldAIRespond` is the single cost-control gate: a plain human↔human message
 * with no triggering condition returns `false`, so the provider is never called
 * and no `AITokenUsage` is incurred — the structural cost guarantee from #476.
 *
 * SECURITY (Phase 5 #490 does the full OWASP pass, but we avoid an obvious hole
 * now): this gate only DECIDES whether to respond from message TEXT. It never
 * executes anything from message content. The mention heuristics deliberately
 * ignore code spans and URLs so an attacker cannot smuggle a trigger (or hide
 * one) inside fenced/inline code or a link.
 */

export const AI_RESPONSE_MODES = ["off", "on_mention", "auto"] as const;
export type AIResponseMode = (typeof AI_RESPONSE_MODES)[number];

/** The default mode when a thread does not specify one (epic #475 decision). */
export const DEFAULT_AI_RESPONSE_MODE: AIResponseMode = "on_mention";

/** Runtime type-guard for a persisted/incoming `aiResponseMode` string. */
export function isAIResponseMode(value: unknown): value is AIResponseMode {
  return typeof value === "string" && (AI_RESPONSE_MODES as readonly string[]).includes(value);
}

/** Minimal shape of a thread the gate needs. */
export interface GateThread {
  /**
   * The persisted mode. Typed as `string` (not the narrow union) because Prisma
   * stores it as a free-form String column — `shouldAIRespond` fails CLOSED for
   * any value outside the canonical set, so an unexpected/corrupt mode can never
   * trigger a paid LLM call.
   */
  aiResponseMode: string;
}

/** Minimal shape of a message the gate needs. */
export interface GateMessage {
  body: string;
}

/**
 * Strip the parts of the text the mention/question heuristics must NOT inspect:
 *   - fenced code blocks (```...```),
 *   - inline code spans (`...`),
 *   - URLs (http/https/www/bare host paths containing the sigil).
 *
 * Replacing them with spaces (rather than deleting) preserves word boundaries,
 * so a real `@AI` elsewhere in the same message is still detected. This is the
 * documented heuristic that keeps a `@AI` literal inside config/code or a link
 * from triggering an expensive (and potentially attacker-controlled) reply.
 */
function stripCodeAndUrls(text: string): string {
  return (
    text
      // Fenced code blocks first (greedy-safe, non-overlapping).
      .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length))
      // Inline code spans.
      .replace(/`[^`]*`/g, (m) => " ".repeat(m.length))
      // URLs — http(s):// or www. runs up to the next whitespace.
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, (m) => " ".repeat(m.length))
  );
}

/**
 * Detect an explicit `@AI` mention.
 *
 * Robust to surrounding punctuation and case; requires the sigil to sit on a
 * word boundary so `email@AIcorp.com` and `@AImazing` do NOT match. Mentions
 * inside code spans/blocks or URLs are ignored (see {@link stripCodeAndUrls}).
 */
export function detectAIMention(body: string): boolean {
  if (!body) return false;
  const scrubbed = stripCodeAndUrls(body);
  // (^|non-word-non-@) @AI (followed by end / non-word char). The leading guard
  // rejects `foo@AI` (local-part of an email); the trailing guard rejects
  // `@AImazing`. `[^\w@]` also blocks a double sigil like `x@AI` after a word
  // char while still allowing `(@AI` and ` @AI`.
  return /(^|[^\w@])@ai(?![\w])/i.test(scrubbed);
}

const INTERROGATIVE_OPENERS =
  /^(who|what|when|where|why|which|how|whom|whose|is|are|am|do|does|did|can|could|should|would|will|may|might|shall|has|have|had)\b/i;

const ASSISTANT_REQUEST =
  /\b(please|can you|could you|would you|summari[sz]e|draft|list|explain|generate|suggest|recommend|help me|write|propose)\b/i;

/**
 * Detect a "clear question or request" for `auto` mode (documented heuristic).
 *
 * A message qualifies when ANY of:
 *   - it contains a `?` (outside code spans), OR
 *   - a sentence opens with an interrogative word (who/what/how/should/…), OR
 *   - it contains an explicit assistant-directed request verb
 *     (please / can you / summarize / draft / …).
 *
 * Plain declaratives ("I updated the spec", "thanks, looks good") return false,
 * so `auto` does not turn the AI into an always-on participant — matching the
 * research that always-on AI detracts from human collaboration.
 */
export function detectQuestionOrRequest(body: string): boolean {
  if (!body) return false;
  const scrubbed = stripCodeAndUrls(body);
  const trimmed = scrubbed.trim();
  if (!trimmed) return false;

  if (trimmed.includes("?")) return true;

  // Check each sentence-ish fragment for an interrogative opener.
  for (const fragment of trimmed.split(/[.!\n]+/)) {
    const f = fragment.trim();
    if (f && INTERROGATIVE_OPENERS.test(f)) return true;
  }

  return ASSISTANT_REQUEST.test(trimmed);
}

/**
 * The cost-control gate. Returns `true` only when the thread's `aiResponseMode`
 * and the message content jointly call for an AI reply.
 *
 *   - `off`        → always false (even on @AI).
 *   - `on_mention` → true iff @AI-mentioned.
 *   - `auto`       → true on @AI OR a detected question/request.
 *   - unknown mode → false (fail closed — never incur cost on a corrupt value).
 */
export function shouldAIRespond(thread: GateThread, message: GateMessage): boolean {
  switch (thread.aiResponseMode) {
    case "off":
      return false;
    case "on_mention":
      return detectAIMention(message.body);
    case "auto":
      return detectAIMention(message.body) || detectQuestionOrRequest(message.body);
    default:
      // Defensive: a corrupt/unexpected persisted value must never trigger a
      // paid LLM call. Fail closed.
      return false;
  }
}
