/**
 * Direct HTTP provider for OpenAI-compatible `/v1/chat/completions` servers.
 *
 * Originally written for the internal Bedrock Access Gateway, this client is
 * now shared by any OpenAI-compatible backend (currently `bedrock-gateway`
 * and the local Gemma runtime `local-gemma` served by Ollama). It bypasses
 * the Copilot SDK session abstraction and calls the backend's
 * OpenAI-compatible `/chat/completions` endpoint directly. This is used for
 * structured-output workloads (analysis pipeline, doc generation) where we
 * need:
 *   1. Raw JSON / structured text back from the model. The SDK's agentic
 *      session wrapping causes models to respond conversationally instead
 *      of emitting structured output.
 *   2. Bedrock prompt caching via `extra_body.prompt_caching` — the SDK
 *      has no hook to forward provider-specific request fields.
 *   3. Per-call `max_tokens` overrides for long synthesis output.
 *   4. Visibility into `usage.prompt_tokens_details.cached_tokens` so we
 *      can measure cache hit ratios and report cost savings.
 *
 * Streaming is supported via SSE and is required for long-form Phase 2
 * synthesis calls (>2K-token output) so we don't sit on a single HTTP
 * request for 60-90s without progress.
 *
 * The class is exported as both `OpenAICompatibleProvider` (canonical) and
 * `BedrockDirectProvider` (back-compat alias) so existing Bedrock imports in
 * `server.ts`, `analysis.ts`, and tests compile byte-for-byte unchanged.
 *
 * NOTE: `embed()` is intentionally unimplemented — embeddings stay on the
 * dedicated embeddings backend. The local-gemma chat path never calls it.
 */
import { Agent, type Dispatcher } from "undici";
import { createChildLogger } from "../../logger.js";
import { recordCacheHit } from "../cache-hit-telemetry.js";
import { ToolTagStreamParser } from "./tool-tag-parser.js";
import {
  localConcurrencyLimiter,
  type FifoSemaphore,
  type ReleaseSlot,
} from "./local-concurrency-limiter.js";
import { messageText } from "../types.js";
import { createUnsupportedToolsWarner, type ProviderCapabilities } from "../capabilities.js";
import { catalogCapabilities } from "../model-catalog.js";
import type {
  AIProvider,
  ChatChunk,
  ChatContentPart,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  ChatToolCall,
  EmbedResult,
  ProviderKey,
  TokenUsage,
} from "../types.js";

const log = createChildLogger("ai-openai-compatible");

/**
 * Safety margin (ms) added to the app-level first-byte/request budgets when we
 * size undici's `headersTimeout`. The app's own AbortController timers
 * (`firstByteTimeoutMs` / `idleTimeoutMs` / `requestTimeoutMs`) are the intended
 * governors of a slow local model; this margin guarantees undici's transport
 * timeout always fires STRICTLY AFTER them, so the app timer wins and produces a
 * precise, actionable error instead of an opaque undici `TypeError: fetch failed`.
 */
const UNDICI_HEADERS_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Pure resolver for the undici dispatcher transport timeouts, exported for unit
 * testing the sizing rules without constructing an `Agent` or poking undici
 * internals.
 *
 * @param firstByteTimeoutMs app-level streaming TTFT budget (0 = disabled)
 * @param requestTimeoutMs   app-level non-streaming total-request budget (0 = disabled)
 * @returns undici `Agent` options: `headersTimeout` outlasts whichever first-byte
 *   guard is larger (or 0 if either is disabled, so "no app limit" never becomes
 *   undici's silent 300s); `bodyTimeout` is always 0 (disabled) so a slow-but-
 *   alive SSE stream is governed only by the app-level `idleTimeoutMs`.
 */
export function resolveUndiciTimeouts(
  firstByteTimeoutMs: number,
  requestTimeoutMs: number,
): { headersTimeout: number; bodyTimeout: number } {
  const anyGuardDisabled = firstByteTimeoutMs <= 0 || requestTimeoutMs <= 0;
  const firstByteBudget = Math.max(firstByteTimeoutMs, requestTimeoutMs);
  return {
    headersTimeout: anyGuardDisabled ? 0 : firstByteBudget + UNDICI_HEADERS_TIMEOUT_MARGIN_MS,
    bodyTimeout: 0,
  };
}

/**
 * True when `modelId` is an AWS Bedrock CROSS-REGION system inference profile
 * ID — i.e. the `us.anthropic.*` (multi-US-region) or `global.*` (worldwide)
 * forms. These are the IDs whose spend should be re-attributed onto an
 * application-inference-profile ARN; an unmapped one reaching the gateway is
 * the cost-attribution bypass we warn about.
 *
 * NOTE: cross-region routing itself is INTENTIONAL and allowed by the gateway
 * IAM — this predicate does NOT gate or reject the request, it only classifies
 * the ID for an observability log. Bare/native IDs (e.g. `claude-sonnet-4-6`)
 * and profile ARNs (`arn:aws:bedrock:...`) return `false`.
 *
 * Exported for direct unit testing of the classification rule.
 */
export function isCrossRegionModelId(modelId: string): boolean {
  return modelId.startsWith("us.") || modelId.startsWith("global.");
}

/**
 * Default number of TOTAL tries (the initial attempt plus retries) for a
 * transient Bedrock failure. Bedrock throttles (429 `ThrottlingException`,
 * 503) when account RPM/TPM quotas are hit; a small bounded retry with backoff
 * rides over a transient spike without amplifying load. Overridable per-instance
 * via the constructor option `maxAttempts`, or process-wide via `AI_MAX_RETRIES`
 * (read in the constructor, consistent with the existing `AI_*` env knobs).
 */
const DEFAULT_MAX_ATTEMPTS = 4;

/**
 * Default base delay (ms) for the exponential backoff. Attempt N (1-based) waits
 * a random value in `[0, base * 2^(N-1)]` (full jitter, AWS-recommended), capped
 * by {@link MAX_BACKOFF_DELAY_MS} and floored by any `Retry-After` header.
 * Overridable per-instance via `retryBaseDelayMs`, or via `AI_RETRY_BASE_DELAY_MS`.
 */
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** Hard ceiling on a single backoff sleep so an exponential never runs away. */
const MAX_BACKOFF_DELAY_MS = 20_000;

/** Lower/upper bounds for the configurable attempt cap (defends against absurd env). */
const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 6;

/** HTTP statuses we treat as transient and worth a bounded retry. */
const RETRYABLE_STATUSES = new Set([429, 503]);

/**
 * Client-error statuses (#336) that a runtime returns when it does NOT
 * understand the `response_format` structured-output field — e.g. an Ollama /
 * LM Studio build without schema-guided decoding, or a vLLM older than 0.8.5.
 * A 400 (bad request) or 422 (unprocessable) on a request that carried
 * `response_format` triggers ONE graceful retry with the field stripped, so the
 * caller's existing free-form parse/repair path still runs instead of the whole
 * call hard-failing. Other 4xx (401/403 auth, 404 model) are NOT re-attempted —
 * they are not a structured-output capability signal.
 */
const STRUCTURED_OUTPUT_UNSUPPORTED_STATUSES = new Set([400, 422]);

/**
 * True when `status` is a client error that plausibly means the runtime
 * rejected the `response_format` structured-output field (#336). Used to gate
 * the single graceful fallback retry. Exported for direct unit testing.
 */
export function isStructuredOutputUnsupportedStatus(status: number): boolean {
  return STRUCTURED_OUTPUT_UNSUPPORTED_STATUSES.has(status);
}

/**
 * #176 — True when a 501 says the runtime cannot do structured output at all.
 * Ollama's MLX engine answers `501 structured output is unavailable` for
 * `json_schema`, `json_object` and native `format` (measured on Ollama 0.34.2
 * with an MLX-served model). Matched on the BODY, not the status alone: a 501
 * about anything else is a real error and must surface. Unlike the status-only
 * 400/422 signal this is an unambiguous answer about the model, so it is also
 * remembered per model (see `structuredOutputUnavailableModels`). Exported for
 * direct unit testing.
 */
export function isStructuredOutputUnavailableBody(status: number, bodyText: string): boolean {
  if (status !== 501) return false;
  return STRUCTURED_OUTPUT_UNAVAILABLE_PHRASE.test(bodyText);
}

/**
 * The multi-word phrases a runtime uses to say it cannot do structured output.
 * Matched as PHRASES (whitespace between the words) rather than two independent
 * keywords: an Ollama model tag cannot contain whitespace, so an error that only
 * QUOTES a model such as `llama-structured-output:8b` next to "is unavailable"
 * can never match (PR #187 review).
 */
const STRUCTURED_OUTPUT_UNAVAILABLE_PHRASE =
  /\bstructured\s+outputs?\s+(?:is|are)\s+(?:unavailable|unsupported|not\s+(?:supported|available|implemented))\b|\bdoes\s+not\s+support\s+structured\s+outputs?\b/i;

/**
 * True when a non-2xx on a request carrying `response_format` means the runtime
 * cannot schema-constrain: a 400/422 (#336, status alone) or a structured-output
 * 501 (#176, body-matched).
 */
function isStructuredOutputRejection(status: number, bodyText: string): boolean {
  return (
    isStructuredOutputUnsupportedStatus(status) ||
    isStructuredOutputUnavailableBody(status, bodyText)
  );
}

/**
 * True for HTTP statuses that Bedrock/the gateway returns on a transient
 * throttle or capacity event (429 `ThrottlingException`, 503). 4xx other than
 * 429 (e.g. 400/401/403) are caller/auth errors and must NOT be retried —
 * retrying them only amplifies load with no chance of success.
 *
 * Exported for direct unit testing of the classification rule.
 */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/**
 * True when a thrown fetch/undici error is a transient connection-reset-class
 * network failure worth retrying (`ECONNRESET`, `ECONNREFUSED`, `EPIPE`,
 * `ETIMEDOUT`, `EAI_AGAIN`, or undici's generic socket `UND_ERR_SOCKET` /
 * "other side closed"). An `AbortError` (our own timeout/cancel) is deliberately
 * NOT retryable — the caller asked to stop, or a deadline already elapsed.
 *
 * Exported for direct unit testing of the classification rule.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  // undici nests the OS error under `.cause`; check both levels.
  const codes: Array<string | undefined> = [
    (err as { code?: string }).code,
    (err as { cause?: { code?: string } }).cause?.code,
  ];
  const RETRYABLE_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
  ]);
  if (codes.some((c) => c != null && RETRYABLE_CODES.has(c))) return true;
  // undici surfaces a reset as a message rather than a code in some versions.
  return /ECONNRESET|other side closed|socket hang up|terminated/i.test(err.message);
}

/**
 * Parse a `Retry-After` header into milliseconds. Per RFC 7231 the value is
 * either a non-negative integer number of seconds or an HTTP-date. Returns
 * `undefined` for a missing/blank/unparseable/negative value so the caller falls
 * back to pure backoff. The result is clamped to {@link MAX_BACKOFF_DELAY_MS} so
 * a hostile/oversized header can never make us sleep unbounded.
 *
 * Exported for direct unit testing.
 */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (header == null) return undefined;
  const raw = header.trim();
  if (raw.length === 0) return undefined;
  // delta-seconds form.
  if (/^\d+$/.test(raw)) {
    const secs = Number.parseInt(raw, 10);
    if (!Number.isFinite(secs) || secs < 0) return undefined;
    return Math.min(secs * 1000, MAX_BACKOFF_DELAY_MS);
  }
  // HTTP-date form.
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return undefined;
  const delta = when - Date.now();
  if (delta <= 0) return 0;
  return Math.min(delta, MAX_BACKOFF_DELAY_MS);
}

/**
 * Compute the delay (ms) to wait BEFORE the given 1-based attempt using
 * exponential backoff with FULL JITTER (AWS-recommended): a uniform random draw
 * from `[0, min(base * 2^(attempt-1), cap)]`. When a `Retry-After` value is
 * present it is used as the delay FLOOR for that attempt (we wait at least that
 * long), still clamped to the cap. `random` is injectable for deterministic tests.
 *
 * Exported for direct unit testing of the backoff/jitter math.
 *
 * @param attempt 1-based attempt index of the upcoming try (the FIRST retry is 1).
 * @param baseMs base delay; the exponential window is `base * 2^(attempt-1)`.
 * @param retryAfterMs optional `Retry-After` floor for this attempt.
 * @param random injectable `[0,1)` source (defaults to `Math.random`).
 */
export function computeBackoffDelay(
  attempt: number,
  baseMs: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  const window = Math.min(exp, MAX_BACKOFF_DELAY_MS);
  const jittered = Math.floor(random() * window);
  const floor = retryAfterMs != null ? Math.min(retryAfterMs, MAX_BACKOFF_DELAY_MS) : 0;
  return Math.max(jittered, floor);
}

/**
 * Parse an `AI_*` integer env knob into a clamped value, consistent with the
 * `intOr` helper in `config.ts`: blank/non-numeric/below-min falls back to the
 * provided default. Used for `AI_MAX_RETRIES` / `AI_RETRY_BASE_DELAY_MS`.
 */
function envIntOr(raw: string | undefined, fallback: number, min = 0): number {
  if (raw == null || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Default time-to-first-token budget (ms) for `stream()`. */
const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 600_000;
/** Default between-chunk stall budget (ms) once `stream()` has started emitting. */
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
/** Default total-request budget (ms) for non-streaming `chat()`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/**
 * #111 — env knobs for the `local-gemma` provider's app-level timeouts. A local
 * runtime's time-to-first-token is dominated by prompt processing (measured
 * ~224 tok/s prefill for a 117B MoE, so a 130K-token prompt needs ~9.7 min), so
 * the budgets must be operator-tunable per model and hardware. Read in the
 * provider constructor — like `AI_MAX_RETRIES` — so every construction site
 * (the factory, docs-gen's single-provider and hybrid bundles, the analysis
 * interception) honours them without threading a value through each. Scoped to
 * `local-gemma`: a gateway provider keeps its defaults. `0` disables a guard,
 * matching the constructor options; an explicit constructor option wins.
 */
export const LOCAL_TIMEOUT_ENV = {
  firstByte: "LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS",
  idle: "LOCAL_GEMMA_IDLE_TIMEOUT_MS",
  request: "LOCAL_GEMMA_REQUEST_TIMEOUT_MS",
} as const;

/** Node clamps any timer longer than 2^31-1 ms to 1 ms (TimeoutOverflowWarning). */
const MAX_NODE_TIMER_MS = 2_147_483_647;

/**
 * Largest accepted `LOCAL_GEMMA_*_TIMEOUT_MS` value. undici's `headersTimeout`
 * is sized to the budget PLUS {@link UNDICI_HEADERS_TIMEOUT_MARGIN_MS}, so the
 * budget itself must leave room for the margin under the Node timer ceiling —
 * otherwise undici's own timer overflows to 1 ms. ~24.8 days; `0` means "never".
 */
export const MAX_LOCAL_TIMEOUT_MS = MAX_NODE_TIMER_MS - UNDICI_HEADERS_TIMEOUT_MARGIN_MS;

/**
 * Parse a `LOCAL_GEMMA_*_TIMEOUT_MS` knob STRICTLY: plain decimal digits only, at
 * most {@link MAX_LOCAL_TIMEOUT_MS}. `parseInt` read `1_200_000` and `1.2e6` as
 * `1`, and an over-limit value becomes a 1 ms Node timer — either way a setting
 * meant to RAISE the budget failed every stream at once. Unset/blank keeps the
 * default silently; anything else invalid keeps the default and warns.
 */
function envTimeoutMsOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return fallback;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    if (n <= MAX_LOCAL_TIMEOUT_MS) return n;
  }
  log.warn("Ignoring invalid local timeout; keeping the default", {
    env: name,
    value: raw.slice(0, 40),
    defaultMs: fallback,
    maxMs: MAX_LOCAL_TIMEOUT_MS,
  });
  return fallback;
}

/**
 * #111 — `stream()` received no first token within `firstByteTimeoutMs`. A typed
 * error so it is recognisably NOT a transient network failure: `withRetry` never
 * retries it, because re-sending the identical prompt to a local runtime repeats
 * the whole prefill (Ollama discards the aborted request's KV cache and logs
 * "forcing full prompt re-processing"), doubling wall time for the same outcome.
 */
export class FirstTokenTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly promptChars: number,
    readonly messageCount: number,
    message: string,
  ) {
    super(message);
    this.name = "FirstTokenTimeoutError";
  }
}

/**
 * Total characters of prompt text across `messages` (text parts only). Characters,
 * not tokens: no token count is observable before the first token — the runtime
 * reports `usage` only at stream end — and the chars-per-token ratio varies ~2.5x
 * between prose and dense code facts, so an estimate would mislead the operator
 * this number is meant to inform.
 */
function promptChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageText(m).length, 0);
}

/**
 * Internal marker thrown by a connection attempt when the gateway returns a
 * RETRYABLE HTTP status (429/503). It carries the status and an optional
 * `Retry-After` (already parsed to ms) so the retry loop can honor the header as
 * a delay floor. A non-retryable HTTP error (4xx other than 429) is thrown as a
 * plain `Error` instead, so it propagates without consuming a retry.
 */
class RetryableHttpError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    readonly retryAfterMs: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RetryableHttpError";
  }
}

/**
 * Internal marker thrown when the runtime returns a client error (#336) on a
 * request that carried the `response_format` structured-output field — i.e. it
 * likely does not support schema-guided decoding. Carries the status so the
 * caller can emit one diagnostic and perform the SINGLE graceful fallback retry
 * without the field. Distinct from {@link RetryableHttpError} (transient 429/503)
 * so it never routes through the transient-backoff loop.
 */
class StructuredOutputRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    message: string,
  ) {
    super(message);
    this.name = "StructuredOutputRejectedError";
  }
}

/**
 * True when a client-error response body indicates the model/gateway rejects
 * an explicit `temperature` field — e.g. Bedrock's Converse `ValidationException`
 * "`temperature` is deprecated for this model" (newer Claude generations that
 * pin sampling internally). Matched on body text rather than status alone
 * because 400 is also used for unrelated validation errors that must NOT be
 * retried. Exported for direct unit testing.
 */
export function isTemperatureUnsupportedBody(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  // The FIELD, optionally quoted (backtick, or a JSON-escaped quote), followed
  // by "is deprecated". Two independent keywords also matched a quoted model
  // name such as "temperature-deprecated-test:7b" (PR #187 review).
  return /\btemperature\\?["'`]?\s+is\s+deprecated\b/i.test(bodyText);
}

/**
 * Extract the error message from a parsed SSE `data:` frame, or `null` when the
 * frame is a normal completion chunk.
 *
 * WHY THIS EXISTS: `bedrock-access-gateway` does NOT fail the HTTP request when
 * the upstream Bedrock `ConverseStream` call is rejected. It answers
 * `200 text/event-stream` and writes the rejection into the body as a single
 * frame:
 *
 *     data: {"error":{"message":"400: An error occurred (ValidationException) ..."}}
 *
 * The read loop only ever looked at `choices[0].delta.content`, so such a frame
 * was skipped and the stream ended normally with ZERO tokens and NO error. Every
 * caller then treated the empty string as a successful answer. In doc-gen that
 * produced a business-requirements document containing only its title and
 * footer, persisted as a clean `ready` with zero warnings.
 */
export function extractSseErrorMessage(parsed: OpenAIChatResponse): string | null {
  const err = parsed.error;
  if (!err) return null;
  return err.message?.trim() || `${err.code ?? err.type ?? "unknown"} stream error`;
}

/**
 * Recover the upstream HTTP status that a streamed error message describes.
 * The gateway prefixes the original status onto the text it forwards
 * (`"400: An error occurred (ValidationException) ..."`), which is the only
 * place that status survives — the SSE response itself is always `200`.
 * Returns `0` when no status is embedded, so status-gated classifiers such as
 * {@link isTemperatureUnsupportedBody} simply decline to match.
 */
export function embeddedStatusFromStreamError(message: string): number {
  const m = /^\s*(\d{3})\s*:/.exec(message);
  return m ? Number(m[1]) : 0;
}

/**
 * Internal marker thrown when the runtime rejects the `temperature` field
 * (see {@link isTemperatureUnsupportedBody}). Carries the status/body so the
 * caller can emit one diagnostic and perform the SINGLE graceful fallback
 * retry without the field, letting the model use its own pinned default.
 */
class TemperatureUnsupportedError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    message: string,
  ) {
    super(message);
    this.name = "TemperatureUnsupportedError";
  }
}

/**
 * Env knob controlling whether the `local-gemma` provider sends the
 * OpenAI-compatible `reasoning_effort` field (see
 * {@link OpenAICompatibleProviderOptions.disableThinking}):
 *
 *   • `auto` (default, also blank/unrecognised) — send it; if the model rejects
 *     it (HTTP 400/422 naming reasoning/thinking), retry ONCE without it and
 *     remember that model for the life of the provider.
 *   • `always` — send it and never fall back (a rejection surfaces as an error).
 *   • `never`  — never send `reasoning_effort` (the pre-change behaviour:
 *     `think: false` only, and explicit efforts dropped).
 */
export const LOCAL_REASONING_EFFORT_ENV = "LOCAL_GEMMA_SEND_REASONING_EFFORT";

/** Resolved value of {@link LOCAL_REASONING_EFFORT_ENV}. */
export type LocalReasoningEffortMode = "auto" | "always" | "never";

/** Parse {@link LOCAL_REASONING_EFFORT_ENV}; unrecognised → `auto` with a warning. */
export function resolveLocalReasoningEffortMode(
  raw: string | undefined = process.env[LOCAL_REASONING_EFFORT_ENV],
): LocalReasoningEffortMode {
  if (raw == null || raw.trim().length === 0) return "auto";
  const v = raw.trim().toLowerCase();
  if (v === "auto" || v === "always" || v === "never") return v;
  log.warn("Ignoring invalid reasoning_effort mode; using auto", {
    env: LOCAL_REASONING_EFFORT_ENV,
    value: raw.slice(0, 40),
  });
  return "auto";
}

/**
 * True when a client-error body says the runtime rejected `reasoning_effort` —
 * Ollama 0.34.2 answers `400 "<model>" does not support thinking` for an effort
 * other than `none` on a non-thinking model (measured on gemma3:12b), and
 * `400 invalid reasoning value: ...` for a value it does not know. Exported for
 * direct unit testing.
 */
export function isReasoningEffortUnsupportedBody(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return REASONING_EFFORT_REJECTION.test(bodyText);
}

/**
 * The real rejection shapes only (PR #187 review M2): Ollama's `"<model>" does
 * not support thinking` and `invalid reasoning value|effort ...`, or a message
 * naming the `reasoning_effort` FIELD itself. A bare /reasoning|think/ also
 * matched model names Ollama echoes into unrelated errors
 * (`"phi4-reasoning:14b" does not support tools`,
 * `model "qwen3:4b-thinking-2507" not found`), and the model was then remembered
 * as rejecting the field for good. The field name must stand alone — not be
 * part of a longer tag like `deepseek-reasoning_effort:7b`.
 */
const REASONING_EFFORT_REJECTION =
  /\bdoes\s+not\s+support\s+thinking\b|\binvalid\s+reasoning\s+(?:value|effort)\b|(?:^|[\s`'"(\[])reasoning_effort(?=$|[\s`'")\],.])/i;

/**
 * Internal marker thrown when the runtime rejects the `reasoning_effort` field
 * (see {@link isReasoningEffortUnsupportedBody}), so `chat()`/`stream()` can
 * retry once without it.
 */
class ReasoningEffortRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    message: string,
  ) {
    super(message);
    this.name = "ReasoningEffortRejectedError";
  }
}

/**
 * #132 — true when a client-error body says the model cannot take `tools`.
 * Ollama answers `400 registry.ollama.ai/library/gemma3:12b does not support
 * tools` (and `"<model>" does not support tools`). Matched as the PHRASE, so a
 * model name that merely contains "tools" (`toolsmith:7b`) cannot match, and a
 * 400 about anything else is left alone. Exported for direct unit testing.
 */
export function isToolsUnsupportedBody(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /\bdoes\s+not\s+support\s+tools\b/i.test(bodyText);
}

/** Internal marker: the runtime rejected `tools`; retry once without them. */
class ToolsRejectedError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolsRejectedError";
  }
}

/** Default Azure OpenAI data-plane `api-version` (GA). */
export const DEFAULT_AZURE_API_VERSION = "2024-10-21";

/**
 * #132 — Azure OpenAI addressing. Azure serves chat completions at
 * `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`
 * and authenticates with an `api-key` header rather than a bearer token.
 */
export interface AzureOpenAIOptions {
  /** Data-plane API version, e.g. `2024-10-21`. */
  apiVersion: string;
  /** Deployment name; defaults to the request's model id. */
  deployment?: string;
}

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerKey?: ProviderKey;
  /** Default max_tokens when caller does not override per-request. */
  defaultMaxTokens?: number;
  /** Default temperature when caller does not override per-request. */
  defaultTemperature?: number;
  /**
   * Default nucleus-sampling `top_p`. Only sent when defined — leaving it
   * undefined preserves the gateway/model default (important: Bedrock output
   * must not change unless explicitly tuned). Google's Gemma 4 recommends 0.95.
   */
  defaultTopP?: number;
  /**
   * Default `frequency_penalty` (OpenAI-spec). Only sent when defined.
   * Reduces repetition. Undefined = gateway default.
   * NOTE: Google's Gemma 4 model card does NOT recommend frequency_penalty
   * (the MoE expert routing handles diversity naturally). Only use for models
   * that exhibit repetition without it.
   */
  defaultFrequencyPenalty?: number;
  /** Default `presence_penalty` (OpenAI-spec). Only sent when defined. */
  defaultPresencePenalty?: number;
  /**
   * Default `seed` for reproducible sampling. Only sent when defined.
   * Useful for deterministic local docs regeneration; Bedrock leaves unset.
   */
  defaultSeed?: number;
  /**
   * When true, adds `think: false` to the request body — and, on `local-gemma`,
   * `reasoning_effort: "none"` too. Required for thinking-by-default models
   * served by Ollama (Gemma 4, laguna-s-2.1). Without it the model spends its
   * token budget on internal reasoning that METIS discards.
   *
   * `think` alone is NOT enough on Ollama's OpenAI-compatible `/v1` endpoint:
   * measured on Ollama 0.34.2 with laguna-s-2.1, `think: false` was ignored
   * (800/800 tokens of reasoning, `finish_reason: "length"`) while
   * `reasoning_effort: "none"` produced a complete answer with no reasoning.
   * A non-thinking model (gemma3:12b) accepts `"none"` and rejects any other
   * effort with a 400, which triggers a single retry without the field.
   *
   * Per-call `ChatOptions.disableThinking` / `ChatOptions.reasoningEffort`
   * override this on `local-gemma` (an explicit effort is sent as
   * `reasoning_effort` and suppresses `think: false`). Whether
   * `reasoning_effort` is sent at all is governed by
   * `LOCAL_GEMMA_SEND_REASONING_EFFORT` (`auto` | `always` | `never`, see
   * {@link LOCAL_REASONING_EFFORT_ENV}). Other provider keys never send
   * `reasoning_effort` — bedrock-access-gateway maps it onto Claude thinking.
   *
   * Every `local-gemma` request also passes through a process-wide FIFO limiter
   * of `LOCAL_GEMMA_MAX_CONCURRENCY` (default 1) in-flight requests per base
   * URL; the first-byte / idle / request timers start only once a slot is held.
   */
  disableThinking?: boolean;
  /** Model ID → application inference profile ARN mapping for per-app cost tracking. */
  modelProfileMap?: Record<string, string>;
  /** #132 — set for the `azure` provider key; see {@link AzureOpenAIOptions}. */
  azure?: AzureOpenAIOptions;
  /**
   * Inactivity timeout (ms) BETWEEN streamed chunks once the model has begun
   * emitting tokens. The timer resets on every SSE chunk, so a long-but-
   * progressing stream is never killed — only a genuine stall (no new bytes
   * for this long mid-stream) aborts. Defaults to 120s (for `local-gemma`,
   * `LOCAL_GEMMA_IDLE_TIMEOUT_MS` when set). Set 0 to disable.
   */
  idleTimeoutMs?: number;
  /**
   * Time-to-first-byte budget (ms). A local model ingesting a very large
   * prompt (e.g. docs-gen Phase 2 with 100+ module fact-sheets) can spend
   * minutes on prompt evaluation before the FIRST token streams — during
   * which no SSE chunk arrives. This budget is applied only until the first
   * chunk; afterwards `idleTimeoutMs` governs. Defaults to 600s (for
   * `local-gemma`, `LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS` when set). Set 0 to
   * disable. A timeout throws {@link FirstTokenTimeoutError}, never retried.
   */
  firstByteTimeoutMs?: number;
  /**
   * Total request timeout (ms) for non-streaming `chat()` calls. Defaults
   * to 300s (for `local-gemma`, `LOCAL_GEMMA_REQUEST_TIMEOUT_MS` when set).
   * Set 0 to disable.
   */
  requestTimeoutMs?: number;
  /**
   * Maximum TOTAL number of tries (initial attempt + retries) for a transient
   * Bedrock failure (429/503/connection-reset). Defaults to
   * {@link DEFAULT_MAX_ATTEMPTS} (overridable via `AI_MAX_RETRIES`). Clamped to
   * `[1, 6]`; `1` disables retrying. `stream()` retries ONLY before the first
   * byte is emitted.
   */
  maxAttempts?: number;
  /**
   * Base delay (ms) for the exponential backoff. Defaults to
   * {@link DEFAULT_RETRY_BASE_DELAY_MS} (overridable via `AI_RETRY_BASE_DELAY_MS`).
   * Tests set this tiny (or override `sleepFn`) so they never sleep real seconds.
   */
  retryBaseDelayMs?: number;
  /**
   * Injectable sleep used between retries — overridable so unit tests resolve
   * instantly instead of waiting real backoff seconds. Defaults to a real
   * `setTimeout`-based delay.
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * Injectable `[0,1)` jitter source for the full-jitter backoff — overridable
   * so tests can assert a deterministic delay. Defaults to `Math.random`.
   */
  randomFn?: () => number;
}

/** Back-compat alias — see {@link OpenAICompatibleProviderOptions}. */
export type BedrockDirectProviderOptions = OpenAICompatibleProviderOptions;

/** A tool call on a non-streamed OpenAI-compatible message. */
interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** A streamed tool-call fragment; `index` ties the fragments of one call together. */
interface OpenAIToolCallDelta extends OpenAIToolCall {
  index?: number;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: OpenAIToolCall[] };
    delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /**
     * bedrock-access-gateway surfaces Anthropic cache reads here when
     * prompt caching is enabled.
     */
    prompt_tokens_details?: { cached_tokens?: number };
  };
  model?: string;
  /**
   * An OpenAI-style error object. `bedrock-access-gateway` reports a REJECTED
   * upstream Converse call by answering the HTTP request `200 text/event-stream`
   * and writing the failure INTO the stream as a single `data: {"error":{...}}`
   * frame. Without this field the frame parses into a response with no
   * `choices`, so the read loop silently produced an empty-but-successful
   * stream (see {@link extractSseErrorMessage}).
   */
  error?: { message?: string; type?: string; code?: string | number };
}

/**
 * Mutable two-stage-watchdog state shared between the (retryable) connection
 * phase and the (non-retryable) read loop of `stream()`. Kept on an object so the
 * read loop sees updates made after the watchdog was armed during connect.
 */
interface StreamWatchdogState {
  /** Set true once the first SSE chunk has been read (then `idleTimeoutMs` governs). */
  firstChunkSeen: boolean;
  /** Set true by the watchdog timer when it fires (so a thrown read can be reframed). */
  idleTimedOut: boolean;
}

/** #111 — the size of the prompt a stream was opened with, for timeout reporting. */
interface StreamPromptShape {
  model: string;
  chars: number;
  messageCount: number;
}

/** Watchdog handles returned alongside a connected stream response. */
interface StreamWatchdog {
  armIdle: () => void;
  disarmIdle: () => void;
  state: StreamWatchdogState;
  prompt: StreamPromptShape;
}

/** Result of a successful (retryable) stream connection attempt. */
interface StreamConnection {
  response: Response;
  watchdog: StreamWatchdog;
  /** Releases the local concurrency slot held for this stream (idempotent). */
  release: ReleaseSlot;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly key: ProviderKey;
  readonly offline = false;
  /**
   * #1115 — capability honesty. {@link buildRequestBody} forwards
   * `responseFormat` verbatim as the OpenAI-compatible `response_format` field
   * on both `chat()` and `stream()`, with a single degrade-retry when the
   * runtime rejects it (#336).
   *
   * #132 — `nativeToolCalls: true`: `ChatOptions.tools` are sent as `tools` /
   * `tool_choice`, and `tool_calls` (streamed deltas included) come back as
   * typed tool calls. This is the adapter-wide answer; a particular model can
   * say otherwise through {@link capabilitiesFor} (the model catalog, #135).
   */
  readonly capabilities: ProviderCapabilities = {
    responseFormat: true,
    nativeToolCalls: true,
  };
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly defaultMaxTokens: number;
  private readonly defaultTemperature: number;
  private readonly defaultTopP?: number;
  private readonly defaultFrequencyPenalty?: number;
  private readonly defaultPresencePenalty?: number;
  private readonly defaultSeed?: number;
  private readonly disableThinking: boolean;
  private readonly modelProfileMap: Record<string, string>;
  private readonly idleTimeoutMs: number;
  private readonly firstByteTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  /** Total tries (initial + retries) for a transient failure; clamped `[1, 6]`. */
  private readonly maxAttempts: number;
  /** Base delay (ms) for the exponential-backoff window. */
  private readonly retryBaseDelayMs: number;
  /** Injectable inter-retry sleep (tests override to resolve instantly). */
  private readonly sleepFn: (ms: number) => Promise<void>;
  /** Injectable `[0,1)` jitter source (tests override for determinism). */
  private readonly randomFn: () => number;
  /**
   * Per-instance undici dispatcher. Node's global `fetch` (undici) applies its
   * OWN default `headersTimeout`/`bodyTimeout` of 300s, which would fire BEFORE
   * this provider's longer app-level AbortController timers — so a local model
   * that needs >300s for cold-load + large-prompt evaluation before the first
   * token would abort with an opaque `TypeError: fetch failed` even though
   * `firstByteTimeoutMs` (default 600s) had budget left. We attach this
   * dispatcher PER REQUEST (never `setGlobalDispatcher`, so other providers /
   * web-research keep undici's defaults) with the transport timeouts widened so
   * the existing AbortController timers remain the real governors. Built once
   * and reused for the life of the provider.
   */
  private readonly dispatcher: Dispatcher;

  /**
   * #1229 — resolved model ids that have already rejected an explicit
   * `temperature`. Without this the degradation in `chat()`/`stream()` is
   * re-learned per call, so EVERY request to such a model costs a wasted 400
   * round-trip; a measured analysis run paid that on every one of dozens of
   * calls. A model that rejects the field once will reject it every time, so
   * remembering the rejection is sound. Per-instance, so a process restart or a
   * re-configured provider re-probes.
   */
  private readonly temperatureRejectedModels = new Set<string>();

  /**
   * Resolved model ids that have rejected `reasoning_effort` (e.g. a
   * non-thinking model sent an explicit effort). Same rationale as
   * {@link temperatureRejectedModels}: learn once, stop paying the 400.
   */
  private readonly reasoningEffortRejectedModels = new Set<string>();

  /**
   * #176 — resolved model ids whose runtime answered a structured-output 501
   * (see {@link isStructuredOutputUnavailableBody}). Same rationale as
   * {@link temperatureRejectedModels}: learn once, stop sending
   * `response_format` to a model that can never honour it. The status-only
   * 400/422 fallback is NOT memoised — a 400 is too broad a signal to disable
   * structured output for the life of the provider.
   */
  private readonly structuredOutputUnavailableModels = new Set<string>();

  /** `LOCAL_GEMMA_SEND_REASONING_EFFORT`, resolved for `local-gemma` only. */
  private readonly reasoningEffortMode: LocalReasoningEffortMode;

  /** Process-wide per-base-URL FIFO limiter; `local-gemma` only. */
  private readonly limiter: FifoSemaphore | undefined;

  /**
   * #132 — resolved model ids whose runtime rejected `tools` (see
   * {@link isToolsUnsupportedBody}). Same rationale as
   * {@link temperatureRejectedModels}: a model that cannot take tools never
   * will, so stop paying the 400.
   */
  private readonly toolsRejectedModels = new Set<string>();

  /** One-time warning when tools are dropped for a model that cannot take them. */
  private readonly unsupportedTools: (model: string, tools: readonly unknown[] | undefined) => void;

  /** #132 — Azure addressing, when this instance serves the `azure` key. */
  private readonly azure: AzureOpenAIOptions | undefined;

  constructor(opts: OpenAICompatibleProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.model;
    this.key = opts.providerKey ?? "bedrock-gateway";
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.defaultTemperature = opts.defaultTemperature ?? 0.2;
    this.defaultTopP = opts.defaultTopP;
    this.defaultFrequencyPenalty = opts.defaultFrequencyPenalty;
    this.defaultPresencePenalty = opts.defaultPresencePenalty;
    this.defaultSeed = opts.defaultSeed;
    this.disableThinking = opts.disableThinking ?? false;
    this.modelProfileMap = opts.modelProfileMap ?? {};
    // #111 — constructor option → `LOCAL_GEMMA_*_TIMEOUT_MS` (local-gemma only)
    // → default. Resolved BEFORE `buildDispatcher()` so undici's transport
    // timeout is sized from the budget actually in force.
    const localTimeout = (name: string, fallback: number): number =>
      this.key === "local-gemma" ? envTimeoutMsOr(name, fallback) : fallback;
    this.idleTimeoutMs =
      opts.idleTimeoutMs ?? localTimeout(LOCAL_TIMEOUT_ENV.idle, DEFAULT_IDLE_TIMEOUT_MS);
    this.firstByteTimeoutMs =
      opts.firstByteTimeoutMs ??
      localTimeout(LOCAL_TIMEOUT_ENV.firstByte, DEFAULT_FIRST_BYTE_TIMEOUT_MS);
    this.requestTimeoutMs =
      opts.requestTimeoutMs ?? localTimeout(LOCAL_TIMEOUT_ENV.request, DEFAULT_REQUEST_TIMEOUT_MS);
    // Retry/backoff knobs. The constructor option wins; otherwise read the
    // `AI_*` env knob (consistent with `config.ts`'s `intOr`); otherwise the
    // default. The attempt cap is clamped to `[1, 6]` so a hostile/typo env can
    // never spin an unbounded retry loop (OWASP — bounded resource use).
    const envMaxAttempts = envIntOr(
      process.env.AI_MAX_RETRIES,
      DEFAULT_MAX_ATTEMPTS,
      MIN_MAX_ATTEMPTS,
    );
    this.maxAttempts = Math.min(
      MAX_MAX_ATTEMPTS,
      Math.max(MIN_MAX_ATTEMPTS, opts.maxAttempts ?? envMaxAttempts),
    );
    this.retryBaseDelayMs =
      opts.retryBaseDelayMs ??
      envIntOr(process.env.AI_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS, 0);
    this.sleepFn = opts.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.randomFn = opts.randomFn ?? Math.random;
    this.dispatcher = this.buildDispatcher();
    const isLocal = this.key === "local-gemma";
    this.reasoningEffortMode = isLocal ? resolveLocalReasoningEffortMode() : "never";
    this.limiter = isLocal ? localConcurrencyLimiter(this.baseUrl) : undefined;
    this.azure = opts.azure;
    this.unsupportedTools = createUnsupportedToolsWarner(log, this.key);
  }

  /**
   * #131 — per-model capabilities, from the model catalog (#135). An unknown
   * model gets this provider key's defaults, which match {@link capabilities}.
   */
  capabilitiesFor(model: string): ProviderCapabilities {
    return catalogCapabilities(this.key, model);
  }

  /**
   * #132 — whether `opts.tools` go on the wire for `requestedModel`: only when
   * the caller supplied some, did not disable tools, the catalog says the model
   * is tool-capable, and the runtime has not already rejected them. A drop is
   * logged once per model.
   */
  private shouldSendTools(opts: ChatOptions, requestedModel: string, resolved: string): boolean {
    if (!opts.tools || opts.tools.length === 0 || opts.disableTools) return false;
    if (!this.capabilitiesFor(requestedModel).nativeToolCalls) {
      this.unsupportedTools(requestedModel, opts.tools);
      return false;
    }
    return !this.toolsRejectedModels.has(resolved);
  }

  /** #132 — the chat-completions URL: Azure's deployment form, or `{base}/chat/completions`. */
  private chatUrl(model: string): string {
    if (!this.azure) return `${this.baseUrl}/chat/completions`;
    const deployment = encodeURIComponent(this.azure.deployment ?? model);
    const version = encodeURIComponent(this.azure.apiVersion);
    return `${this.baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=${version}`;
  }

  /** #132 — the model-listing URL used by `models()` / `ping()`. */
  private modelsUrl(): string {
    return this.azure
      ? `${this.baseUrl}/openai/models?api-version=${encodeURIComponent(this.azure.apiVersion)}`
      : `${this.baseUrl}/models`;
  }

  /** #132 — Azure authenticates with `api-key`; everything else with a bearer token. */
  private authHeaders(): Record<string, string> {
    return this.azure ? { "api-key": this.apiKey } : { Authorization: `Bearer ${this.apiKey}` };
  }

  /**
   * Wait for a local concurrency slot (no-op for non-local providers). Callers
   * MUST arm their timeouts only after this resolves and MUST call the returned
   * release on every exit path.
   */
  private acquireSlot(signal: AbortSignal | undefined): Promise<ReleaseSlot> {
    return this.limiter ? this.limiter.acquire(signal) : Promise.resolve(() => undefined);
  }

  /**
   * Construct the per-instance undici `Agent` whose transport timeouts are
   * widened so they NEVER preempt this provider's app-level AbortController
   * timers (the intended governors of a slow local model).
   *
   * - `headersTimeout` (undici's time-to-first-response-byte budget) is sized
   *   to the LARGEST app-level wait that gates the first byte — the streaming
   *   `firstByteTimeoutMs` (TTFT) and the non-streaming `requestTimeoutMs` —
   *   plus a margin, so undici always fires AFTER the app timer. `0` on the
   *   governing app timer (timer disabled) maps to `0` here (undici limit
   *   disabled) so "no app limit" never silently becomes "300s undici limit".
   * - `bodyTimeout` is DISABLED (`0`): a long-but-progressing SSE stream must
   *   not be killed by a body-read deadline. The app's `idleTimeoutMs` already
   *   aborts a genuine BETWEEN-chunk stall, so there is still no infinite hang.
   */
  private buildDispatcher(): Dispatcher {
    const { headersTimeout, bodyTimeout } = resolveUndiciTimeouts(
      this.firstByteTimeoutMs,
      this.requestTimeoutMs,
    );
    return new Agent({ headersTimeout, bodyTimeout });
  }

  get model(): string {
    return this.defaultModel;
  }

  /**
   * Resolve a model ID to its application inference profile ARN if mapped.
   *
   * When a profile map IS configured (i.e. `BEDROCK_SONNET_PROFILE` /
   * `BEDROCK_HAIKU_PROFILE` are set) the swap is what drives per-app Bedrock
   * cost attribution in AWS Cost Explorer: every model ID that exactly matches
   * a map key is replaced by the application-inference-profile ARN. The swap is
   * cost-attribution only — it does NOT pin a region. Cross-region routing
   * (us-east-1 / us-east-2 / us-west-2) via the `us.anthropic.*` / `global.*`
   * system inference profiles is INTENTIONAL and permitted by the gateway IAM.
   *
   * If a profile map is configured but a cross-region (`us.` / `global.`) model
   * ID arrives that has NO matching key, the raw ID is sent to the gateway and
   * that request's spend lands OUTSIDE the application inference profile — i.e.
   * it silently bypasses cost attribution. That is not a hard failure (the
   * request still succeeds and routes normally), but it IS an observability
   * signal worth surfacing, so we emit a structured `warn`. We log only the
   * model ID and a `profileMapConfigured` boolean — never the API key, the
   * Authorization header, or the ARN values themselves.
   *
   * When NO profile map is configured the model ID is passed through unchanged
   * and NO warning is emitted (cost attribution is simply not in use).
   */
  private resolveModel(modelId: string): string {
    const mapped = this.modelProfileMap[modelId];
    if (mapped !== undefined) return mapped;

    // Passthrough. Only an observability concern when a map IS configured AND
    // the unmapped ID is a cross-region system profile (the cost-attribution
    // bypass case). A bare/native model ID with no map is normal operation.
    const profileMapConfigured = Object.keys(this.modelProfileMap).length > 0;
    if (profileMapConfigured && isCrossRegionModelId(modelId)) {
      log.warn(
        "Unmapped cross-region Bedrock model ID sent to gateway; this request bypasses application-inference-profile cost attribution",
        {
          provider: this.key,
          // Safe to log: a model identifier, not a secret. The API key,
          // Authorization header, and profile ARNs are intentionally omitted.
          model: modelId,
          profileMapConfigured,
        },
      );
    }
    return modelId;
  }

  /**
   * Run a single connection `attemptFn` with BOUNDED exponential backoff + full
   * jitter, retrying ONLY on transient failures (429/503 via a thrown
   * {@link RetryableHttpError}, or a connection-reset-class network error). The
   * total number of tries is capped at `this.maxAttempts` (initial + retries),
   * so the loop always terminates — there is no unbounded retry (OWASP).
   *
   * Per retry we emit ONE structured `warn` recording the upcoming attempt
   * number, the delay, and the status/cause — never the API key or the
   * `Authorization` header. A `Retry-After` (carried on a thrown
   * {@link RetryableHttpError}) is honored as the delay FLOOR for that attempt.
   *
   * Non-retryable errors (4xx other than 429, an `AbortError`, a parse/logic
   * error) propagate IMMEDIATELY without consuming retries.
   *
   * IMPORTANT (`stream()`): callers pass an `attemptFn` that only performs the
   * pre-first-byte work (open connection, check response status). Once the
   * stream has emitted any token the caller must NOT route through this helper —
   * a mid-stream failure surfaces directly (the issue's hard requirement).
   */
  private async withRetry<T>(
    attemptFn: () => Promise<T>,
    context: { method: "chat" | "stream"; model: string },
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        return await attemptFn();
      } catch (err) {
        lastError = err;
        const retryAfterMs = err instanceof RetryableHttpError ? err.retryAfterMs : undefined;
        const status = err instanceof RetryableHttpError ? err.status : undefined;
        // #111 — a first-token timeout is never retried: the identical prompt would
        // repeat the entire prefill on a local runtime and time out the same way.
        // Excluded by TYPE: `isRetryableNetworkError` also matches message text.
        const retryable =
          !(err instanceof FirstTokenTimeoutError) &&
          (err instanceof RetryableHttpError || isRetryableNetworkError(err));
        const triesLeft = this.maxAttempts - attempt;
        if (!retryable || triesLeft <= 0) {
          throw err;
        }
        // `attempt` is the index of the try that just failed; the upcoming retry
        // uses the same index for its exponential window (1-based).
        const delay = computeBackoffDelay(
          attempt,
          this.retryBaseDelayMs,
          retryAfterMs,
          this.randomFn,
        );
        log.warn("Retrying transient Bedrock provider failure with backoff", {
          provider: this.key,
          method: context.method,
          // Safe to log: identifiers and timing, never the API key / Authorization header.
          model: context.model,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: this.maxAttempts,
          delayMs: delay,
          ...(status !== undefined ? { status } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          cause: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
        await this.sleepFn(delay);
      }
    }
    // Unreachable in practice (the loop either returns or throws), but keeps the
    // type-checker honest and guarantees a surfaced error rather than a silent
    // hang if the cap were ever 0.
    throw lastError instanceof Error
      ? lastError
      : new Error(`${this.key} ${context.method} failed after ${this.maxAttempts} attempts`);
  }

  /**
   * Single (retryable) stream CONNECTION attempt: build a fresh AbortController +
   * two-stage watchdog, fire the streaming `fetch`, and validate the response is
   * OK with a body. Returns the open `response` plus the watchdog handles for the
   * read loop. Throws a {@link RetryableHttpError} on a transient 429/503 (so
   * `withRetry` retries it), or a plain error otherwise. NO token has been read
   * yet, so retrying here is always safe — the moment the read loop pulls a chunk
   * we are past the retry boundary.
   */
  private async connectStream(
    url: string,
    body: Record<string, unknown>,
    opts: ChatOptions,
    prompt: StreamPromptShape,
    carriesResponseFormat = false,
    includeTemperature = true,
    carriesReasoningEffort = false,
    carriesTools = false,
  ): Promise<StreamConnection> {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    // Queue for a local concurrency slot BEFORE anything is timed: time spent
    // waiting behind another generation must never count as a first-byte stall.
    const release = await this.acquireSlot(opts.signal);
    try {
      const conn = await this.openStream(
        url,
        body,
        opts,
        prompt,
        carriesResponseFormat,
        includeTemperature,
        carriesReasoningEffort,
        carriesTools,
      );
      return { ...conn, release };
    } catch (err) {
      release();
      throw err;
    }
  }

  /** The body of {@link connectStream}, run while holding a concurrency slot. */
  private async openStream(
    url: string,
    body: Record<string, unknown>,
    opts: ChatOptions,
    prompt: StreamPromptShape,
    carriesResponseFormat: boolean,
    includeTemperature: boolean,
    carriesReasoningEffort: boolean,
    carriesTools: boolean,
  ): Promise<Omit<StreamConnection, "release">> {
    const controller = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
      opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    // Two-stage watchdog. Until the FIRST chunk arrives we allow up to
    // `firstByteTimeoutMs` (a local model may spend minutes on prompt evaluation
    // for a very large prompt before emitting any token). Once streaming has
    // started, the tighter `idleTimeoutMs` governs the gap BETWEEN chunks so a
    // genuine mid-stream stall still aborts promptly.
    const state: StreamWatchdogState = { firstChunkSeen: false, idleTimedOut: false };
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const currentTimeoutMs = (): number =>
      state.firstChunkSeen ? this.idleTimeoutMs : this.firstByteTimeoutMs;
    const armIdle = (): void => {
      const ms = currentTimeoutMs();
      if (ms <= 0) {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
        return;
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        state.idleTimedOut = true;
        controller.abort();
      }, ms);
    };
    const disarmIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
    };

    armIdle();
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // Per-request undici dispatcher: undici's default 300s headersTimeout
        // would otherwise abort a cold-loading local model BEFORE the app-level
        // `firstByteTimeoutMs` (TTFT, default 600s). Scoped to this fetch only —
        // never global — so the Anthropic provider / web-research are unaffected.
        // `bodyTimeout` is disabled on the dispatcher; `idleTimeoutMs` governs
        // between-chunk stalls instead.
        dispatcher: this.dispatcher,
      } as RequestInit & { dispatcher: Dispatcher });
    } catch (err) {
      disarmIdle();
      if (state.idleTimedOut) {
        // A first-byte timeout is its own (non-retryable) failure mode (#111).
        throw this.firstTokenTimeout(prompt, "no response headers yet");
      }
      // A connection-reset network error here is retryable; `withRetry` decides.
      throw err;
    }

    if (!response.ok) {
      disarmIdle();
      const text = await response.text().catch(() => "");
      const msg = `${this.key} returned ${response.status}: ${text.slice(0, 200)}`;
      // 429/503 BEFORE the first byte → retryable (carry any Retry-After).
      if (isRetryableStatus(response.status)) {
        throw new RetryableHttpError(
          response.status,
          text.slice(0, 200),
          parseRetryAfterMs(response.headers.get("retry-after")),
          msg,
        );
      }
      // Graceful fallback for a "temperature is deprecated for this model"
      // rejection — no token has been read yet, so `stream()` can reconnect once
      // without the field. Checked BEFORE the structured-output branch: that one
      // matches on STATUS alone (any 400/422 carrying `response_format`), so it
      // would otherwise swallow this far more precise body match and drop
      // `response_format` to fix a problem `response_format` never caused.
      if (includeTemperature && isTemperatureUnsupportedBody(response.status, text)) {
        throw new TemperatureUnsupportedError(response.status, text.slice(0, 200), msg);
      }
      // A model that cannot take `reasoning_effort` (a non-thinking model sent
      // an explicit effort). Before the structured-output branch, which would
      // otherwise swallow any 400 on a request carrying `response_format`.
      if (carriesReasoningEffort && isReasoningEffortUnsupportedBody(response.status, text)) {
        throw new ReasoningEffortRejectedError(response.status, text.slice(0, 200), msg);
      }
      // #132 — a model that cannot take `tools`. Also before the status-only
      // structured-output branch, for the same reason.
      if (carriesTools && isToolsUnsupportedBody(response.status, text)) {
        throw new ToolsRejectedError(response.status, text.slice(0, 200), msg);
      }
      // #336 — 400/422 on a request carrying `response_format` → the runtime
      // likely can't schema-constrain; classifiable so `stream()` can retry
      // once without the field (graceful degradation). Safe to fall back here:
      // no token has been read yet (pre-first-byte), so no partial output leaks.
      if (carriesResponseFormat && isStructuredOutputRejection(response.status, text)) {
        throw new StructuredOutputRejectedError(response.status, text.slice(0, 200), msg);
      }
      throw new Error(msg);
    }
    if (!response.body) {
      disarmIdle();
      throw new Error(`${this.key} returned empty stream body`);
    }

    return { response, watchdog: { armIdle, disarmIdle, state, prompt } };
  }

  /**
   * #111 — the operator remedy for a timeout on THIS provider: the env knob that
   * governs the budget, named, when one exists (local-gemma only).
   */
  private timeoutKnobHint(envName: string): string {
    return this.key === "local-gemma"
      ? `. Raise ${envName} (ms; 0 disables) if the model needs longer.`
      : "";
  }

  /**
   * #111 — build (and log) the first-token timeout. The message states what was
   * OBSERVED — no first token within N ms for a prompt of this size — rather than
   * guessing the model is down: the live case that motivated this was a model
   * 98% of the way through a 130K-token prefill.
   */
  private firstTokenTimeout(prompt: StreamPromptShape, phase: string): FirstTokenTimeoutError {
    const ms = this.firstByteTimeoutMs;
    const isLocal = this.key === "local-gemma";
    log.warn("Stream timed out before the first token", {
      provider: this.key,
      model: prompt.model,
      firstByteTimeoutMs: ms,
      promptChars: prompt.chars,
      messageCount: prompt.messageCount,
      phase,
      ...(isLocal ? { knob: LOCAL_TIMEOUT_ENV.firstByte } : {}),
    });
    const message =
      `${this.key} stream stalled — no first token within ${ms}ms for a prompt of ` +
      `${prompt.chars} chars across ${prompt.messageCount} message(s) (${phase})` +
      (isLocal
        ? ". A local runtime emits nothing until it has processed the whole prompt, so a large prompt can need longer than this budget" +
          this.timeoutKnobHint(LOCAL_TIMEOUT_ENV.firstByte)
        : "");
    return new FirstTokenTimeoutError(ms, prompt.chars, prompt.messageCount, message);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResponse> {
    const requestedModel = opts.model ?? this.defaultModel;
    const model = this.resolveModel(requestedModel);
    // #132 — tools, decided once per call; a runtime rejection drops them once.
    let includeTools = this.shouldSendTools(opts, requestedModel, model);

    // #336 — structured-output graceful degradation, plus the `temperature`
    // deprecation fallback. A runtime may reject BOTH fields (Claude Sonnet 5
    // behind bedrock-access-gateway does exactly this), so the two degradations
    // are tracked INDEPENDENTLY and each may fire once. An earlier single-catch
    // version could only ever recover from one of them, which meant enabling
    // `responseFormat` turned a recoverable temperature 400 into a hard failure.
    // When no `responseFormat` is set this still collapses to a plain call.
    // #176 — skip `response_format` on a model known to 501 it.
    let includeResponseFormat = !this.structuredOutputUnavailableModels.has(model);
    // #1229 — skip the probe entirely on a model already known to reject it.
    let includeTemperature = !this.temperatureRejectedModels.has(model);
    let triedWithoutResponseFormat = false;
    let triedWithoutTemperature = false;
    let includeReasoningEffort = !this.reasoningEffortRejectedModels.has(model);

    for (;;) {
      try {
        return await this.chatOnce(
          messages,
          opts,
          model,
          includeResponseFormat,
          includeTemperature,
          includeReasoningEffort,
          includeTools,
        );
      } catch (err) {
        if (err instanceof ReasoningEffortRejectedError && includeReasoningEffort) {
          includeReasoningEffort = false;
          this.noteReasoningEffortRejected(model, err, "chat");
          continue;
        }
        if (err instanceof ToolsRejectedError && includeTools) {
          includeTools = false;
          this.noteToolsRejected(model, err, "chat");
          continue;
        }
        if (
          err instanceof StructuredOutputRejectedError &&
          opts.responseFormat &&
          !triedWithoutResponseFormat
        ) {
          triedWithoutResponseFormat = true;
          includeResponseFormat = false;
          this.noteStructuredOutputRejected(model, err);
          log.warn(
            "Runtime rejected structured-output response_format; retrying once without it (free-form parse fallback)",
            {
              provider: this.key,
              model,
              status: err.status,
              // Safe to log: status + a short body excerpt, never the API key.
              cause: err.bodyExcerpt.slice(0, 200),
            },
          );
          continue;
        }
        if (err instanceof TemperatureUnsupportedError && !triedWithoutTemperature) {
          triedWithoutTemperature = true;
          includeTemperature = false;
          this.temperatureRejectedModels.add(model);
          log.warn(
            "Runtime rejected explicit temperature; retrying once without it (model default fallback)",
            {
              provider: this.key,
              model,
              status: err.status,
              cause: err.bodyExcerpt.slice(0, 200),
            },
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * One non-streaming chat attempt. `includeResponseFormat` controls whether the
   * `response_format` structured-output field (#336) is sent — the graceful
   * fallback path sets it false on the retry after a rejection.
   * `includeTemperature` controls whether `temperature` is sent — the graceful
   * fallback path sets it false on the retry after a "deprecated" rejection
   * (see {@link isTemperatureUnsupportedBody}).
   */
  private async chatOnce(
    messages: ChatMessage[],
    opts: ChatOptions,
    model: string,
    includeResponseFormat: boolean,
    includeTemperature: boolean,
    includeReasoningEffort = true,
    includeTools = false,
  ): Promise<ChatResponse> {
    const url = this.chatUrl(model);

    const body = this.buildRequestBody(
      messages,
      opts,
      model,
      false,
      includeResponseFormat,
      includeTemperature,
      includeReasoningEffort,
      includeTools,
    );
    const carriesResponseFormat = includeResponseFormat && opts.responseFormat != null;
    const carriesReasoningEffort = this.canFallBackFromReasoningEffort(body);

    log.debug("Direct chat request", {
      model,
      url,
      messageCount: messages.length,
      maxTokens: body.max_tokens,
      caching: opts.promptCaching,
    });

    // Each attempt gets a fresh AbortController + timeout (a retry must not reuse
    // a controller already aborted by the previous attempt's timeout). The whole
    // fetch → status-check → parse runs inside `withRetry`, which retries only on
    // a transient 429/503 or a connection-reset network error (bounded by
    // `maxAttempts`); a non-retryable status (4xx other than 429) or an exhausted
    // budget surfaces a clear error rather than hanging.
    const json = await this.withRetry<OpenAIChatResponse>(
      async () => {
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        // Queue for a local concurrency slot BEFORE the request timer starts, and
        // hold it until the body is read (see local-concurrency-limiter.ts).
        const release = await this.acquireSlot(opts.signal);
        try {
          const controller = new AbortController();
          if (opts.signal) {
            if (opts.signal.aborted) throw new DOMException("Aborted", "AbortError");
            opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
          }
          // Total-request timeout so a stalled backend (e.g. a local Ollama runtime)
          // cannot block the caller forever.
          const timeout =
            this.requestTimeoutMs > 0
              ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
              : undefined;

          let response: Response;
          try {
            response = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...this.authHeaders(),
              },
              body: JSON.stringify(body),
              signal: controller.signal,
              // Per-request undici dispatcher so undici's default 300s transport
              // timeouts cannot preempt this provider's `requestTimeoutMs`. Scoped to
              // this fetch — never global — so other providers keep undici defaults.
              dispatcher: this.dispatcher,
            } as RequestInit & { dispatcher: Dispatcher });
          } catch (err) {
            if (timeout) clearTimeout(timeout);
            if (controller.signal.aborted && !opts.signal?.aborted) {
              throw new Error(
                `${this.key} chat request timed out after ${this.requestTimeoutMs}ms` +
                  this.timeoutKnobHint(LOCAL_TIMEOUT_ENV.request),
              );
            }
            throw err;
          }
          if (timeout) clearTimeout(timeout);

          if (!response.ok) {
            const text = await response.text().catch(() => "");
            log.error("OpenAI-compatible provider error", {
              provider: this.key,
              status: response.status,
              body: text.slice(0, 500),
            });
            const msg = `${this.key} returned ${response.status}: ${text.slice(0, 200)}`;
            // 429/503 are transient → mark retryable (carrying any Retry-After).
            if (isRetryableStatus(response.status)) {
              throw new RetryableHttpError(
                response.status,
                text.slice(0, 200),
                parseRetryAfterMs(response.headers.get("retry-after")),
                msg,
              );
            }
            // A "temperature is deprecated for this model" rejection → classifiable
            // so `chat()` can retry once WITHOUT the field. Checked BEFORE the
            // structured-output branch: that one matches on STATUS alone (any
            // 400/422 carrying `response_format`), so it would otherwise swallow
            // this far more precise body match and drop `response_format` to fix a
            // problem `response_format` never caused.
            if (includeTemperature && isTemperatureUnsupportedBody(response.status, text)) {
              throw new TemperatureUnsupportedError(response.status, text.slice(0, 200), msg);
            }
            if (carriesReasoningEffort && isReasoningEffortUnsupportedBody(response.status, text)) {
              throw new ReasoningEffortRejectedError(response.status, text.slice(0, 200), msg);
            }
            if (includeTools && isToolsUnsupportedBody(response.status, text)) {
              throw new ToolsRejectedError(response.status, text.slice(0, 200), msg);
            }
            // #336 — a 400/422 on a request that carried `response_format` likely
            // means the runtime does not support schema-guided decoding; surface a
            // classifiable error so `chat()` can retry once WITHOUT the field.
            if (carriesResponseFormat && isStructuredOutputRejection(response.status, text)) {
              throw new StructuredOutputRejectedError(response.status, text.slice(0, 200), msg);
            }
            // Everything else (4xx auth/validation) propagates immediately.
            throw new Error(msg);
          }

          return (await response.json()) as OpenAIChatResponse;
        } finally {
          release();
        }
      },
      { method: "chat", model },
    );

    const content = json.choices?.[0]?.message?.content ?? "";
    const toolCalls = parseToolCalls(json.choices?.[0]?.message?.tool_calls);
    const cached = json.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: TokenUsage = {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };

    log.debug("Direct chat response", {
      model: json.model ?? model,
      contentLength: content.length,
      tokens: usage.totalTokens,
      cachedTokens: cached,
      cacheHitRatio: usage.promptTokens > 0 ? (cached / usage.promptTokens).toFixed(2) : "n/a",
    });

    // Prompt-cache hit-ratio telemetry (#390). This OpenAI-compatible gateway
    // path reports cache READS only (`cached_tokens`); cache CREATION is not
    // surfaced here, so the emitted ratio is read-based. We tag by call type
    // (defaults to "unknown") and by the RESPONSE model id (never an ARN). The
    // emitter never throws, so it can never break a request.
    recordCacheHit({
      callType: opts.callType,
      model: json.model ?? model,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      promptTokens: usage.promptTokens,
    });

    return {
      content,
      usage,
      model: json.model ?? model,
      provider: this.key,
      // #1217 — surface the stop reason so callers can tell an output-cap
      // truncation (`"length"`) from a model that simply answered badly.
      ...(json.choices?.[0]?.finish_reason !== undefined
        ? { finishReason: json.choices[0].finish_reason }
        : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
    const requestedModel = opts.model ?? this.defaultModel;
    const model = this.resolveModel(requestedModel);
    const url = this.chatUrl(model);
    // #132 — see chat().
    let includeTools = this.shouldSendTools(opts, requestedModel, model);

    log.debug("Direct stream request", {
      model,
      url,
      messageCount: messages.length,
      maxTokens: opts.maxTokens ?? this.defaultMaxTokens,
      caching: opts.promptCaching,
    });

    const prompt: StreamPromptShape = {
      model,
      chars: promptChars(messages),
      messageCount: messages.length,
    };

    // CONNECTION PHASE (pre-first-byte) — retried on a transient 429/503 or a
    // connection-reset error, bounded by `maxAttempts`. Each attempt builds a
    // FRESH AbortController + watchdog so a retry never reuses an aborted signal.
    // Once we have an open, OK response with a body we STOP retrying and hand the
    // watchdog handles to the read loop: a failure AFTER any token is emitted
    // must surface to the caller, never restart the stream (issue #388 hard rule).
    //
    // #336 — structured-output graceful degradation. The first connect carries
    // the caller's `response_format`; if the runtime rejects it pre-first-byte
    // with a 400/422, we log ONCE and reconnect WITHOUT the field. No token has
    // been read at that point, so no partial output leaks. Wrapping the connect
    // (not the read loop) keeps the #388 rule intact: a mid-stream failure is
    // never retried.
    const connectWith = (
      includeResponseFormat: boolean,
      includeTemperature: boolean,
      includeReasoningEffort: boolean,
      sendTools: boolean,
    ): Promise<StreamConnection> => {
      const body = this.buildRequestBody(
        messages,
        opts,
        model,
        true,
        includeResponseFormat,
        includeTemperature,
        includeReasoningEffort,
        sendTools,
      );
      const carriesResponseFormat = includeResponseFormat && opts.responseFormat != null;
      const carriesReasoningEffort = this.canFallBackFromReasoningEffort(body);
      return this.withRetry<StreamConnection>(
        () =>
          this.connectStream(
            url,
            body,
            opts,
            prompt,
            carriesResponseFormat,
            includeTemperature,
            carriesReasoningEffort,
            sendTools,
          ),
        { method: "stream", model },
      );
    };
    // Both graceful degradations (#336 `response_format`, and the
    // temperature-deprecation fallback) can be signalled TWO ways:
    //   1. a non-2xx during connect — classified in `connectStream()`, or
    //   2. an in-band `data: {"error":...}` frame on an otherwise `200
    //      text/event-stream` body — which is what bedrock-access-gateway does.
    // Case 2 is only observable while READING, so connect and read are driven
    // together here and the SINGLE fallback re-run is allowed for a failure seen
    // BEFORE any delta was emitted. Once a token has been yielded the stream is
    // never restarted (issue #388 hard rule), which `emittedDelta` enforces.
    // #176 — skip `response_format` on a model known to 501 it.
    let includeResponseFormat = !this.structuredOutputUnavailableModels.has(model);
    // #1229 — skip the probe entirely on a model already known to reject it.
    let includeTemperature = !this.temperatureRejectedModels.has(model);
    let triedWithoutResponseFormat = false;
    let triedWithoutTemperature = false;
    let includeReasoningEffort = !this.reasoningEffortRejectedModels.has(model);

    for (;;) {
      let emittedDelta = false;
      try {
        const conn = await connectWith(
          includeResponseFormat,
          includeTemperature,
          includeReasoningEffort,
          includeTools,
        );
        for await (const chunk of this.consumeStream(
          conn,
          model,
          opts,
          includeTemperature,
          includeResponseFormat && opts.responseFormat != null,
        )) {
          if (chunk.type === "delta" || chunk.type === "tool_call") emittedDelta = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (emittedDelta) throw err;
        if (err instanceof ReasoningEffortRejectedError && includeReasoningEffort) {
          includeReasoningEffort = false;
          this.noteReasoningEffortRejected(model, err, "stream");
          continue;
        }
        if (err instanceof ToolsRejectedError && includeTools) {
          includeTools = false;
          this.noteToolsRejected(model, err, "stream");
          continue;
        }
        if (
          err instanceof StructuredOutputRejectedError &&
          opts.responseFormat &&
          !triedWithoutResponseFormat
        ) {
          triedWithoutResponseFormat = true;
          includeResponseFormat = false;
          this.noteStructuredOutputRejected(model, err);
          log.warn(
            "Runtime rejected structured-output response_format on stream; retrying once without it (free-form parse fallback)",
            {
              provider: this.key,
              model,
              status: err.status,
              cause: err.bodyExcerpt.slice(0, 200),
            },
          );
          continue;
        }
        if (err instanceof TemperatureUnsupportedError && !triedWithoutTemperature) {
          triedWithoutTemperature = true;
          includeTemperature = false;
          this.temperatureRejectedModels.add(model);
          log.warn(
            "Runtime rejected explicit temperature on stream; retrying once without it (model default fallback)",
            {
              provider: this.key,
              model,
              status: err.status,
              cause: err.bodyExcerpt.slice(0, 200),
            },
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Read ONE already-connected SSE stream to completion, translating frames into
   * `ChatChunk`s. Split out of {@link stream} so the driver above can observe a
   * pre-first-token failure and perform its single graceful re-run.
   *
   * `includeTemperature` / `carriesResponseFormat` describe what the REQUEST
   * that opened this stream carried, so an in-band error frame can be classified
   * against the field that actually caused it.
   */
  private async *consumeStream(
    conn: StreamConnection,
    model: string,
    opts: ChatOptions,
    includeTemperature: boolean,
    carriesResponseFormat: boolean,
  ): AsyncGenerator<ChatChunk> {
    const { response, watchdog } = conn;
    const { armIdle, disarmIdle, state, prompt } = watchdog;

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalUsage: TokenUsage | null = null;
    // #1226 — the LAST non-null `finish_reason` seen on the stream. Without it a
    // response cut off at the output cap (`"length"`) is indistinguishable from
    // one that finished cleanly, so docs-gen silently persisted truncated
    // sections. Forwarded on the terminal `done` chunk.
    let finishReason: string | undefined;
    // #718 — strip inline <tool_call>/<tool_response> XML hallucinated into the
    // text stream, converting it to structured events instead of leaking tags.
    const toolTagParser = new ToolTagStreamParser();
    // #132 — native tool calls arrive as `delta.tool_calls` fragments keyed by
    // `index`: the id and name on the first, the JSON arguments split across
    // many. Assembled here and emitted, in index order, before `usage`/`done`.
    const toolCallAssembler = new ToolCallDeltaAssembler();

    try {
      while (true) {
        let value: Uint8Array | undefined;
        let done: boolean;
        try {
          ({ value, done } = await reader.read());
        } catch (err) {
          // A mid-stream read failure is NOT retried (tokens may already be
          // emitted) — it surfaces here per issue #388. We only translate a
          // watchdog-driven abort into a clear stall message.
          if (state.idleTimedOut) {
            if (!state.firstChunkSeen) {
              throw this.firstTokenTimeout(prompt, "connected, awaiting the first token");
            }
            throw new Error(
              `${this.key} stream stalled — no data mid-stream for ${this.idleTimeoutMs}ms (local model may be overloaded or the prompt exceeds its context window)` +
                this.timeoutKnobHint(LOCAL_TIMEOUT_ENV.idle),
            );
          }
          throw err;
        }
        if (done) break;
        // Progress observed — mark first chunk and reset the watchdog (which
        // now uses the tighter inter-chunk idle budget).
        state.firstChunkSeen = true;
        armIdle();
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by blank lines.
        let nl = buffer.indexOf("\n\n");
        while (nl !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          for (const line of frame.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              disarmIdle();
              for (const chunk of toolTagParser.flush()) yield chunk;
              for (const chunk of toolCallAssembler.flush()) yield chunk;
              if (finalUsage) {
                this.emitCacheTelemetry(finalUsage, model, opts);
                yield { type: "usage", usage: finalUsage };
              }
              yield { type: "done", ...(finishReason ? { finishReason } : {}) };
              return;
            }
            let parsed: OpenAIChatResponse;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }
            // An in-band error frame is a FAILED call that the gateway dressed
            // up as `200 text/event-stream`. It must surface as a thrown error,
            // never as a silently-empty success (see extractSseErrorMessage).
            const streamError = extractSseErrorMessage(parsed);
            if (streamError) {
              disarmIdle();
              const status = embeddedStatusFromStreamError(streamError);
              const msg = `${this.key} stream error: ${streamError.slice(0, 300)}`;
              log.error("OpenAI-compatible provider streamed an error frame", {
                provider: this.key,
                model,
                embeddedStatus: status,
                body: streamError.slice(0, 500),
              });
              // Classify the two rejections that have a graceful single retry,
              // so `stream()` can reconnect without the offending field exactly
              // as the non-streaming `chat()` path already does.
              if (includeTemperature && isTemperatureUnsupportedBody(status, streamError)) {
                throw new TemperatureUnsupportedError(status, streamError.slice(0, 200), msg);
              }
              if (
                carriesResponseFormat &&
                ((isStructuredOutputUnsupportedStatus(status) &&
                  /response_format|schema/i.test(streamError)) ||
                  isStructuredOutputUnavailableBody(status, streamError))
              ) {
                throw new StructuredOutputRejectedError(status, streamError.slice(0, 200), msg);
              }
              throw new Error(msg);
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              for (const chunk of toolTagParser.push(delta)) yield chunk;
            }
            toolCallAssembler.push(parsed.choices?.[0]?.delta?.tool_calls);
            // #1226 — the stop signal rides a LATE frame (usually the one with
            // an empty delta), so keep the most recent non-empty value.
            const frameFinishReason = parsed.choices?.[0]?.finish_reason;
            if (typeof frameFinishReason === "string" && frameFinishReason.length > 0) {
              finishReason = frameFinishReason;
            }
            if (parsed.usage) {
              finalUsage = {
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens: parsed.usage.total_tokens ?? 0,
                cacheReadTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? 0,
                cacheWriteTokens: 0,
              };
            }
          }
          nl = buffer.indexOf("\n\n");
        }
      }
      for (const chunk of toolTagParser.flush()) yield chunk;
      for (const chunk of toolCallAssembler.flush()) yield chunk;
      if (finalUsage) {
        this.emitCacheTelemetry(finalUsage, model, opts);
        yield { type: "usage", usage: finalUsage };
      }
      yield { type: "done", ...(finishReason ? { finishReason } : {}) };
    } finally {
      disarmIdle();
      // Start the cancel, then free the concurrency slot BEFORE awaiting it, so a
      // slow teardown can never hold every other local request hostage. This
      // `finally` runs on every exit: completion, error, watchdog abort, caller
      // abort, and a consumer that stops iterating early (`return()`).
      const cancelling = reader.cancel().catch(() => undefined);
      conn.release();
      await cancelling;
    }
  }

  /**
   * Emit prompt-cache hit-ratio telemetry (#390) for one completed call. Shared
   * by `stream()`'s two terminal yield-usage paths (the `[DONE]` frame and the
   * natural end-of-stream). This gateway path reports cache READS only, so the
   * derived ratio is read-based. Delegates to {@link recordCacheHit}, which is
   * non-throwing and logs ONLY identifiers + token counts (never a secret).
   */
  private emitCacheTelemetry(usage: TokenUsage, model: string, opts: ChatOptions): void {
    recordCacheHit({
      callType: opts.callType,
      model,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      promptTokens: usage.promptTokens,
    });
  }

  async embed(_texts: string[]): Promise<EmbedResult> {
    // Embeddings are intentionally unsupported on this OpenAI-compatible chat
    // client. A Gemma chat model is not an embedder, and Bedrock embeddings
    // run on the dedicated embeddings backend. Callers must route embeddings
    // elsewhere rather than silently mis-using a chat endpoint.
    throw new Error(`${this.key} provider does not support embeddings`);
  }

  async models(): Promise<string[]> {
    try {
      const resp = await fetch(this.modelsUrl(), {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return [this.defaultModel];
      const json = (await resp.json()) as { data?: Array<{ id: string }> };
      return json.data?.map((m) => m.id) ?? [this.defaultModel];
    } catch {
      return [this.defaultModel];
    }
  }

  async ping(): Promise<boolean> {
    try {
      const resp = await fetch(this.modelsUrl(), {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * @param includeResponseFormat when false, the OpenAI-compatible
   *   `response_format` structured-output field (#336) is OMITTED even if the
   *   caller supplied `opts.responseFormat`. Used by the ONE graceful fallback
   *   retry after a runtime rejects the field, so the second attempt sends the
   *   plain free-form request the caller's parse/repair path expects.
   * @param includeTemperature when false, `temperature` is OMITTED so the
   *   model falls back to its own pinned default. Used by the ONE graceful
   *   fallback retry after a runtime rejects the field as unsupported/deprecated
   *   (see {@link isTemperatureUnsupportedBody}).
   */
  private buildRequestBody(
    messages: ChatMessage[],
    opts: ChatOptions,
    model: string,
    stream: boolean,
    includeResponseFormat = true,
    includeTemperature = true,
    includeReasoningEffort = true,
    includeTools = false,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: this.formatMessages(messages, opts.systemMessage),
    };
    // #134 — OpenAI and Azure OpenAI take `max_completion_tokens`; their
    // reasoning models reject `max_tokens` outright. Every other runtime
    // (Ollama, vLLM, LM Studio, bedrock-access-gateway) keeps `max_tokens`,
    // byte-for-byte as before.
    const maxTokensField =
      this.key === "openai" || this.key === "azure" ? "max_completion_tokens" : "max_tokens";
    body[maxTokensField] = opts.maxTokens ?? this.defaultMaxTokens;
    if (includeTemperature) {
      body.temperature = opts.temperature ?? this.defaultTemperature;
    }
    // Optional OpenAI-spec sampling knobs. Each is sent ONLY when a value is
    // resolved (per-call override → provider default), so a provider that
    // doesn't configure them (e.g. Bedrock) keeps the gateway's own defaults
    // and its output is byte-for-byte unchanged. #116.
    const topP = opts.topP ?? this.defaultTopP;
    if (topP !== undefined) body.top_p = topP;
    const freqPenalty = opts.frequencyPenalty ?? this.defaultFrequencyPenalty;
    if (freqPenalty !== undefined) body.frequency_penalty = freqPenalty;
    const presPenalty = opts.presencePenalty ?? this.defaultPresencePenalty;
    if (presPenalty !== undefined) body.presence_penalty = presPenalty;
    const seed = opts.seed ?? this.defaultSeed;
    if (seed !== undefined) body.seed = seed;
    // Gemma 4 models enable thinking mode by default in Ollama. When thinking
    // is active the model spends its token budget on internal reasoning and
    // returns empty content. `think: false` disables it so the full max_tokens
    // budget goes to the actual response. Only sent when explicitly requested
    // (local-gemma path) — Bedrock and other gateways ignore unknown fields.
    Object.assign(body, this.thinkingFields(opts, includeReasoningEffort));
    // #336 — structured (schema-constrained) output. The caller (doc-gen
    // grounding on the local/vLLM path) opts in per-call by supplying
    // `responseFormat`; we forward it verbatim as the OpenAI-compatible
    // `response_format` field so a vLLM ≥ 0.8.5 (xgrammar/guidance backend) or
    // OpenAI runtime constrains decoding to the schema. Only sent when defined
    // AND not suppressed by the graceful-fallback retry — a provider whose
    // caller never sets it (Bedrock, Anthropic-via-gateway) is byte-for-byte
    // unchanged. A runtime that does not understand the field (some Ollama / LM
    // Studio builds) returns a 400/422 which `chat`/`stream` catch to retry
    // once WITHOUT it (see {@link isStructuredOutputUnsupportedStatus}).
    if (includeResponseFormat && opts.responseFormat) {
      body.response_format = opts.responseFormat;
    }
    // #132 — native tools. `includeTools` is false unless the caller supplied
    // tools AND this model may take them (see `shouldSendTools`).
    if (includeTools && opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (opts.toolChoice !== undefined) {
        body.tool_choice =
          typeof opts.toolChoice === "string"
            ? opts.toolChoice
            : { type: "function", function: { name: opts.toolChoice.name } };
      }
    }
    if (stream) {
      body.stream = true;
      // Required for accurate usage accounting when streaming.
      body.stream_options = { include_usage: true };
    }
    if (opts.promptCaching && (opts.promptCaching.system || opts.promptCaching.messages)) {
      body.extra_body = {
        prompt_caching: {
          ...(opts.promptCaching.system ? { system: true } : {}),
          ...(opts.promptCaching.messages ? { messages: true } : {}),
        },
      };
    }
    return body;
  }

  /**
   * The thinking-control fields for one request.
   *
   * Precedence on `local-gemma`: per-call `disableThinking` → per-call
   * `reasoningEffort` → the constructor's `disableThinking` → nothing (model
   * default). "Off" is `think: false` plus `reasoning_effort: "none"`, because
   * Ollama's `/v1` endpoint ignores `think` (measured, Ollama 0.34.2). Other
   * provider keys keep the pre-existing behaviour exactly: `think: false` from
   * the constructor flag only, and never `reasoning_effort` (which
   * bedrock-access-gateway would turn into Claude extended thinking).
   */
  private thinkingFields(
    opts: ChatOptions,
    includeReasoningEffort: boolean,
  ): Record<string, unknown> {
    if (this.key !== "local-gemma") {
      return this.disableThinking ? { think: false } : {};
    }
    const sendEffort = includeReasoningEffort && this.reasoningEffortMode !== "never";
    if (opts.disableThinking !== true && opts.reasoningEffort) {
      return sendEffort ? { reasoning_effort: opts.reasoningEffort } : {};
    }
    if (opts.disableThinking === true || this.disableThinking) {
      return sendEffort ? { think: false, reasoning_effort: "none" } : { think: false };
    }
    return {};
  }

  /** True when `body` carries `reasoning_effort` AND a rejection may be retried without it. */
  private canFallBackFromReasoningEffort(body: Record<string, unknown>): boolean {
    return body.reasoning_effort !== undefined && this.reasoningEffortMode === "auto";
  }

  /** #132 — remember that `model` rejects `tools` and log the one retry. */
  private noteToolsRejected(
    model: string,
    err: ToolsRejectedError,
    method: "chat" | "stream",
  ): void {
    this.toolsRejectedModels.add(model);
    log.warn("Runtime rejected tools; retrying once without them", {
      provider: this.key,
      method,
      model,
      status: err.status,
      cause: err.bodyExcerpt.slice(0, 200),
    });
  }

  /** #176 — memoise a structured-output 501 for `model`; a 400/422 is not memoised. */
  private noteStructuredOutputRejected(model: string, err: StructuredOutputRejectedError): void {
    if (isStructuredOutputUnavailableBody(err.status, err.bodyExcerpt)) {
      this.structuredOutputUnavailableModels.add(model);
    }
  }

  private noteReasoningEffortRejected(
    model: string,
    err: ReasoningEffortRejectedError,
    method: "chat" | "stream",
  ): void {
    this.reasoningEffortRejectedModels.add(model);
    log.warn("Runtime rejected reasoning_effort; retrying once without it", {
      provider: this.key,
      method,
      model,
      status: err.status,
      cause: err.bodyExcerpt.slice(0, 200),
      knob: LOCAL_REASONING_EFFORT_ENV,
    });
  }

  /**
   * Serialise the conversation. A plain message keeps the exact
   * `{ role, content }` shape it always had. #132 adds the two tool shapes:
   * an assistant turn that made calls carries `tool_calls` (arguments
   * re-serialised to the JSON string the wire format requires), and a `tool`
   * result carries the `tool_call_id` it answers.
   */
  private formatMessages(
    messages: ChatMessage[],
    systemMessage?: string,
  ): Array<Record<string, unknown>> {
    const formatted: Array<Record<string, unknown>> = [];
    if (systemMessage) {
      formatted.push({ role: "system", content: systemMessage });
    }
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
        const text = messageText(msg);
        formatted.push({
          role: "assistant",
          content: text.length > 0 ? text : null,
          tool_calls: msg.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: {
              name: c.name,
              arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}),
            },
          })),
        });
        continue;
      }
      if (msg.role === "tool" && msg.toolCallId) {
        formatted.push({ role: "tool", tool_call_id: msg.toolCallId, content: messageText(msg) });
        continue;
      }
      formatted.push({ role: msg.role, content: msg.content as string | ChatContentPart[] });
    }
    return formatted;
  }
}

/**
 * #132 — parse JSON tool-call arguments. Invalid JSON is kept as the raw string
 * so a malformed call is visible to the caller rather than silently becoming
 * `{}`; an empty string (a call with no arguments) becomes `{}`.
 */
function parseToolArgs(raw: string | undefined): unknown {
  if (raw == null || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** #132 — typed tool calls from a non-streamed message, in the order returned. */
function parseToolCalls(calls: OpenAIToolCall[] | undefined): ChatToolCall[] {
  if (!Array.isArray(calls)) return [];
  const out: ChatToolCall[] = [];
  calls.forEach((c, i) => {
    const name = c.function?.name;
    if (!name) return;
    out.push({ id: c.id ?? `call_${i}`, name, args: parseToolArgs(c.function?.arguments) });
  });
  return out;
}

/**
 * #132 — assembles streamed `delta.tool_calls` fragments. OpenAI-compatible
 * servers send each call's `id` and `function.name` on its first fragment and
 * then split `function.arguments` across any number of later ones, keyed by
 * `index` — several calls may interleave. Exported for direct unit testing.
 */
export class ToolCallDeltaAssembler {
  private readonly calls = new Map<number, { id?: string; name: string; args: string }>();

  push(deltas: OpenAIToolCallDelta[] | undefined): void {
    if (!Array.isArray(deltas)) return;
    for (const d of deltas) {
      const index = typeof d.index === "number" ? d.index : this.calls.size;
      const entry = this.calls.get(index) ?? { name: "", args: "" };
      if (d.id) entry.id = d.id;
      if (d.function?.name) entry.name += d.function.name;
      if (d.function?.arguments) entry.args += d.function.arguments;
      this.calls.set(index, entry);
    }
  }

  /** Emit every assembled call once, in index order, then reset. */
  *flush(): Generator<ChatChunk> {
    const ordered = [...this.calls.entries()].sort(([a], [b]) => a - b);
    this.calls.clear();
    for (const [index, c] of ordered) {
      if (!c.name) continue;
      yield {
        type: "tool_call",
        name: c.name,
        arguments: parseToolArgs(c.args),
        toolCallId: c.id ?? `call_${index}`,
        native: true,
      };
    }
  }
}

/**
 * Back-compat alias. The Bedrock interception in `server.ts`/`analysis.ts`
 * and the existing test suite import `BedrockDirectProvider`; keep the name
 * exported so the Bedrock path is byte-for-byte unbroken (#110).
 */
export { OpenAICompatibleProvider as BedrockDirectProvider };
