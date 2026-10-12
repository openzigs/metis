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
}

const NO_RUN_COST: RunCost = {
  costCents: 0,
  costUsd: 0,
  totalTokens: 0,
  tokens: { withCache: 0, withoutCache: 0 },
};

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
 * run's tokens and cost (#1007) — grouped by (provider, model); per group we look up the rate
 * and price it unrounded, then round the run's total once (#977). We
 * re-derive cost from tokens (rather than summing the per-row `costCents`
 * stored at insert) because the brief requires grouping by provider/model and
 * applying current rates — rates may have shifted since insert. The tradeoff:
 * if a rate has changed, the attributed cost can differ from the historical
 * stored cost; for `/runs` reporting we prefer the current rate card.
 *
 * #943 — an `analysis` run is the exception: its session is the analysis id,
 * which has exactly one run, and work on the analysis after the run finished
 * (a regenerate, a clarification round, a deep dive) bills the same session.
 * Windowing it dropped that spend — $0.14 shown for a $0.46 analysis — so an
 * analysis run sums every ledger row of its session.
 *
 * Returns `{ costCents: 0, totalTokens: 0 }` when the run is missing or no
 * usage falls in-window. Never throws.
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
    select: LEDGER_USAGE_SELECT,
  });
  const { exactCents, tokens } = summariseLedgerRows(rows);
  return {
    costCents: Math.round(exactCents),
    costUsd: exactCents / 100,
    totalTokens: tokens.withCache,
    tokens,
  };
}

/** Whether a ledger row written at `at` belongs to `run` — {@link computeRunCost}'s window. */
function inRunWindow(
  run: { kind: string; startedAt: Date; completedAt: Date | null },
  at: Date,
  now: Date,
): boolean {
  if (run.kind === "analysis") return true;
  return at > run.startedAt && at <= (run.completedAt ?? now);
}

/** A run's figures from the ledger, as a `/runs` row shows them. */
interface RunLedgerFigures {
  costUsd: number;
  tokens: LedgerTokens;
}

/**
 * #977 — the unrounded cost, in USD, of each run on a `/runs` page, priced
 * exactly as {@link computeRunCost} prices one run, from ONE ledger read for
 * every session on the page. A failed read yields an empty map: the caller
 * shows the stored whole-cent figure instead, and the list still loads.
 *
 * #1007 — and its tokens from the same rows, so the list cannot disagree with
 * the ledger: the stored `totalTokens` column is written when a run finishes,
 * reads 0 until then and misses spend after it.
 */
async function runLedgerFigures(
  runs: ReadonlyArray<{
    id: string;
    sessionId: string;
    projectId: string | null;
    kind: string;
    startedAt: Date;
    completedAt: Date | null;
  }>,
): Promise<Map<string, RunLedgerFigures>> {
  const out = new Map<string, RunLedgerFigures>();
  if (runs.length === 0) return out;
  const sessionIds = [...new Set(runs.map((r) => r.sessionId))];
  let rows: Array<
    LedgerUsageRow & { sessionId: string | null; projectId: string; createdAt: Date }
  >;
  try {
    rows = await prisma.tokenUsage.findMany({
      where: { sessionId: { in: sessionIds } },
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
    const { exactCents, tokens } = summariseLedgerRows(mine);
    out.set(run.id, { costUsd: exactCents / 100, tokens });
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
    /** #977 — unrounded USD from the ledger; `null` when the ledger could not be read. */
    costUsd: number | null;
    /**
     * #1007 — the run's tokens from the ledger, which move while it runs;
     * `null` when the ledger could not be read. `totalTokens` is the column
     * written when the run finished, kept for a run from before the ledger.
     */
    tokens: LedgerTokens | null;
    stepCount: number;
  }>
> {
  const where: Record<string, unknown> = {};
  if (filter.accessibleProjectIds) {
    const allowed = filter.projectId
      ? filter.accessibleProjectIds.filter((id) => id === filter.projectId)
      : filter.accessibleProjectIds;
    where.projectId = { in: allowed };
  } else if (filter.projectId) {
    where.projectId = filter.projectId;
  }
  if (filter.sessionId) where.sessionId = filter.sessionId;
  if (filter.from || filter.to) {
    const startedAt: { gte?: Date; lte?: Date } = {};
    if (filter.from) startedAt.gte = filter.from;
    if (filter.to) startedAt.lte = filter.to;
    where.startedAt = startedAt;
  }
  const rows = await prisma.agentRun.findMany({
    where,
    orderBy: { startedAt: "desc" },
    take: Math.min(filter.limit ?? 50, 200),
    include: { _count: { select: { steps: true } } },
  });
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
    tokens: ledger.get(r.id)?.tokens ?? null,
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
    /** #1007 — the run's tokens from the ledger; `null` when it could not be read. */
    tokens: LedgerTokens | null;
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
  // #943 — an analysis run is priced live over its whole session, so spend
  // after the run was closed (a clarification round, a deep dive) is shown.
  // A failed ledger read falls back to the stored cost; it never fails the read.
  // #1007 — the tokens come from the same read, for every kind of run.
  const ledger = await computeRunCost(row.id).catch(() => null);
  const costCents = row.kind === "analysis" && ledger ? ledger.costCents : row.costCents;
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
      tokens: ledger?.tokens ?? null,
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
