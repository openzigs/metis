/**
 * Token tracker (Phase 4 / issue #33).
 *
 * In-memory aggregation per-session AND durable per-event persistence to the
 * `AITokenUsage` Prisma table. Aggregates roll up to per-user/per-day via the
 * `dayBucket` column for fast dashboard queries.
 *
 * The tracker is intentionally non-blocking: `record()` returns immediately
 * and the Prisma insert runs on a microtask. Failures are logged but never
 * surface to the caller — token accounting must never crash a chat run.
 */
import crypto from "node:crypto";
import { conventionForProvider, normalizeTokenUsage } from "./cache-verification.js";
import { resolveAnthropicCacheTtl, type PromptCacheTtl } from "./prompt-cache-ttl.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  computeCostCentsExact,
  familyPricePerMTok,
  resolveRate,
} from "../finops/provider-rates.js";
import type { ProviderKey, TokenUsage } from "./types.js";

const log = createChildLogger("ai-token-tracker");

const MAX_INT = Number.MAX_SAFE_INTEGER;

const sanitize = (n: unknown): number => {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  // Integer overflow / negative-protection — cap at MAX_SAFE_INTEGER, floor at 0.
  return Math.min(Math.max(0, Math.trunc(n)), MAX_INT);
};

const dayBucketUTC = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Epic #594 / Issue #605 — per-family price view (USD per 1M tokens) used by
 * `cache-crossover.ts`. Since #22 it is DERIVED from the single pricing source
 * (`lib/finops/provider-rates.ts`) rather than being a second rate table.
 */
export const MODEL_PRICING: Record<"haiku" | "sonnet" | "opus", { input: number; output: number }> =
  {
    haiku: familyPricePerMTok("haiku"),
    sonnet: familyPricePerMTok("sonnet"),
    opus: familyPricePerMTok("opus"),
  };

/**
 * Epic #696 / Issue #698 — Prompt-cache pricing multipliers, applied against the
 * model's full INPUT rate. Sourced from AWS Bedrock + direct-Anthropic pricing
 * (identical on both): cache READS bill at 0.1× input; cache WRITES bill at 1.25×
 * input for a 5-minute TTL. Exposed as named constants so the 1-hour-TTL variant
 * (2× write) added by #702 extends this cleanly with a sibling
 * `CACHE_WRITE_MULTIPLIER_1H = 2` — no formula change, only a knob selected by
 * the `ANTHROPIC_PROMPT_CACHE_TTL` config key on the native-Anthropic path.
 * Sources: https://aws.amazon.com/bedrock/pricing/ and
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER_5M = 1.25;
/**
 * Epic #696 / Issue #702 — cache WRITE multiplier for the 1-hour TTL, applied
 * against the model's full INPUT rate. Native-Anthropic path ONLY (Bedrock has
 * no 1h TTL for Sonnet 4.6 / Opus 4.6, so its writes stay at the 5-min 1.25×).
 */
export const CACHE_WRITE_MULTIPLIER_1H = 2.0;

/**
 * Estimate cost in USD for a token event, from the single pricing source
 * (`lib/finops/provider-rates.ts` — the same one `token_usages` uses, #22).
 *
 * `promptTokens` here is the FULL-PRICED (uncached) input count — cache reads and
 * writes are billed separately at their reduced/premium rates. Callers that
 * start from a raw provider `usage` payload must first reconcile the two usage
 * conventions (the OpenAI-compatible gateway folds cache reads INTO `prompt_tokens`
 * while native Anthropic reports them separately); use {@link estimateUsageCostUsd}
 * to do that reconciliation.
 *
 * Returns `null` when the model is UNPRICED (#22) — never `0`, which would read
 * as "free" rather than "unknown".
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cache: {
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /**
     * Write-multiplier to apply against the input rate (#702). Defaults to the
     * rate's own 5-minute cache-write price ({@link CACHE_WRITE_MULTIPLIER_5M}
     * for the Claude families); the 1-hour TTL passes
     * {@link CACHE_WRITE_MULTIPLIER_1H}. Legacy 3-arg / cache-only callers are
     * unaffected.
     */
    cacheWriteMultiplier?: number;
    /** Emitting provider, when known — enables provider-keyed prices. */
    provider?: string;
  } = {},
): number | null {
  const rate = resolveRate(cache.provider, model);
  if (!rate) return null;
  const cents = computeCostCentsExact(
    rate,
    {
      inputTokens: sanitize(promptTokens),
      outputTokens: sanitize(completionTokens),
      cacheReadTokens: sanitize(cache.cacheReadTokens),
      cacheWriteTokens: sanitize(cache.cacheWriteTokens),
    },
    cache.cacheWriteMultiplier !== undefined
      ? { cacheWritePer1k: rate.inputPer1k * cache.cacheWriteMultiplier }
      : {},
  );
  return cents / 100;
}

/**
 * Cache-aware cost estimate that starts from a mapped {@link TokenUsage} and the
 * emitting provider. It reconciles the two provider usage conventions via
 * {@link normalizeTokenUsage} so the uncached input remainder is derived without
 * double-counting (gateway: reads are inside `promptTokens`) or under-counting
 * (native: reads/writes are separate) — then prices reads at 0.1× and writes at
 * 1.25× input.
 *
 * Known limitation: the OpenAI-compatible gateway `usage` shape has no cache-
 * creation field, so `cacheWriteTokens` is always 0 on that path and gateway-path
 * cost slightly UNDERSTATES the one-time write premium. Native-Anthropic traffic
 * is unaffected. See docs/OPERATIONS.md §7.5.
 *
 * The 1-hour-TTL write premium (2× vs 1.25×, #702) is applied ONLY when the
 * emitting provider is native `anthropic` AND `writeTtl` resolves to `"1h"`.
 * Bedrock / gateway traffic can never pick up the 2× multiplier — it has no 1h
 * TTL for the current models, and this gate double-guards on the provider key.
 */
export function estimateUsageCostUsd(
  model: string,
  usage: Pick<
    TokenUsage,
    "promptTokens" | "completionTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
  provider: ProviderKey,
  writeTtl: PromptCacheTtl = "5m",
): number | null {
  const norm = normalizeTokenUsage({ ...usage, totalTokens: 0 }, conventionForProvider(provider));
  // Only the 1-hour TTL overrides the rate's own (5-minute) cache-write price.
  const oneHour = provider === "anthropic" && writeTtl === "1h";
  return estimateCostUsd(model, norm.freshInputTokens, usage.completionTokens, {
    cacheReadTokens: norm.cacheReadTokens,
    cacheWriteTokens: norm.cacheWriteTokens,
    ...(oneHour ? { cacheWriteMultiplier: CACHE_WRITE_MULTIPLIER_1H } : {}),
    provider,
  });
}

export interface TokenEvent {
  sessionId: string;
  userId: string;
  provider: ProviderKey;
  model: string;
  usage: Partial<TokenUsage>;
  /** Optional source prompt — hashed (never stored). */
  prompt?: string;
  /** Epic #594 — optional project context for cost allocation. */
  projectId?: string;
  /** Epic #594 — Bedrock inference profile ARN (if used). */
  inferenceProfileArn?: string;
  /** Epic #594 — agent pipeline step (e.g. "analysis", "chat"). */
  agentStep?: string;
  /**
   * Epic #647 / Issue #653 — Per-request token breakdown by component.
   * Stored as JSON in the categoryBreakdown column.
   */
  breakdown?: Record<string, number>;
}

export class TokenTracker {
  private readonly sessions = new Map<string, TokenUsage>();
  private pending = 0;

  /** Returns the merged session totals, or `null` if nothing has been recorded. */
  get(sessionId: string): TokenUsage | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Resets the in-memory aggregate (durable rows untouched). */
  clear(sessionId: string): TokenUsage | null {
    const usage = this.sessions.get(sessionId) ?? null;
    this.sessions.delete(sessionId);
    return usage;
  }

  clearAll(): void {
    this.sessions.clear();
  }

  /** Number of pending durable writes — useful for graceful shutdown. */
  get inFlight(): number {
    return this.pending;
  }

  /**
   * Record a token-usage event. Non-blocking — the Prisma insert is queued.
   */
  record(event: TokenEvent): TokenUsage {
    const promptTokens = sanitize(event.usage.promptTokens);
    const completionTokens = sanitize(event.usage.completionTokens);
    const totalTokens = sanitize(event.usage.totalTokens ?? promptTokens + completionTokens);
    const cacheReadTokens = sanitize(event.usage.cacheReadTokens);
    const cacheWriteTokens = sanitize(event.usage.cacheWriteTokens);

    const merged: TokenUsage = this.merge(event.sessionId, {
      promptTokens,
      completionTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });

    if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) {
      // Nothing to persist — skip the queued insert entirely.
      return merged;
    }

    this.pending += 1;
    queueMicrotask(() => {
      void this.persist({
        sessionId: event.sessionId,
        userId: event.userId,
        provider: event.provider,
        model: event.model,
        promptTokens,
        completionTokens,
        totalTokens,
        cacheReadTokens,
        cacheWriteTokens,
        promptHash: event.prompt ? hashPrompt(event.prompt) : null,
        projectId: event.projectId ?? null,
        inferenceProfileArn: event.inferenceProfileArn ?? null,
        estimatedCostUsd: estimateUsageCostUsd(
          event.model,
          { promptTokens, completionTokens, cacheReadTokens, cacheWriteTokens },
          event.provider,
          resolveAnthropicCacheTtl(),
        ),
        agentStep: event.agentStep ?? null,
        breakdown: event.breakdown ?? null,
      }).finally(() => {
        this.pending -= 1;
      });
    });
    return merged;
  }

  /** Awaitable variant for tests. */
  async recordAndFlush(event: TokenEvent): Promise<TokenUsage> {
    const merged = this.record(event);
    // Wait for queued microtasks to drain.
    while (this.pending > 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    return merged;
  }

  /** Roll up totals per user, optionally filtered by day. */
  async dailyRollup(userId: string, day?: Date): Promise<TokenUsage & { dayBucket: string }> {
    const bucket = dayBucketUTC(day ?? new Date());
    const rows = await prisma.aITokenUsage.findMany({
      where: { userId, dayBucket: bucket },
      select: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    });
    const totals = rows.reduce(
      (acc, r) => ({
        promptTokens: acc.promptTokens + r.promptTokens,
        completionTokens: acc.completionTokens + r.completionTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cacheReadTokens: (acc.cacheReadTokens ?? 0) + r.cacheReadTokens,
        cacheWriteTokens: (acc.cacheWriteTokens ?? 0) + r.cacheWriteTokens,
      }),
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      } as Required<TokenUsage>,
    );
    return { ...totals, dayBucket: bucket };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private merge(sessionId: string, delta: TokenUsage): TokenUsage {
    const cur = this.sessions.get(sessionId) ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const next: TokenUsage = {
      promptTokens: cur.promptTokens + delta.promptTokens,
      completionTokens: cur.completionTokens + delta.completionTokens,
      totalTokens: cur.totalTokens + delta.totalTokens,
      cacheReadTokens: (cur.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
      cacheWriteTokens: (cur.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
    };
    this.sessions.set(sessionId, next);
    return next;
  }

  private async persist(row: {
    sessionId: string;
    userId: string;
    provider: ProviderKey;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    promptHash: string | null;
    projectId: string | null;
    inferenceProfileArn: string | null;
    /** `null` = unpriced model (#22). */
    estimatedCostUsd: number | null;
    agentStep: string | null;
    breakdown: Record<string, number> | null;
  }): Promise<void> {
    try {
      await prisma.aITokenUsage.create({
        data: {
          sessionId: row.sessionId,
          userId: row.userId,
          provider: row.provider,
          model: row.model,
          promptTokens: row.promptTokens,
          completionTokens: row.completionTokens,
          totalTokens: row.totalTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
          promptHash: row.promptHash,
          dayBucket: dayBucketUTC(new Date()),
          projectId: row.projectId,
          inferenceProfileArn: row.inferenceProfileArn,
          estimatedCostUsd: row.estimatedCostUsd,
          agentStep: row.agentStep,
          ...(row.breakdown ? { categoryBreakdown: JSON.stringify(row.breakdown) } : {}),
        },
      });
    } catch (err) {
      log.error("Token usage persist failed", {
        sessionId: row.sessionId,
        provider: row.provider,
        error: (err as Error).message,
      });
    }
  }
}

let singleton: TokenTracker | null = null;
export function getTokenTracker(): TokenTracker {
  if (!singleton) singleton = new TokenTracker();
  return singleton;
}

/** Test helper. */
export function __resetTokenTrackerSingleton(): void {
  singleton = null;
}

export function hashPrompt(prompt: string): string {
  return crypto.createHash("sha256").update(prompt).digest("hex");
}
