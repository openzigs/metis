/**
 * #246 — bounded retry of the grounding calls (claim extraction and the
 * faithfulness judge) on TRANSIENT provider failures.
 *
 * A single dropped connection on one judge call used to cost a whole section
 * its fact-check (`anthropic chat failed (TypeError): terminated`). Transient
 * failures — a stream the peer closed mid-reply, a 5xx, a 429, a timeout — are
 * now retried with exponential backoff before the section is given up on.
 * Anything else (a 4xx configuration error, a cancelled run, a first-token
 * timeout) is thrown at once: asking again would fail the same way.
 *
 * This sits ABOVE the providers' own retries (the Anthropic SDK retries some
 * request-level failures; the OpenAI-compatible client retries 429/503 and
 * connection resets before the first byte). Neither covers a reply that dies
 * after it started, which is what the live run hit. The bound is small
 * ({@link DEFAULT_GROUNDING_ATTEMPTS} tries) so the product of the two layers
 * stays bounded too.
 */
import { createChildLogger } from "../../logger.js";

const log = createChildLogger("docs-gen:grounding-retry");

/** Total tries (the first call plus retries) for one grounding call. */
export const DEFAULT_GROUNDING_ATTEMPTS = 3;
/** Backoff before the first retry, doubled for each later one. */
export const DEFAULT_GROUNDING_RETRY_BASE_MS = 500;
/** Upper bound on any one backoff delay. */
export const MAX_GROUNDING_RETRY_DELAY_MS = 8_000;

/** How a failed grounding call is classified. */
export type GroundingErrorClass =
  | "stream-terminated"
  | "timeout"
  | "rate-limited"
  | "server-error"
  | "client-error"
  | "cancelled"
  | "other";

/** Tuning for {@link withTransientRetry}; every field has a default. */
export interface GroundingRetryOptions {
  /** Total tries, clamped to [1, 6]. */
  attempts?: number;
  /** First backoff in ms (doubled per retry, capped at {@link MAX_GROUNDING_RETRY_DELAY_MS}). */
  baseDelayMs?: number;
  /** Injectable sleep (tests). Must reject when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable jitter source in [0, 1) (tests). */
  random?: () => number;
}

const errorText = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error
      ? ` ${cause.name} ${cause.message} ${(cause as { code?: string }).code ?? ""}`
      : "";
  return `${err.name} ${err.message} ${(err as { code?: string }).code ?? ""}${causeText}`;
};

/** A numeric HTTP status carried on the error itself, or stated as "returned NNN". */
function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number" && s >= 100 && s <= 599) return s;
  }
  const m = /\breturned (\d{3})\b/.exec(errorText(err));
  return m ? Number(m[1]) : undefined;
}

const TERMINATED =
  /\bterminated\b|ECONNRESET|socket hang up|other side closed|EPIPE|UND_ERR_SOCKET|premature close|fetch failed|ECONNREFUSED|EAI_AGAIN/i;
const TIMEOUT = /ETIMEDOUT|timed out|\btimeout\b|TimeoutError/i;

/**
 * Classify a thrown grounding-call error. The class names what a reader of the
 * document warning needs — never the raw message, which can hold a provider
 * response body.
 */
export function classifyGroundingError(err: unknown, signal?: AbortSignal): GroundingErrorClass {
  if (signal?.aborted) return "cancelled";
  if (err instanceof Error && (err.name === "AbortError" || err.name === "APIUserAbortError")) {
    return "cancelled";
  }
  // #111 — a first-token timeout is deliberately never re-sent: the identical
  // prompt repeats the whole prefill on a local runtime and times out the same way.
  if (err instanceof Error && err.name === "FirstTokenTimeoutError") return "other";
  const text = errorText(err);
  // A dropped stream is checked before the status: the Anthropic adapter
  // stamps 502 on any error that carried no status of its own.
  if (TERMINATED.test(text)) return "stream-terminated";
  if (TIMEOUT.test(text)) return "timeout";
  const status = statusOf(err);
  if (status === 429) return "rate-limited";
  if (status === 408) return "timeout";
  if (status !== undefined && status >= 500) return "server-error";
  if (status !== undefined && status >= 400) return "client-error";
  return "other";
}

/** True for the classes worth asking again. */
export function isTransientGroundingError(cls: GroundingErrorClass): boolean {
  return (
    cls === "stream-terminated" ||
    cls === "timeout" ||
    cls === "rate-limited" ||
    cls === "server-error"
  );
}

/** Human wording for a class, used in the document warning. */
export function describeGroundingErrorClass(cls: GroundingErrorClass): string {
  switch (cls) {
    case "stream-terminated":
      return "the connection to the model was dropped mid-reply";
    case "timeout":
      return "the model call timed out";
    case "rate-limited":
      return "the provider rate-limited the call (HTTP 429)";
    case "server-error":
      return "the provider returned a server error (HTTP 5xx)";
    case "client-error":
      return "the provider rejected the request (HTTP 4xx — check the grounding model and credentials)";
    case "cancelled":
      return "the run was cancelled";
    default:
      return "the grounding call failed";
  }
}

/** Sleep that rejects as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `call`, retrying it on a transient failure (see
 * {@link isTransientGroundingError}) with exponential backoff and jitter, up to
 * the configured number of tries. A non-transient failure, a cancelled run, or
 * the last try's failure is re-thrown unchanged.
 */
export async function withTransientRetry<T>(
  call: () => Promise<T>,
  context: { stage: "claims" | "verdicts"; signal?: AbortSignal },
  opts: GroundingRetryOptions = {},
): Promise<T> {
  const attempts = Math.min(
    6,
    Math.max(1, Math.floor(opts.attempts ?? DEFAULT_GROUNDING_ATTEMPTS)),
  );
  const base = Math.max(0, opts.baseDelayMs ?? DEFAULT_GROUNDING_RETRY_BASE_MS);
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const cls = classifyGroundingError(err, context.signal);
      if (!isTransientGroundingError(cls) || attempt >= attempts) throw err;
      const window = Math.min(MAX_GROUNDING_RETRY_DELAY_MS, base * 2 ** (attempt - 1));
      // Half fixed, half jitter: never zero, never above the window.
      const delayMs = Math.round(window / 2 + (window / 2) * random());
      log.warn("Transient grounding-call failure; retrying with backoff", {
        stage: context.stage,
        errorClass: cls,
        attempt,
        maxAttempts: attempts,
        delayMs,
      });
      await sleep(delayMs, context.signal);
    }
  }
}
