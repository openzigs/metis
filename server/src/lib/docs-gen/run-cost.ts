/**
 * #178 — the estimated cost of one document generation, logged when it ends.
 *
 * Every docs-gen model call that the usage tracker records (`recordUsage`) is
 * also added to the RUN it belongs to, found through an AsyncLocalStorage scope
 * opened by {@link withDocsGenRunCost}. Two documents generating at once keep
 * separate tallies, and a batch call running concurrently with its siblings is
 * still counted against its own run.
 *
 * Prices come from THE pricing source (`lib/finops/provider-rates.ts` via
 * `estimateUsageCostUsd`, which also reconciles the two cache-usage
 * conventions). Nothing is invented: a model METIS has no price for is listed
 * as unpriced and left out of the total, and a provider priced at zero is
 * reported as having no per-token price rather than as a run that cost $0 —
 * `self-hosted` for local-gemma, `zero-priced` for anything else priced at zero
 * (offline-stub, an admin price entry of 0), which is not
 * necessarily self-hosted.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createChildLogger } from "../logger.js";
import { estimateUsageCostUsd } from "../ai/token-tracker.js";
import type { UsageProvider } from "../ai/types.js";
import { resolveRate } from "../finops/provider-rates.js";

const log = createChildLogger("docs-gen-run-cost");

/** One recorded model call's token counts. */
export interface RunUsageEvent {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** The token totals of one provider + model within a run. */
export interface RunUsageLine {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Accumulates the token counts of one run, per provider + model. */
export class RunUsage {
  private readonly byModel = new Map<string, RunUsageLine>();

  add(event: RunUsageEvent): void {
    const key = `${event.provider}\u0000${event.model}`;
    const line = this.byModel.get(key) ?? {
      provider: event.provider,
      model: event.model,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    line.calls += 1;
    line.inputTokens += count(event.inputTokens);
    line.outputTokens += count(event.outputTokens);
    line.cacheReadTokens += count(event.cacheReadTokens);
    line.cacheWriteTokens += count(event.cacheWriteTokens);
    this.byModel.set(key, line);
  }

  lines(): RunUsageLine[] {
    return [...this.byModel.values()];
  }
}

const count = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;

/** A line of the estimate: its tokens and, when priced, its cost. */
export interface RunCostLine extends RunUsageLine {
  /**
   * `priced` — METIS has a per-token price; `unpriced` — it has none;
   * `self-hosted` — local-gemma, priced at zero per token, so there is no
   * per-token cost to report; `zero-priced` — any other provider whose
   * configured price is zero per token (offline-stub, an admin price entry
   * of 0).
   */
  pricing: "priced" | "unpriced" | "self-hosted" | "zero-priced";
  /** USD, for a priced line only. */
  costUsd: number | null;
}

/** The estimated cost of a run. */
export interface RunCostEstimate {
  lines: RunCostLine[];
  /** Sum of the priced lines, USD; `null` when no line is priced. */
  estimatedCostUsd: number | null;
  calls: number;
}

/** The provider key of the self-hosted (Ollama) provider. */
const SELF_HOSTED_PROVIDER = "local-gemma";

/** Price a run's usage from the configured per-token prices. */
export function estimateRunCost(usage: RunUsage): RunCostEstimate {
  const lines: RunCostLine[] = usage.lines().map((line) => {
    const rate = resolveRate(line.provider, line.model);
    if (!rate) return { ...line, pricing: "unpriced", costUsd: null };
    const free =
      rate.inputPer1k === 0 &&
      rate.outputPer1k === 0 &&
      !rate.cacheReadPer1k &&
      !rate.cacheWritePer1k;
    if (free) {
      const pricing = line.provider === SELF_HOSTED_PROVIDER ? "self-hosted" : "zero-priced";
      return { ...line, pricing, costUsd: null };
    }
    const costUsd = estimateUsageCostUsd(
      line.model,
      {
        promptTokens: line.inputTokens,
        completionTokens: line.outputTokens,
        cacheReadTokens: line.cacheReadTokens,
        cacheWriteTokens: line.cacheWriteTokens,
      },
      line.provider as UsageProvider,
    );
    return costUsd === null
      ? { ...line, pricing: "unpriced", costUsd: null }
      : { ...line, pricing: "priced", costUsd };
  });
  const priced = lines.filter((l) => l.pricing === "priced");
  return {
    lines,
    estimatedCostUsd:
      priced.length > 0 ? priced.reduce((sum, l) => sum + (l.costUsd ?? 0), 0) : null,
    calls: lines.reduce((n, l) => n + l.calls, 0),
  };
}

const store = new AsyncLocalStorage<RunUsage>();

/** Run `fn` with every usage noted inside it (and its async work) added to `usage`. */
export function withRunUsage<T>(usage: RunUsage, fn: () => Promise<T>): Promise<T> {
  return store.run(usage, fn);
}

/** Add a recorded model call to the run it belongs to (no-op outside a run). */
export function noteRunUsage(event: RunUsageEvent): void {
  store.getStore()?.add(event);
}

const usd = (n: number): number => Math.round(n * 10_000) / 10_000;
const label = (l: RunUsageLine): string => `${l.provider}/${l.model}`;

/** Log a run's estimate — or, when nothing is priced, why there is none. */
export function logRunCost(
  context: { projectId: string; docType: string; outcome: "completed" | "failed" },
  usage: RunUsage,
): RunCostEstimate {
  const estimate = estimateRunCost(usage);
  const totals = estimate.lines.reduce(
    (t, l) => ({
      inputTokens: t.inputTokens + l.inputTokens,
      outputTokens: t.outputTokens + l.outputTokens,
      cacheReadTokens: t.cacheReadTokens + l.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens + l.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
  const unpriced = estimate.lines.filter((l) => l.pricing === "unpriced").map(label);
  const selfHosted = estimate.lines.filter((l) => l.pricing === "self-hosted").map(label);
  const zeroPriced = estimate.lines.filter((l) => l.pricing === "zero-priced").map(label);
  const base = { ...context, calls: estimate.calls, ...totals };
  if (estimate.estimatedCostUsd === null) {
    log.info("Docs-gen run cost not estimated", {
      ...base,
      note:
        estimate.calls === 0
          ? "no model calls were recorded for this run"
          : [
              selfHosted.length
                ? `no per-token price for self-hosted ${selfHosted.join(", ")}`
                : "",
              zeroPriced.length
                ? `configured per-token price is zero for ${zeroPriced.join(", ")}`
                : "",
              unpriced.length ? `no configured price for ${unpriced.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("; "),
    });
    return estimate;
  }
  log.info("Docs-gen estimated run cost", {
    ...base,
    estimatedCostUsd: usd(estimate.estimatedCostUsd),
    byModel: estimate.lines
      .filter((l) => l.pricing === "priced")
      .map((l) => ({ model: label(l), calls: l.calls, costUsd: usd(l.costUsd ?? 0) })),
    // Calls left out of the total, so a partial estimate says it is partial.
    ...(unpriced.length ? { unpricedModels: unpriced } : {}),
    ...(selfHosted.length ? { selfHostedModels: selfHosted } : {}),
    ...(zeroPriced.length ? { zeroPricedModels: zeroPriced } : {}),
    // Only the calls the usage tracker records are counted.
    scope:
      "calls recorded by the usage tracker: Phase-1 facts and Phase-2 sections (grounding calls are not recorded yet, #180)",
  });
  return estimate;
}

/**
 * Run `fn` as one docs-gen run: every usage noted inside it is tallied, and
 * the estimate is logged when it settles (on failure too — a failed run still
 * spent what it spent).
 */
export async function withDocsGenRunCost<T>(
  context: { projectId: string; docType: string },
  fn: () => Promise<T>,
): Promise<T> {
  const usage = new RunUsage();
  let outcome: "completed" | "failed" = "failed";
  try {
    const result = await withRunUsage(usage, fn);
    outcome = "completed";
    return result;
  } finally {
    try {
      logRunCost({ ...context, outcome }, usage);
    } catch (err) {
      // Cost reporting must never change a run's outcome.
      log.warn("Docs-gen run cost could not be estimated", { err: String(err) });
    }
  }
}
