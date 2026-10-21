/**
 * Deterministic replay store (#110).
 *
 * Persists every step of an agent run synchronously so the run can be
 * replayed (re-rendered, NOT re-executed) byte-for-byte. Used as the
 * audit trail for multi-agent analyses and ad-hoc chats.
 *
 * The "replay" verb here is intentional: we never reach back to the
 * provider — the timeline is reconstructed from `AgentRunStep` rows.
 */
import type { LedgerTokens } from "@metis/shared";
import { prisma } from "../prisma.js";
import { currentSpanIds } from "../otel/genai-spans.js";
import {
  LEDGER_USAGE_SELECT,
  summariseLedgerRows,
  type LedgerUsageRow,
} from "../finops/ledger-usage-summary.js";

export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 200;

export type AgentRunKind = "analysis" | "chat" | "tool";
export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";
export type AgentRunStepKind = "prompt" | "tool_call" | "tool_result" | "response" | "agent_phase";

export interface RecordRunOptions {
  sessionId: string;
  projectId?: string | null;
  kind?: AgentRunKind;
}

export interface RecordStepOptions {
  runId: string;
  kind: AgentRunStepKind;
  content: unknown;
  latencyMs?: number;
}

export interface FinishRunOptions {
  runId: string;
  status: AgentRunStatus;
  totalTokens?: number;
  costCents?: number;
}

const MAX_CONTENT_BYTES = 64 * 1024;

function safeStringify(content: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(content ?? null);
  } catch {
    s = JSON.stringify({ unstringifiable: String(content) });
  }
  if (Buffer.byteLength(s, "utf8") > MAX_CONTENT_BYTES) {
    return JSON.stringify({ truncated: true, preview: s.slice(0, MAX_CONTENT_BYTES) });
  }
  return s;
}

export async function startRun(opts: RecordRunOptions): Promise<string> {
  const row = await prisma.agentRun.create({
    data: {
      sessionId: opts.sessionId,
      projectId: opts.projectId ?? null,
      kind: opts.kind ?? "chat",
      status: "running",
    },
  });
  return row.id;
}

export async function recordStep(opts: RecordStepOptions): Promise<string> {
  const ids = currentSpanIds();
  // Use a transaction to compute the next ord atomically.
  const ord = await prisma.agentRunStep.count({ where: { runId: opts.runId } }).catch(() => 0);
  const row = await prisma.agentRunStep.create({
    data: {
      runId: opts.runId,
      ord,
      kind: opts.kind,
      content: safeStringify(opts.content),
      latencyMs: opts.latencyMs ?? null,
      spanId: ids.spanId || null,
      traceId: ids.traceId || null,
    },
  });
  return row.id;
}

export interface RunCost {
  /** Whole cents, for the integer `AgentRun.costCents` column. */
  costCents: number;
  /**
   * #977 — the same cost unrounded, in USD. A chat turn costs a fraction of a
   * cent, so its whole-cent figure is 0 or 1 and a page of them misstates
   * spend; a view shows this and rounds only to its display precision.
   */
  costUsd: number;
  /** The ledger total with cache: {@link LedgerTokens.withCache}. */
  totalTokens: number;
  /** #1007 — the run's ledger tokens, with and without cache. */
  tokens: LedgerTokens;
  /** With-cache tokens of the run's rows recorded UNPRICED (#22): no cost is known for them. */
  unpricedTokens: number;
  /**
   * The part of {@link tokens} recorded AFTER the run finished. Only an
   * analysis run can have any (a deep dive, a regenerate or a clarification
   * round bills the analysis's session, #943); zero while a run is going.
   */
  tokensAfterRun: LedgerTokens;
}

const NO_TOKENS: LedgerTokens = { withCache: 0, withoutCache: 0 };

const NO_RUN_COST: RunCost = {
  costCents: 0,
  costUsd: 0,
  totalTokens: 0,
  tokens: NO_TOKENS,
  unpricedTokens: 0,
  tokensAfterRun: NO_TOKENS,
};

type RunWindow = { kind: string; startedAt: Date; completedAt: Date | null };

/** A run's figures from its ledger rows — the one place they are derived. */
function runFigures(
  run: RunWindow,
  rows: ReadonlyArray<LedgerUsageRow & { createdAt: Date }>,
): RunCost {
  const { exactCents, tokens, unpricedTokens } = summariseLedgerRows(rows);
  const finishedAt = run.completedAt;
  const after = finishedAt ? rows.filter((r) => r.createdAt > finishedAt) : [];
  return {
    costCents: Math.round(exactCents),
    costUsd: exactCents / 100,
    totalTokens: tokens.withCache,
    tokens,
    unpricedTokens,
    tokensAfterRun: after.length > 0 ? summariseLedgerRows(after).tokens : NO_TOKENS,
  };
}

/**
 * Attribute real LLM cost to a single AgentRun (#runs cost attribution).
 *
 * `TokenUsage` rows carry no `runId`, only `sessionId`. A session can have
 * multiple runs, so summing ALL usage for a session would over-bill each run.
 * We instead window by the run's own lifetime:
 *
 *   sessionId = run.sessionId
 *   AND createdAt >  run.startedAt
 *   AND createdAt <= (run.completedAt ?? now)
 *
 * Boundary semantics: the lower bound is EXCLUSIVE (`>`) and the upper bound is
 * INCLUSIVE (`<=`). A run's window ends at its finish timestamp (inclusive); the
 * next run in the session starts strictly after. This makes adjacent windows
 * half-open and non-overlapping even when `run1.completedAt == run2.startedAt`:
 * a usage row landing exactly on that shared boundary attributes to the EARLIER
 * run only (its inclusive upper bound), never to both — provably no double-count.
 *
 * Matched rows are summed by `summariseLedgerRows` — the one definition of a
 * run's tokens and cost (#1007). The cost is the STORED ledger cost of the
 * priced rows, rounded once for the run (#977), which is what the usage pages
 * and the analysis header sum; rows recorded unpriced are reported as
 * `unpricedTokens`, not priced at today's rates. (Until the review of #1112
 * this re-priced the rows at the current rate card, so one run read $3.01 here
 * and $1.50 plus 100,000 unpriced tokens on the analysis header.)
 *
 * #943 — an `analysis` run is the exception to the window: its session is the
 * analysis id, which has exactly one run, and work on the analysis after the
 * run finished (a regenerate, a clarification round, a deep dive) bills the
 * same session. Windowing it dropped that spend — $0.14 shown for a $0.46
 * analysis — so an analysis run sums every ledger row of its session, and
 * reports the part recorded after it finished as `tokensAfterRun`.
 *
 * Returns zero figures when the run is missing or no usage falls in-window.
 * Throws only if the database read does.
 */
export async function computeRunCost(runId: string): Promise<RunCost> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { sessionId: true, projectId: true, kind: true, startedAt: true, completedAt: true },
  });
  if (!run) return NO_RUN_COST;
  const upperBound = run.completedAt ?? new Date();
  const rows = await prisma.tokenUsage.findMany({
    where: {
      sessionId: run.sessionId,
      // #1007 — a project's run is billed that project's rows only, the scope
      // the analysis header reads; a project-less (system) run has no such scope.
      ...(run.projectId ? { projectId: run.projectId } : {}),
      ...(run.kind === "analysis" ? {} : { createdAt: { gt: run.startedAt, lte: upperBound } }),
    },
    select: { ...LEDGER_USAGE_SELECT, createdAt: true },
  });
  return runFigures(run, rows);
}

/** Whether a ledger row written at `at` belongs to `run` — {@link computeRunCost}'s window. */
function inRunWindow(run: RunWindow, at: Date, now: Date): boolean {
  if (run.kind === "analysis") return true;
  return at > run.startedAt && at <= (run.completedAt ?? now);
}

/**
 * #977 — the figures of each run on a `/runs` page, exactly as
 * {@link computeRunCost} gives one run's, from ONE ledger read for every
 * session on the page. A failed read yields an empty map: the caller shows the
 * stored whole-cent figure instead, and the list still loads.
 *
 * #1007 — and its tokens from the same rows, so the list cannot disagree with
 * the ledger: the stored `totalTokens` column is written when a run finishes,
 * reads 0 until then and misses spend after it.
 */
async function runLedgerFigures(
  runs: ReadonlyArray<RunWindow & { id: string; sessionId: string; projectId: string | null }>,
): Promise<Map<string, RunCost>> {
  const out = new Map<string, RunCost>();
  if (runs.length === 0) return out;
  const sessionIds = [...new Set(runs.map((r) => r.sessionId))];
  // When every run on the page has a project, the read names those projects so
  // it walks `(projectId, createdAt)` instead of scanning the ledger. A page
  // with a project-less (system) run — an admin's only — keeps the plain read.
  const projectIds = runs.every((r) => r.projectId !== null)
    ? [...new Set(runs.map((r) => r.projectId as string))]
    : null;
  let rows: Array<
    LedgerUsageRow & { sessionId: string | null; projectId: string; createdAt: Date }
  >;
  try {
    rows = await prisma.tokenUsage.findMany({
      where: {
        ...(projectIds ? { projectId: { in: projectIds } } : {}),
        sessionId: { in: sessionIds },
      },
      select: { ...LEDGER_USAGE_SELECT, sessionId: true, projectId: true, createdAt: true },
    });
  } catch {
    return out;
  }
  const bySession = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.sessionId === null) continue;
    const list = bySession.get(row.sessionId) ?? [];
    list.push(row);
    bySession.set(row.sessionId, list);
  }
  const now = new Date();
  for (const run of runs) {
    const mine = (bySession.get(run.sessionId) ?? []).filter(
      (r) =>
        inRunWindow(run, r.createdAt, now) &&
        // The same project scope as `computeRunCost`.
        (run.projectId === null || r.projectId === run.projectId),
    );
    out.set(run.id, runFigures(run, mine));
  }
  return out;
}

/**
 * #943 — re-open a session's latest run of `kind` for follow-up work on the
 * same session (an analysis regenerate or repo resume). It reads `running`
 * with no `completedAt` until {@link finishRun} closes it again, with a cost
 * that includes the follow-up's spend. Returns the run's id and the tokens it
 * had recorded, or null when the session has no such run.
 */
export async function reopenRun(
  sessionId: string,
  kind: AgentRunKind,
): Promise<{ id: string; totalTokens: number } | null> {
  const run = await prisma.agentRun.findFirst({
    where: { sessionId, kind },
    orderBy: { startedAt: "desc" },
    select: { id: true, totalTokens: true },
  });
  if (!run) return null;
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "running", completedAt: null, latencyMs: null },
  });
  return run;
}

export async function finishRun(opts: FinishRunOptions): Promise<void> {
  const run = await prisma.agentRun.findUnique({ where: { id: opts.runId } });
  if (!run) return;
  const completedAt = new Date();
  const latencyMs = completedAt.getTime() - run.startedAt.getTime();
  await prisma.agentRun.update({
    where: { id: opts.runId },
    data: {
      status: opts.status,
      completedAt,
      latencyMs,
      ...(typeof opts.totalTokens === "number" ? { totalTokens: opts.totalTokens } : {}),
      ...(typeof opts.costCents === "number" ? { costCents: opts.costCents } : {}),
    },
  });
}

/**
 * #1121 — how many reachable projects one `GET /api/runs` statement names.
 *
 * Prisma's better-sqlite3 adapter refuses a statement binding more than 999
 * values (P2029) and does not split a read with an `orderBy` or a `take`, so
 * `projectId IN (every reachable project)` answered 500 to a member who could
 * reach about 995 projects. The list is read this many projects at a time
 * instead; each statement also binds the session id, two dates, LIMIT and
 * OFFSET, so 400 leaves a wide margin on SQLite and is nothing on Postgres.
 *
 * THE PAGE ACROSS BATCHES. Every batch is read in the same total order
 * (`startedAt desc, id desc`) with the same `take`; the page is the first
 * `take` of their union in that order. A run of the true page is always among
 * its own batch's first `take`, so nothing is missed and the order is the one
 * a single statement gives.
 */
export const RUN_LIST_PROJECT_BATCH = 400;

/** Newest first; runs started in the same millisecond by id, so the order is total. */
function newestRunFirst(a: { startedAt: Date; id: string }, b: { startedAt: Date; id: string }) {
  const byTime = b.startedAt.getTime() - a.startedAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : -1;
}

export interface ListRunsFilter {
  projectId?: string;
  /**
   * #305 — the projects the caller may reach. When set, runs outside them
   * (including project-less system runs, admin-only like `GET /runs/:id`) are
   * excluded. Absent means no narrowing (system admins).
   */
  accessibleProjectIds?: string[];
  sessionId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * A list's page size: `requested` when it is a positive whole number, else
 * `fallback`; never more than `max`. `?limit=abc` used to reach Prisma as `NaN`
 * (a 500) and `?limit=-3` as a negative `take` (the OLDEST three rows).
 */
export function pageSize(requested: number | undefined, fallback: number, max: number): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? Math.trunc(requested) : 0;
  return Math.min(n > 0 ? n : fallback, max);
}

export async function listRuns(filter: ListRunsFilter): Promise<
  Array<{
    id: string;
    sessionId: string;
    projectId: string | null;
    kind: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    latencyMs: number | null;
    totalTokens: number;
    costCents: number;
    /**
     * #977 — the STORED ledger cost of the run's priced rows, unrounded USD;
     * `null` when the ledger could not be read.
     */
    costUsd: number | null;
    /** Tokens of the run's rows recorded unpriced (#22); `null` with `costUsd`. */
    unpricedTokens: number | null;
    /**
     * #1007 — the run's tokens from the ledger, which move while it runs;
     * `null` when the ledger could not be read. `totalTokens` is the column
     * written when the run finished, kept for a run from before the ledger.
     */
    tokens: LedgerTokens | null;
    /** The part of `tokens` recorded after the run finished; `null` with `tokens`. */
    tokensAfterRun: LedgerTokens | null;
    stepCount: number;
  }>
> {
  const where: Record<string, unknown> = {};
  if (filter.sessionId) where.sessionId = filter.sessionId;
  if (filter.from || filter.to) {
    const startedAt: { gte?: Date; lte?: Date } = {};
    if (filter.from) startedAt.gte = filter.from;
    if (filter.to) startedAt.lte = filter.to;
    where.startedAt = startedAt;
  }
  const take = pageSize(filter.limit, RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT);
  const read = (projectScope: unknown) =>
    prisma.agentRun.findMany({
      where: projectScope === undefined ? where : { ...where, projectId: projectScope },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take,
      include: { _count: { select: { steps: true } } },
    });

  let rows: Awaited<ReturnType<typeof read>>;
  if (filter.accessibleProjectIds) {
    const allowed = filter.projectId
      ? filter.accessibleProjectIds.filter((id) => id === filter.projectId)
      : filter.accessibleProjectIds;
    // #1121 — never one `IN` list of every reachable project: see RUN_LIST_PROJECT_BATCH.
    const found = [];
    for (let i = 0; i < allowed.length; i += RUN_LIST_PROJECT_BATCH) {
      found.push(...(await read({ in: allowed.slice(i, i + RUN_LIST_PROJECT_BATCH) })));
    }
    rows = found.sort(newestRunFirst).slice(0, take);
  } else {
    rows = await read(filter.projectId);
  }
  const ledger = await runLedgerFigures(rows);
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    projectId: r.projectId,
    kind: r.kind,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    latencyMs: r.latencyMs,
    totalTokens: r.totalTokens,
    costCents: r.costCents,
    costUsd: ledger.get(r.id)?.costUsd ?? null,
    unpricedTokens: ledger.get(r.id)?.unpricedTokens ?? null,
    tokens: ledger.get(r.id)?.tokens ?? null,
    tokensAfterRun: ledger.get(r.id)?.tokensAfterRun ?? null,
    stepCount: r._count.steps,
  }));
}

export async function getRun(runId: string): Promise<{
  run: {
    id: string;
    sessionId: string;
    projectId: string | null;
    kind: string;
    status: string;
    startedAt: Date;
    completedAt: Date | null;
    latencyMs: number | null;
    totalTokens: number;
    costCents: number;
    /** The ledger cost unrounded, in USD; `null` when the ledger could not be read. */
    costUsd: number | null;
    /** Tokens of the run's rows recorded unpriced (#22); `null` with `costUsd`. */
    unpricedTokens: number | null;
    /** #1007 — the run's tokens from the ledger; `null` when it could not be read. */
    tokens: LedgerTokens | null;
    /** The part of `tokens` recorded after the run finished; `null` with `tokens`. */
    tokensAfterRun: LedgerTokens | null;
  };
  steps: Array<{
    id: string;
    ord: number;
    kind: AgentRunStepKind;
    content: unknown;
    latencyMs: number | null;
    spanId: string | null;
    traceId: string | null;
    createdAt: Date;
  }>;
} | null> {
  const row = await prisma.agentRun.findUnique({
    where: { id: runId },
    include: { steps: { orderBy: { ord: "asc" } } },
  });
  if (!row) return null;
  // #943 — a run's cost is read live from the ledger, so an analysis run shows
  // spend after it was closed (a clarification round, a deep dive). Every kind
  // of run reads it, as the `/runs` list does, so a run's page and its list row
  // are one figure. A failed ledger read falls back to the cost stored at
  // finish; it never fails the read.
  // #1007 — the tokens come from the same read.
  const ledger = await computeRunCost(row.id).catch(() => null);
  const costCents = ledger ? ledger.costCents : row.costCents;
  return {
    run: {
      id: row.id,
      sessionId: row.sessionId,
      projectId: row.projectId,
      kind: row.kind,
      status: row.status,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      latencyMs: row.latencyMs,
      totalTokens: row.totalTokens,
      costCents,
      costUsd: ledger?.costUsd ?? null,
      unpricedTokens: ledger?.unpricedTokens ?? null,
      tokens: ledger?.tokens ?? null,
      tokensAfterRun: ledger?.tokensAfterRun ?? null,
    },
    steps: row.steps.map((s) => ({
      id: s.id,
      ord: s.ord,
      kind: s.kind as AgentRunStepKind,
      content: parseContent(s.content),
      latencyMs: s.latencyMs,
      spanId: s.spanId,
      traceId: s.traceId,
      createdAt: s.createdAt,
    })),
  };
}

function parseContent(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
