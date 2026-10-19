/**
 * #1273 — attempts an adapter retries INSIDE one `chat()` call.
 *
 * The OpenAI-compatible adapter (OpenAI, Azure, the Bedrock gateway, local
 * runtimes) retries a non-streamed reply whose body dropped while it was being
 * read (`terminated`), up to `AI_MAX_RETRIES` times. Each such attempt was
 * generated, and billed, by the provider, yet the caller sees only the last
 * one: `chat()` returns or throws once. So the adapter reports each retried
 * attempt through {@link ChatOptions.onRetriedAttempt}, and whoever meters the
 * call meters it — exactly as #1272 (#1238) meters an attempt the chat turn
 * retried:
 *
 *   - on the usage the provider reported for it (`partialUsageOf`, the #1238
 *     channel — never an early `usage` chunk, which `analysis-usage.ts`,
 *     `impact-llm-runtime.ts` and `otel/genai-spans.ts` would each count); or
 *   - when it reported none, as unmetered: an `ai.usage.unmetered` audit entry.
 *     Nothing is estimated in its place.
 *
 * Exactly once: the listener closest to the adapter claims the attempt
 * ({@link withRetriedAttemptListener} replaces, never chains), and with no
 * listener at all the adapter records it as unmetered itself
 * ({@link reportRetriedAttempt}), so no caller can drop it silently.
 */
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { partialUsageOf } from "./partial-usage.js";
import type { ChatOptions, RetriedAttempt, TokenUsage } from "./types.js";

const log = createChildLogger("ai-retried-attempts");

/**
 * #1238 — the audit action of a model call attempt that was (or may have been)
 * billed and whose usage no provider reported, so it is in no usage store.
 */
export const UNMETERED_ATTEMPT_AUDIT_ACTION = "ai.usage.unmetered";

/**
 * True when `u` holds anything billable. A cache-only report (every token
 * served from the prompt cache, `totalTokens` 0) is still a billed call.
 */
export function hasReportedUsage(u: TokenUsage | undefined): u is TokenUsage {
  return (
    u !== undefined &&
    (u.totalTokens > 0 || (u.cacheReadTokens ?? 0) > 0 || (u.cacheWriteTokens ?? 0) > 0)
  );
}

/** What the provider reported for the failed attempt `err`, when it reported anything billable. */
export function reportedUsageOf(err: unknown): TokenUsage | undefined {
  const u = partialUsageOf(err);
  return hasReportedUsage(u) ? u : undefined;
}

/** Who and what an unmetered attempt is recorded against. */
export interface UnmeteredAttemptScope {
  actorId: string | null;
  target: { type: string; id: string };
  projectId: string | null;
  provider: string;
  model: string;
}

/**
 * Record that a model call attempt the provider may have billed is in no usage
 * store: a warning in the log and an `ai.usage.unmetered` audit entry, which
 * outlives the call whether it then succeeds or fails. Never throws.
 */
export function noteUnmeteredAttempt(
  scope: UnmeteredAttemptScope,
  info: { attempt: number; errorClass: string; retriedBy?: "adapter"; callType?: string },
): void {
  const { actorId, target, projectId, provider, model } = scope;
  const metadata = {
    projectId,
    provider,
    model,
    attempt: info.attempt,
    errorClass: info.errorClass,
    ...(info.retriedBy ? { retriedBy: info.retriedBy } : {}),
    ...(info.callType ? { callType: info.callType } : {}),
  };
  log.warn("A model call attempt dropped with no usage reported; its tokens are not metered", {
    target: `${target.type}:${target.id}`,
    ...metadata,
  });
  try {
    audit({ actor: { id: actorId }, action: UNMETERED_ATTEMPT_AUDIT_ACTION, target, metadata });
  } catch {
    /* audit is best-effort by contract */
  }
}

/**
 * `opts` with `listener` as the one that meters retried attempts. It REPLACES
 * any listener the caller passed: the layer closest to the adapter meters the
 * call's usage, so it alone meters the call's retried attempts — never both.
 */
export function withRetriedAttemptListener(
  opts: ChatOptions | undefined,
  listener: (attempt: RetriedAttempt) => void,
): ChatOptions {
  return { ...opts, onRetriedAttempt: listener };
}

/**
 * Called by an adapter for each attempt it retried inside one `chat()` call
 * that the provider may have billed. Hands it to the caller's listener, or —
 * with none — records it as unmetered against the provider, so it is never
 * silently lost. Never throws.
 */
export function reportRetriedAttempt(opts: ChatOptions | undefined, attempt: RetriedAttempt): void {
  const listener = opts?.onRetriedAttempt;
  if (listener) {
    try {
      listener(attempt);
    } catch (err) {
      log.warn("A retried-attempt listener threw; the attempt may be unmetered", {
        provider: attempt.provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  noteUnmeteredAttempt(
    {
      actorId: null,
      target: { type: "ai_provider", id: attempt.provider },
      projectId: null,
      provider: attempt.provider,
      model: attempt.model,
    },
    {
      attempt: attempt.attempt,
      errorClass: attempt.errorClass,
      retriedBy: "adapter",
      ...(opts?.callType ? { callType: opts.callType } : {}),
    },
  );
}
