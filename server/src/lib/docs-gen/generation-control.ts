/**
 * #855 — stopping a documentation generation that is spending money.
 *
 * In #706 run 3 a BRD generation ran for 81.7 minutes on its second attempt
 * (2h51m and $8.33 over both) and nothing in METIS could stop it: there was no
 * cancel, and `DELETE` only fenced the final commit while the model calls kept
 * running. The only way out was a server restart.
 *
 * A run now holds a {@link GenerationControl}: an `AbortController` registered
 * by document id, so a cancel or delete handled by this process aborts it
 * immediately, plus the run's own cost ceiling. Every docs-gen provider is
 * wrapped ({@link scopedToGeneration}) so each call it makes carries the run's
 * `AbortSignal`, which aborts an in-flight request rather than waiting for it.
 * A call cut off that way reported no usage, so the wrapper records an
 * ESTIMATE of what it spent (agent step {@link ABORTED_CALL_AGENT_STEP}): the
 * provider bills a cancelled request too.
 *
 * Another replica's run is reached through the database instead: the cancel
 * route marks the row `cancelling`, and the run's heartbeat notices (see
 * `interrupted-generations.ts`).
 */
import { createChildLogger } from "../logger.js";
import { recordUsage } from "../finops/index.js";
import { getConfigService, type ConfigService } from "../config/config-service.js";
import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import { RunUsage, estimateRunCost, type RunUsageEvent } from "./run-cost.js";
import { UnpublishableGenerationError, type UnpublishableReason } from "./generation-checkpoint.js";
import { currentGenerationScope, type GenerationScope } from "./generation-scope.js";

const log = createChildLogger("docs-gen-control");

/** Registry key: the most one docs-gen run may spend, in US cents (0 = no ceiling). */
export const MAX_RUN_COST_CENTS_KEY = "DOCS_GEN_MAX_RUN_COST_CENTS";
/** Registry key: the most input + output tokens one run may use (0 = no ceiling). */
export const MAX_RUN_TOKENS_KEY = "DOCS_GEN_MAX_RUN_TOKENS";
/**
 * $25. Run 3's BRD cost $4.61 and $3.69 per attempt on DeepSeek; the same run
 * on a Sonnet-class model would be several times that, and is exactly the run
 * an operator wants stopped rather than discovered on the invoice.
 */
export const DEFAULT_MAX_RUN_COST_CENTS = 2_500;
/**
 * 20M tokens, 2.5x run 3's first BRD attempt (4.30M in + 2.76M out + 0.81M
 * cache). The token ceiling is what bounds a model METIS has no price for, or
 * one priced at zero (a self-hosted model still costs hours of GPU time).
 */
export const DEFAULT_MAX_RUN_TOKENS = 20_000_000;

/** Agent step of a usage row ESTIMATED for a call the run aborted mid-flight. */
export const ABORTED_CALL_AGENT_STEP = "docs-gen-aborted";
/** Characters per token for the estimate — the same conservative ratio section batching uses. */
const ESTIMATE_CHARS_PER_TOKEN = 3.5;

export interface RunCeiling {
  /** US cents; `null` = no cost ceiling. */
  maxCostCents: number | null;
  /** Input + output tokens; `null` = no token ceiling. */
  maxTokens: number | null;
}

/** The configured run ceiling. A missing or non-numeric value is the default; `0` turns a ceiling off. */
export function resolveRunCeiling(config: ConfigService = getConfigService()): RunCeiling {
  const read = (key: string, fallback: number): number | null => {
    const raw = config.getNumber(key, fallback);
    if (!Number.isFinite(raw) || raw < 0) return fallback;
    return raw === 0 ? null : Math.floor(raw);
  };
  return {
    maxCostCents: read(MAX_RUN_COST_CENTS_KEY, DEFAULT_MAX_RUN_COST_CENTS),
    maxTokens: read(MAX_RUN_TOKENS_KEY, DEFAULT_MAX_RUN_TOKENS),
  };
}

const STOP_TEXT: Readonly<Record<UnpublishableReason, string>> = {
  aborted: "Generation cancelled",
  budget: "Generation reached its cost ceiling",
  superseded: "Generation superseded or deleted",
  "inputs-changed": "Generation inputs changed",
};

/** One generation's stop switch, spend tally and ceiling. */
export class GenerationControl implements GenerationScope {
  private readonly controller = new AbortController();
  private stopped: UnpublishableGenerationError | null = null;
  private readonly usage = new RunUsage();

  constructor(
    readonly docId: string,
    readonly projectId: string,
    readonly ceiling: RunCeiling = { maxCostCents: null, maxTokens: null },
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The reason the run was stopped, once it has been. */
  get reason(): UnpublishableReason | null {
    return this.stopped?.reason ?? null;
  }

  stopError(): UnpublishableGenerationError | null {
    return this.stopped;
  }

  /** Stop the run. The first reason wins; later calls are no-ops. */
  stop(reason: UnpublishableReason): void {
    if (this.stopped) return;
    this.stopped = new UnpublishableGenerationError(reason, STOP_TEXT[reason]);
    this.controller.abort(this.stopped);
  }

  /** Tokens and estimated cost recorded so far. */
  spend(): { tokens: number; costCents: number | null } {
    const estimate = estimateRunCost(this.usage);
    const tokens = estimate.lines.reduce((n, l) => n + l.inputTokens + l.outputTokens, 0);
    return {
      tokens,
      costCents: estimate.estimatedCostUsd === null ? null : estimate.estimatedCostUsd * 100,
    };
  }

  noteSpend(event: RunUsageEvent): void {
    this.usage.add(event);
    if (this.stopped) return;
    const { maxCostCents, maxTokens } = this.ceiling;
    if (maxCostCents === null && maxTokens === null) return;
    const { tokens, costCents } = this.spend();
    const overTokens = maxTokens !== null && tokens >= maxTokens;
    const overCost = maxCostCents !== null && costCents !== null && costCents >= maxCostCents;
    if (!overTokens && !overCost) return;
    log.warn("Docs-gen run reached its ceiling; stopping it", {
      docId: this.docId,
      projectId: this.projectId,
      tokens,
      costCents: costCents === null ? null : Math.round(costCents),
      maxTokens,
      maxCostCents,
    });
    this.stop("budget");
  }
}

// Every live run in this process, by document id. A Set per id: a run that
// lost its claim may still be winding down when the next one starts.
const live = new Map<string, Set<GenerationControl>>();

/** Create and register the control for a run that has just claimed `docId`. */
export function startGenerationControl(
  docId: string,
  projectId: string,
  ceiling: RunCeiling = resolveRunCeiling(),
): GenerationControl {
  const control = new GenerationControl(docId, projectId, ceiling);
  const set = live.get(docId) ?? new Set<GenerationControl>();
  set.add(control);
  live.set(docId, set);
  return control;
}

/** Forget a finished run. */
export function releaseGenerationControl(control: GenerationControl): void {
  const set = live.get(control.docId);
  if (!set) return;
  set.delete(control);
  if (set.size === 0) live.delete(control.docId);
}

/**
 * Stop every run of `docId` in THIS process. Returns how many were stopped;
 * 0 means the run (if any) lives in another process, which its heartbeat
 * reaches instead.
 */
export function stopGeneration(docId: string, reason: UnpublishableReason): number {
  const set = live.get(docId);
  if (!set) return 0;
  for (const control of set) control.stop(reason);
  return set.size;
}

function contentChars(messages: readonly ChatMessage[]): number {
  return messages.reduce(
    (n, m) =>
      n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
    0,
  );
}

const tokensOf = (chars: number): number => Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN);

/**
 * Record what a call the run aborted mid-flight spent: its reported usage when
 * the provider sent one before the abort, otherwise an estimate from the
 * prompt and the reply streamed so far. Never throws.
 */
function recordAbortedCall(
  scope: GenerationScope,
  provider: AIProvider,
  messages: readonly ChatMessage[],
  opts: ChatOptions | undefined,
  seen: { usage?: Extract<ChatChunk, { type: "usage" }>["usage"]; outputChars: number },
): void {
  try {
    const model = opts?.model ?? provider.model;
    recordUsage({
      projectId: scope.projectId,
      sessionId: opts?.sessionId ?? `docs-aborted-${scope.docId}`,
      agentStep: ABORTED_CALL_AGENT_STEP,
      provider: provider.key,
      model,
      inputTokens: seen.usage?.promptTokens ?? tokensOf(contentChars(messages)),
      outputTokens: seen.usage?.completionTokens ?? tokensOf(seen.outputChars),
      cacheReadTokens: seen.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: seen.usage?.cacheWriteTokens ?? 0,
    });
  } catch (err) {
    log.warn("Could not record an aborted docs-gen call's usage", { err: String(err) });
  }
}

function withSignal(opts: ChatOptions | undefined, signal: AbortSignal): ChatOptions {
  return {
    ...opts,
    signal: opts?.signal ? AbortSignal.any([opts.signal, signal]) : signal,
  };
}

/**
 * The provider, with every `chat` and `stream` call made inside a generation
 * scope carrying that run's `AbortSignal`. Outside a scope a call is passed
 * through untouched. A stopped run's next call fails at once with the run's
 * stop error instead of reaching the provider.
 */
export function scopedToGeneration(provider: AIProvider): AIProvider {
  const chat = (messages: ChatMessage[], opts?: ChatOptions): ReturnType<AIProvider["chat"]> => {
    const scope = currentGenerationScope();
    if (!scope) return provider.chat(messages, opts);
    const stopped = scope.stopError();
    if (stopped) return Promise.reject(stopped);
    return provider.chat(messages, withSignal(opts, scope.signal)).catch((err: unknown) => {
      if (scope.signal.aborted)
        recordAbortedCall(scope, provider, messages, opts, { outputChars: 0 });
      throw err;
    });
  };
  const stream = (messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatChunk> => {
    const scope = currentGenerationScope();
    if (!scope) return provider.stream(messages, opts);
    return (async function* guarded(): AsyncGenerator<ChatChunk> {
      const stopped = scope.stopError();
      if (stopped) throw stopped;
      const seen: Parameters<typeof recordAbortedCall>[4] = { outputChars: 0 };
      try {
        for await (const chunk of provider.stream(messages, withSignal(opts, scope.signal))) {
          if (chunk.type === "delta") seen.outputChars += chunk.content.length;
          else if (chunk.type === "usage") seen.usage = chunk.usage;
          yield chunk;
        }
      } catch (err) {
        if (scope.signal.aborted) recordAbortedCall(scope, provider, messages, opts, seen);
        throw err;
      }
    })();
  };
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "chat") return chat;
      if (prop === "stream") return stream;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
