/**
 * Reliable structured verdicts across providers — retry once, then degrade
 * (#1114, epic #1107).
 *
 * ## The problem this exists to solve
 *
 * The adversarial verifier panel (#1109) puts roughly three extra LLM calls on
 * every finding — ~135 calls on a 45-finding run — and each one must come back
 * as a parseable verdict. Today's analysis path obtains JSON with
 * {@link extractJsonObject} and a HARD THROW on failure
 * (`agent-runner.ts`). That is survivable for five agents per run and is not
 * survivable at 135 calls: a 2% malformation rate is ~3 fatal errors per run,
 * and one throw currently takes the whole call with it.
 *
 * ## Why not just use `responseFormat`
 *
 * Because verification quality must not be a function of which provider is
 * configured. #1115 pinned the truth: only `OpenAICompatibleProvider` /
 * `BedrockDirectProvider` forward `response_format`; the `anthropic` adapter
 * (the currently configured one), the Copilot SDK — in NEITHER 0.2.2 nor 1.0.8
 * — and the offline/replay stubs all drop it. So `responseFormat` is used here
 * strictly as an OPTIMISATION, probed through {@link supportsResponseFormat},
 * and the portable path is parse-and-retry.
 *
 * (The epic also floats a forced `StructuredOutput` tool call as the portable
 * mechanism. That is genuinely better, but METIS's `ChatOptions` has no `tools`
 * field at all — tools live in the application layer (`analysis/agent-loop`) —
 * so putting tools on the provider interface is its own piece of work, out of
 * scope here. See the PR discussion on #1114.)
 *
 * ## Retry, then degrade — and why degrading is the whole point
 *
 * ```
 *   attempt 1  → parse → validate → verdict
 *      ↓ malformed
 *   attempt 2  → re-prompt with the parse error + the expected shape
 *      ↓ malformed
 *   NO SIGNAL  (never a negative verdict)
 * ```
 *
 * METIS is recall-first, and that applies to the verifier's own failures too. A
 * verifier that could not produce a verdict has told us NOTHING about the
 * finding; it must never be allowed to look like evidence against it. So the
 * return type is a DISCRIMINATED UNION, not a nullable boolean: the degraded
 * branch {@link StructuredVerdictNoSignal} carries no `verdict` field at all,
 * so a consumer cannot read `false` out of a failure even by accident. "No
 * signal" and "negative signal" stay distinct by construction, all the way
 * through to A2's presentation (#1110).
 *
 * A provider error degrades the same way rather than retrying — a transport
 * failure is not malformation, the adapters already do their own transport
 * retries, and one dead call must not fail a 135-call run. Cancellation is the
 * ONE thing that still throws: an aborted run must stop, not quietly produce
 * 135 "no signal" results.
 *
 * ## Measuring instead of assuming
 *
 * The issue asks for the real malformation/retry rate rather than a guess, so
 * every call is accumulated into {@link StructuredVerdictMetrics} — in-process,
 * dependency-free, bucketed by a caller-supplied label (one per lens). The A5
 * harness (#1108) prints it via {@link formatStructuredVerdictReport}.
 */
import type { ZodType } from "zod";
import { supportsResponseFormat } from "../ai/capabilities.js";
import type {
  AIProvider,
  CacheTelemetryCallType,
  ChatMessage,
  ChatOptions,
  JsonSchemaResponseFormat,
  TokenUsage,
} from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";

const log = createChildLogger("analysis-structured-verdict");

/**
 * One initial call plus at most ONE re-prompt. Deliberately a constant and not
 * an option: "retry once, then degrade" is the contract the panel's cost model
 * is built on, and a knob here would let a caller turn ~135 calls into ~405.
 */
export const MAX_STRUCTURED_VERDICT_ATTEMPTS = 2;

/** Longest slice of a malformed body echoed back to the model (and never logged whole). */
const MAX_ECHOED_BODY_CHARS = 2_000;
/** Longest slice of a malformed body written to the log. */
const MAX_LOGGED_BODY_CHARS = 500;

/** Why a verifier call produced no signal. Every value means "we learned nothing". */
export type NoVerdictReason =
  /** Two responses in a row contained no JSON object at all. */
  | "unparseable"
  /** Two responses in a row parsed as JSON but failed the schema. */
  | "schema-invalid"
  /** The model returned nothing (blank/whitespace) twice. */
  | "empty-response"
  /** The provider call itself failed (transport, upstream 5xx, quota). */
  | "provider-error";

/** Facts about HOW the outcome was obtained — present on both branches. */
export interface StructuredVerdictTelemetry {
  /** Provider calls made, 1..{@link MAX_STRUCTURED_VERDICT_ATTEMPTS}. */
  attempts: number;
  /** `true` when a re-prompt was issued (i.e. `attempts > 1`). */
  retried: boolean;
  /** `true` when `responseFormat` was both supplied AND honoured by this provider. */
  usedResponseFormat: boolean;
  /** Tokens summed across every attempt — a retry is not free and is billed here. */
  usage: TokenUsage;
  durationMs: number;
}

/** The verifier produced a verdict that validated against the caller's schema. */
export interface StructuredVerdictSignal<T> extends StructuredVerdictTelemetry {
  status: "verdict";
  verdict: T;
}

/**
 * The verifier could NOT produce a verdict. This is the absence of evidence,
 * never evidence of absence — consumers must present and tally it distinctly
 * from a negative verdict, and there is deliberately no `verdict` field to
 * misread.
 */
export interface StructuredVerdictNoSignal extends StructuredVerdictTelemetry {
  status: "no-signal";
  reason: NoVerdictReason;
  /** Human-readable cause (parse error / schema issues / provider message). */
  detail: string;
}

/** The only two things a verifier call can yield. */
export type StructuredVerdictOutcome<T> = StructuredVerdictSignal<T> | StructuredVerdictNoSignal;

/** Narrow to the branch that actually carries a verdict. */
export function hasVerdict<T>(
  outcome: StructuredVerdictOutcome<T>,
): outcome is StructuredVerdictSignal<T> {
  return outcome.status === "verdict";
}

/** Narrow to the degraded branch. Equivalent to `!hasVerdict(outcome)`. */
export function isNoSignal<T>(
  outcome: StructuredVerdictOutcome<T>,
): outcome is StructuredVerdictNoSignal {
  return outcome.status === "no-signal";
}

export interface StructuredVerdictRequest<T> {
  /**
   * Metrics bucket — one per verifier lens (`"reachability"`, `"impact"`,
   * `"defenses"`), so a lens whose prompt produces malformed output is
   * attributable rather than averaged away.
   */
  label: string;
  /** Zod schema the parsed object must satisfy. Its output type is the verdict. */
  schema: ZodType<T>;
  /** Schema name quoted in the repair prompt so the model knows what it owes. */
  schemaName: string;
  /** The expected shape, rendered for the model, e.g. `{ "supported": boolean }`. */
  expectedShape: string;
  messages: ChatMessage[];
  systemMessage?: string;
  model?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  callType?: CacheTelemetryCallType;
  /**
   * Used ONLY when the active provider declares `responseFormat` support
   * (#1115). Supplying it to a provider that drops it would be a silent no-op,
   * so this helper omits it there rather than passing it and hoping.
   */
  responseFormat?: JsonSchemaResponseFormat;
  /** Metrics sink. Defaults to the process-wide {@link structuredVerdictMetrics}. */
  metrics?: StructuredVerdictMetrics;
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const addUsage = (a: TokenUsage, b: TokenUsage | undefined): TokenUsage => {
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + (b.promptTokens ?? 0),
    completionTokens: a.completionTokens + (b.completionTokens ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
};

/**
 * Deliberately name-only. Matching on the MESSAGE would misread an upstream
 * "connection aborted" transport error as user cancellation and rethrow it,
 * failing the run this module exists to keep alive.
 */
const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

/** Truncate a malformed body for echoing/logging, marking the cut so the model knows. */
const clip = (raw: string, max: number): string =>
  raw.length <= max ? raw : `${raw.slice(0, max)}\n…[truncated ${raw.length - max} chars]`;

interface AttemptFailure {
  reason: Exclude<NoVerdictReason, "provider-error">;
  detail: string;
}

/** Parse + validate one response body. Returns the verdict or a typed failure. */
function parseVerdict<T>(
  raw: string,
  schema: ZodType<T>,
): { ok: true; value: T } | { ok: false; failure: AttemptFailure } {
  if (raw.trim().length === 0) {
    return { ok: false, failure: { reason: "empty-response", detail: "response was empty" } };
  }
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch (err) {
    return { ok: false, failure: { reason: "unparseable", detail: (err as Error).message } };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  const detail = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  return { ok: false, failure: { reason: "schema-invalid", detail } };
}

/**
 * The re-prompt. It tells the model three things it did not have the first
 * time: that its output failed, WHY it failed, and exactly what shape is owed.
 * The model's own bad output is replayed as an assistant turn so the correction
 * is anchored to it.
 */
function buildRepairTurns(
  raw: string,
  failure: AttemptFailure,
  schemaName: string,
  expectedShape: string,
): ChatMessage[] {
  return [
    { role: "assistant", content: clip(raw, MAX_ECHOED_BODY_CHARS) },
    {
      role: "user",
      content: [
        `Your previous response could not be parsed as the required ${schemaName} JSON object.`,
        `Error: ${failure.detail}`,
        "",
        "Reply with ONE JSON object and nothing else — no prose, no explanation, no Markdown fences.",
        "Expected shape:",
        expectedShape,
      ].join("\n"),
    },
  ];
}

/**
 * Obtain a schema-validated verdict from `provider`, re-prompting once on
 * malformation and degrading to {@link StructuredVerdictNoSignal} rather than
 * throwing.
 *
 * Throws ONLY on cancellation. Every other failure mode — unparseable output,
 * schema violation, provider error — comes back as `status: "no-signal"`, which
 * the caller must count as *no evidence*, never as a vote against the finding.
 *
 * @example
 * const outcome = await requestStructuredVerdict(provider, {
 *   label: "reachability",
 *   schema: lensVerdictSchema,
 *   schemaName: "LensVerdict",
 *   expectedShape: '{ "supported": boolean, "rationale": string }',
 *   messages: [{ role: "user", content: prompt }],
 * });
 * if (hasVerdict(outcome)) tally.add(outcome.verdict);
 * else tally.noSignal(outcome.reason);   // cannot be mistaken for a "no" vote
 */
export async function requestStructuredVerdict<T>(
  provider: AIProvider,
  request: StructuredVerdictRequest<T>,
): Promise<StructuredVerdictOutcome<T>> {
  const started = Date.now();
  if (request.signal?.aborted) {
    throw new DOMException("Aborted before start", "AbortError");
  }

  const metrics = request.metrics ?? structuredVerdictMetrics;
  const usedResponseFormat = Boolean(request.responseFormat) && supportsResponseFormat(provider);
  const opts: ChatOptions = {
    ...(request.systemMessage ? { systemMessage: request.systemMessage } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.maxTokens ? { maxTokens: request.maxTokens } : {}),
    ...(request.callType ? { callType: request.callType } : {}),
    ...(usedResponseFormat ? { responseFormat: request.responseFormat } : {}),
  };

  let messages = request.messages;
  let usage = ZERO_USAGE;
  let attempts = 0;
  let malformedAttempts = 0;
  let lastFailure: AttemptFailure = { reason: "unparseable", detail: "no attempt was made" };

  const finish = (
    outcome: StructuredVerdictOutcome<T>,
    sample: Omit<StructuredVerdictSample, "label">,
  ): StructuredVerdictOutcome<T> => {
    metrics.record({ label: request.label, ...sample });
    return outcome;
  };

  while (attempts < MAX_STRUCTURED_VERDICT_ATTEMPTS) {
    attempts += 1;
    let content: string;
    try {
      const response = await provider.chat(messages, opts);
      usage = addUsage(usage, response.usage);
      content = response.content;
    } catch (err) {
      // Cancellation is the one failure that must still propagate: an aborted
      // run should stop, not manufacture a run's worth of "no signal".
      if (isAbortError(err) || request.signal?.aborted) throw err;
      const detail = (err as Error).message;
      log.warn("Structured verdict provider call failed — degrading to no signal", {
        label: request.label,
        attempt: attempts,
        provider: provider.key,
        error: detail,
      });
      return finish(
        {
          status: "no-signal",
          reason: "provider-error",
          detail,
          attempts,
          retried: attempts > 1,
          usedResponseFormat,
          usage,
          durationMs: Date.now() - started,
        },
        {
          attempts,
          malformedAttempts,
          retried: attempts > 1,
          retrySucceeded: false,
          usedResponseFormat,
          outcome: "no-signal",
          providerError: true,
        },
      );
    }

    const parsed = parseVerdict(content, request.schema);
    if (parsed.ok) {
      return finish(
        {
          status: "verdict",
          verdict: parsed.value,
          attempts,
          retried: attempts > 1,
          usedResponseFormat,
          usage,
          durationMs: Date.now() - started,
        },
        {
          attempts,
          malformedAttempts,
          retried: attempts > 1,
          retrySucceeded: attempts > 1,
          usedResponseFormat,
          outcome: "verdict",
          providerError: false,
        },
      );
    }

    malformedAttempts += 1;
    lastFailure = parsed.failure;
    if (attempts < MAX_STRUCTURED_VERDICT_ATTEMPTS) {
      log.warn("Structured verdict malformed — re-prompting once", {
        label: request.label,
        attempt: attempts,
        provider: provider.key,
        reason: parsed.failure.reason,
        error: parsed.failure.detail,
        contentLength: content.length,
        contentPreview: clip(content, MAX_LOGGED_BODY_CHARS),
      });
      messages = [
        ...request.messages,
        ...buildRepairTurns(content, parsed.failure, request.schemaName, request.expectedShape),
      ];
    } else {
      log.warn("Structured verdict still malformed after one re-prompt — no signal", {
        label: request.label,
        attempts,
        provider: provider.key,
        reason: parsed.failure.reason,
        error: parsed.failure.detail,
        contentPreview: clip(content, MAX_LOGGED_BODY_CHARS),
      });
    }
  }

  return finish(
    {
      status: "no-signal",
      reason: lastFailure.reason,
      detail: lastFailure.detail,
      attempts,
      retried: attempts > 1,
      usedResponseFormat,
      usage,
      durationMs: Date.now() - started,
    },
    {
      attempts,
      malformedAttempts,
      retried: attempts > 1,
      retrySucceeded: false,
      usedResponseFormat,
      outcome: "no-signal",
      providerError: false,
    },
  );
}

// ── Metrics ────────────────────────────────────────────────────────────────

/** One completed call, as accumulated by {@link StructuredVerdictMetrics}. */
export interface StructuredVerdictSample {
  label: string;
  attempts: number;
  malformedAttempts: number;
  retried: boolean;
  retrySucceeded: boolean;
  usedResponseFormat: boolean;
  outcome: "verdict" | "no-signal";
  providerError: boolean;
}

/** Rolling totals for one label (or `"all"` from {@link StructuredVerdictMetrics.totals}). */
export interface StructuredVerdictStats {
  label: string;
  /** Verifier calls made (NOT provider calls — a retried call counts once). */
  calls: number;
  /** Provider calls made, i.e. `calls + retries`. */
  attempts: number;
  /** Attempts whose body failed to parse or validate. */
  malformedAttempts: number;
  /** Calls that issued a re-prompt. */
  retries: number;
  /** Re-prompts that then produced a valid verdict. */
  retrySuccesses: number;
  /** Calls that ended with no signal. */
  noSignal: number;
  /** Calls that ended with no signal because the provider call itself failed. */
  providerErrors: number;
  /** Calls that actually sent `responseFormat` (provider declared support). */
  responseFormatCalls: number;
  /** `malformedAttempts / attempts` — THE number #1114 exists to measure. */
  malformationRate: number;
  /** `retries / calls`. */
  retryRate: number;
  /** `retrySuccesses / retries` — how much the re-prompt actually buys. */
  retrySuccessRate: number;
  /** `noSignal / calls` — the share of findings a lens could not judge. */
  noSignalRate: number;
}

interface Bucket {
  calls: number;
  attempts: number;
  malformedAttempts: number;
  retries: number;
  retrySuccesses: number;
  noSignal: number;
  providerErrors: number;
  responseFormatCalls: number;
}

const emptyBucket = (): Bucket => ({
  calls: 0,
  attempts: 0,
  malformedAttempts: 0,
  retries: 0,
  retrySuccesses: 0,
  noSignal: 0,
  providerErrors: 0,
  responseFormatCalls: 0,
});

const rate = (numerator: number, denominator: number): number =>
  denominator > 0 ? numerator / denominator : 0;

const toStats = (label: string, b: Bucket): StructuredVerdictStats => ({
  label,
  calls: b.calls,
  attempts: b.attempts,
  malformedAttempts: b.malformedAttempts,
  retries: b.retries,
  retrySuccesses: b.retrySuccesses,
  noSignal: b.noSignal,
  providerErrors: b.providerErrors,
  responseFormatCalls: b.responseFormatCalls,
  malformationRate: rate(b.malformedAttempts, b.attempts),
  retryRate: rate(b.retries, b.calls),
  retrySuccessRate: rate(b.retrySuccesses, b.retries),
  noSignalRate: rate(b.noSignal, b.calls),
});

/**
 * In-process, dependency-free accumulator of verifier reliability. No timer, no
 * I/O, no external backend — a plain map, safe to hold for the process
 * lifetime. Injectable so the A5 harness (#1108) and tests can measure a single
 * run in isolation instead of sharing process-wide state.
 */
export class StructuredVerdictMetrics {
  private readonly buckets = new Map<string, Bucket>();

  record(sample: StructuredVerdictSample): void {
    let bucket = this.buckets.get(sample.label);
    if (!bucket) {
      bucket = emptyBucket();
      this.buckets.set(sample.label, bucket);
    }
    bucket.calls += 1;
    bucket.attempts += sample.attempts;
    bucket.malformedAttempts += sample.malformedAttempts;
    if (sample.retried) bucket.retries += 1;
    if (sample.retrySucceeded) bucket.retrySuccesses += 1;
    if (sample.outcome === "no-signal") bucket.noSignal += 1;
    if (sample.providerError) bucket.providerErrors += 1;
    if (sample.usedResponseFormat) bucket.responseFormatCalls += 1;
  }

  /** Stats for one label, or `undefined` if that label has recorded nothing. */
  snapshot(label: string): StructuredVerdictStats | undefined {
    const bucket = this.buckets.get(label);
    return bucket ? toStats(label, bucket) : undefined;
  }

  /** Stats for every label seen, in insertion order. */
  allSnapshots(): StructuredVerdictStats[] {
    return [...this.buckets.entries()].map(([label, bucket]) => toStats(label, bucket));
  }

  /** Every label folded into one row, labelled `"all"`. Zeroed (never NaN) when empty. */
  totals(): StructuredVerdictStats {
    const total = emptyBucket();
    for (const bucket of this.buckets.values()) {
      total.calls += bucket.calls;
      total.attempts += bucket.attempts;
      total.malformedAttempts += bucket.malformedAttempts;
      total.retries += bucket.retries;
      total.retrySuccesses += bucket.retrySuccesses;
      total.noSignal += bucket.noSignal;
      total.providerErrors += bucket.providerErrors;
      total.responseFormatCalls += bucket.responseFormatCalls;
    }
    return toStats("all", total);
  }

  reset(): void {
    this.buckets.clear();
  }
}

/** Process-wide default sink, used when a caller injects no metrics object. */
export const structuredVerdictMetrics = new StructuredVerdictMetrics();

/** Clear the process-wide sink (tests, and between harness runs). */
export function resetStructuredVerdictMetrics(): void {
  structuredVerdictMetrics.reset();
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/**
 * Render the reliability table for the A5 harness (#1108), so the real
 * malformation/retry rate is reported rather than assumed.
 */
export function formatStructuredVerdictReport(
  metrics: StructuredVerdictMetrics = structuredVerdictMetrics,
): string {
  const rows = [...metrics.allSnapshots(), metrics.totals()];
  const totals = rows[rows.length - 1]!;
  if (totals.calls === 0) return "structured verdicts: no structured-verdict calls recorded";
  const lines = [
    "structured verdicts (label · calls · attempts · malformation · retry · retry-success · no-signal)",
  ];
  for (const r of rows) {
    lines.push(
      [
        `  ${r.label}`,
        `calls=${r.calls}`,
        `attempts=${r.attempts}`,
        `malformation=${pct(r.malformationRate)}`,
        `retry=${pct(r.retryRate)}`,
        `retry-success=${pct(r.retrySuccessRate)}`,
        `no-signal=${pct(r.noSignalRate)}`,
        `responseFormat=${r.responseFormatCalls}`,
      ].join(" · "),
    );
  }
  return lines.join("\n");
}
