/**
 * #1845 — what one chat-cache run measured, summed from its per-session
 * records: the prompt cache (#1842), the tool-result cache (#1843) and the
 * semantic answer cache (#1844). Pure: the CLI records, this sums and formats.
 */
import { canonicalJson } from "../../ai/tool-runtime/tool-result-cache.js";
import type { ReplayResult } from "./semantic-replay.js";

/** `on`: the shipped tool-loop posture (#1842). `off`: the system prefix only, as before it. */
export type PromptCacheArm = "on" | "off";

export interface SessionUsage {
  /** Uncached input tokens, as the provider reports them. */
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Model calls the session made. */
  calls: number;
}

export type ToolCacheOutcome = "hit" | "miss" | "bypass" | "uncached";

export interface SessionToolCall {
  tool: string;
  args: unknown;
  outcome: ToolCacheOutcome;
  /**
   * The call's place in the run, across sessions. Sessions run concurrently, so
   * "had this call already run in this pass?" must be asked in run order, not
   * session order.
   */
  seq?: number;
}

export interface ChatCacheSession {
  arm: PromptCacheArm;
  pass: string;
  questionId: string;
  usage: SessionUsage;
  /** Ledger-priced; null when a call was unpriced. */
  costUsd: number | null;
  toolCalls: SessionToolCall[];
}

export interface PromptCacheSummary {
  arm: PromptCacheArm;
  pass: string;
  sessions: number;
  modelCalls: number;
  /** Every input token: uncached + cache read + cache write. */
  inputTokens: number;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Cache-read tokens over all input tokens. */
  cacheReadShare: number;
  inputTokensPerSession: number;
  /** Null when any session was unpriced. */
  costUsd: number | null;
  costPerSessionUsd: number | null;
}

export function summarizePromptCache(sessions: readonly ChatCacheSession[]): PromptCacheSummary[] {
  const groups = new Map<string, ChatCacheSession[]>();
  for (const s of sessions) {
    const key = `${s.arm}\u0000${s.pass}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.values()].map((group) => {
    const sum = (f: (u: SessionUsage) => number): number =>
      group.reduce((acc, s) => acc + f(s.usage), 0);
    const uncached = sum((u) => u.promptTokens);
    const read = sum((u) => u.cacheReadTokens);
    const write = sum((u) => u.cacheWriteTokens);
    const input = uncached + read + write;
    const priced = group.every((s) => s.costUsd !== null);
    const cost = priced ? group.reduce((acc, s) => acc + (s.costUsd ?? 0), 0) : null;
    return {
      arm: group[0].arm,
      pass: group[0].pass,
      sessions: group.length,
      modelCalls: sum((u) => u.calls),
      inputTokens: input,
      uncachedInputTokens: uncached,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      outputTokens: sum((u) => u.completionTokens),
      cacheReadShare: input === 0 ? 0 : read / input,
      inputTokensPerSession: input / group.length,
      costUsd: cost,
      costPerSessionUsd: cost === null ? null : cost / group.length,
    };
  });
}

export interface ToolCacheSummary {
  arm: PromptCacheArm;
  pass: string;
  /** Calls to a cacheable tool (hit + miss + bypass). */
  lookups: number;
  hits: number;
  misses: number;
  bypasses: number;
  hitRate: number;
  /** Calls to tools the cache does not cover. */
  uncached: number;
  /**
   * Calls whose exact tool + arguments ran in `previousPass` and not earlier in
   * this one: what an unversioned cache would have served from before the
   * re-ingest. Only set when a previous pass is named.
   */
  repeatsAcrossReingest?: number;
  /**
   * Hits whose tool + arguments had NOT run earlier in this pass: they can only
   * have come from before the re-ingest. Must be 0; anything else is a defect.
   */
  hitsFromPreviousPass?: number;
}

const callKey = (c: SessionToolCall): string => `${c.tool}\u0000${canonicalJson(c.args ?? null)}`;

export function summarizeToolCache(
  sessions: readonly ChatCacheSession[],
  arm: PromptCacheArm,
  pass: string,
  previousPass?: string,
): ToolCacheSummary {
  const calls = sessions
    .filter((s) => s.arm === arm && s.pass === pass)
    .flatMap((s) => s.toolCalls)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const count = (o: ToolCacheOutcome): number => calls.filter((c) => c.outcome === o).length;
  const hits = count("hit");
  const misses = count("miss");
  const bypasses = count("bypass");
  const lookups = hits + misses + bypasses;
  const summary: ToolCacheSummary = {
    arm,
    pass,
    lookups,
    hits,
    misses,
    bypasses,
    hitRate: lookups === 0 ? 0 : hits / lookups,
    uncached: count("uncached"),
  };
  if (previousPass !== undefined) {
    const before = new Set(
      sessions
        .filter((s) => s.arm === arm && s.pass === previousPass)
        .flatMap((s) => s.toolCalls.filter((c) => c.outcome !== "uncached").map(callKey)),
    );
    const seen = new Set<string>();
    let repeats = 0;
    let fromPrevious = 0;
    for (const c of calls) {
      if (c.outcome === "uncached") continue;
      const key = callKey(c);
      if (!seen.has(key)) {
        if (before.has(key)) repeats++;
        if (c.outcome === "hit") fromPrevious++;
      }
      seen.add(key);
    }
    summary.repeatsAcrossReingest = repeats;
    summary.hitsFromPreviousPass = fromPrevious;
  }
  return summary;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const usd = (x: number | null): string => (x === null ? "unpriced" : `$${x.toFixed(4)}`);
const int = (x: number): string => Math.round(x).toLocaleString("en-US");

/** The run as a Markdown report: three tables and the noise floor. */
export function formatChatCacheReport(input: {
  title: string;
  provider: string;
  model: string;
  promptCache: readonly PromptCacheSummary[];
  toolCache: readonly ToolCacheSummary[];
  semantic: readonly ReplayResult[];
  agreement: ReadonlyArray<{
    pass: string;
    label: string;
    pairs: number;
    sameFiles: number;
    meanJaccard?: number;
  }>;
  similarities?: ReadonlyArray<{ a: string; b: string; label: string; similarity: number }>;
  spentUsd: number;
}): string {
  const lines: string[] = [
    `# ${input.title}`,
    "",
    `Provider/model: \`${input.provider}/${input.model}\`. Spend: ${usd(input.spentUsd)}.`,
    "",
    "## Prompt cache (#1842)",
    "",
    "| arm | pass | sessions | model calls | input tok/session | cache-read share | cache write tok | cost/session | cost |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...input.promptCache.map(
      (p) =>
        `| ${p.arm} | ${p.pass} | ${p.sessions} | ${p.modelCalls} | ${int(p.inputTokensPerSession)} | ` +
        `${pct(p.cacheReadShare)} | ${int(p.cacheWriteTokens)} | ${usd(p.costPerSessionUsd)} | ${usd(p.costUsd)} |`,
    ),
    "",
    "## Tool-result cache (#1843)",
    "",
    "| arm | pass | lookups | hits | misses | bypasses | hit rate | repeats across re-ingest | hits from previous pass |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...input.toolCache.map(
      (t) =>
        `| ${t.arm} | ${t.pass} | ${t.lookups} | ${t.hits} | ${t.misses} | ${t.bypasses} | ${pct(t.hitRate)} | ` +
        `${t.repeatsAcrossReingest ?? "—"} | ${t.hitsFromPreviousPass ?? "—"} |`,
    ),
    "",
    "## Semantic answer cache (#1844), replayed",
    "",
    "A hit is wrong when the answer it serves cites different files from a fresh run of the question.",
    "",
    "Each `wrong: <kind>` cell is wrong/hits. `stale` counts hits served across the re-ingest whose fresh",
    "answer cites a file the re-ingest created; `overlap` is the mean Jaccard of served vs fresh cited files.",
    "",
    "| variant | threshold | lookups | stored | hits | exact | wrong | stale | overlap | wrong: near-miss | wrong: after re-ingest | wrong: paraphrase | wrong: repeat |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...input.semantic.map((s) => {
      const k = (kind: keyof ReplayResult["byKind"]): string => {
        const b = s.byKind[kind];
        return b ? `${b.wrong}/${b.hits}` : "0/0";
      };
      return (
        `| ${s.variant} | ${s.threshold.toFixed(2)} | ${s.lookups} | ${s.stored} | ${s.hits} | ${s.exactHits} | ` +
        `${s.wrongHits} | ${s.staleHits} | ${s.meanJaccard === null ? "—" : s.meanJaccard.toFixed(2)} | ` +
        `${k("near-miss")} | ${k("after-reingest")} | ${k("paraphrase")} | ${k("repeat")} |`
      );
    }),
    "",
    "## Noise floor: two fresh runs citing the same files",
    "",
    "| pass | pair label | pairs | same files | mean overlap |",
    "|---|---|---:|---:|---:|",
    ...input.agreement.map(
      (a) =>
        `| ${a.pass} | ${a.label} | ${a.pairs} | ${a.sameFiles} | ${a.meanJaccard === undefined ? "—" : a.meanJaccard.toFixed(2)} |`,
    ),
    "",
  ];
  if (input.similarities && input.similarities.length > 0) {
    lines.push(
      "## Question similarity per pair (the cache's embedder)",
      "",
      "| pair | label | cosine |",
      "|---|---|---:|",
      ...[...input.similarities]
        .sort((x, y) => y.similarity - x.similarity)
        .map((p) => `| ${p.a}–${p.b} | ${p.label} | ${p.similarity.toFixed(4)} |`),
      "",
    );
  }
  return lines.join("\n");
}
