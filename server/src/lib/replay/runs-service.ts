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
import { prisma } from "../prisma.js";
import { currentSpanIds } from "../otel/genai-spans.js";
import { getRate, computeCostCents } from "../finops/index.js";

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
  costCents: number;
  totalTokens: number;
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
 * Matched rows are grouped by (provider, model); per group we look up the rate
 * and call `computeCostCents`, then sum integer cents across groups. We
 * re-derive cost from tokens (rather than summing the per-row `costCents`
 * stored at insert) because the brief requires grouping by provider/model and
 * applying current rates — rates may have shifted since insert. The tradeoff:
 * if a rate has changed, the attributed cost can differ from the historical
 * stored cost; for `/runs` reporting we prefer the current rate card.
 *
 * Returns `{ costCents: 0, totalTokens: 0 }` when the run is missing or no
 * usage falls in-window. Never throws.
 */
export async function computeRunCost(runId: string): Promise<RunCost> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { sessionId: true, startedAt: true, completedAt: true },
  });
  if (!run) return { costCents: 0, totalTokens: 0 };
  const upperBound = run.completedAt ?? new Date();
  const rows = await prisma.tokenUsage.findMany({
    where: {
      sessionId: run.sessionId,
      createdAt: { gt: run.startedAt, lte: upperBound },
    },
    select: {
      provider: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      totalTokens: true,
    },
  });
  if (rows.length === 0) return { costCents: 0, totalTokens: 0 };

  interface Group {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }
  const groups = new Map<string, Group>();
  let totalTokens = 0;
  for (const row of rows) {
    totalTokens += row.totalTokens;
    const key = `${row.provider} ${row.model}`;
    const g = groups.get(key) ?? {
      provider: row.provider,
      model: row.model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    g.inputTokens += row.inputTokens;
    g.outputTokens += row.outputTokens;
    g.cacheReadTokens += row.cacheReadTokens;
    g.cacheWriteTokens += row.cacheWriteTokens;
    groups.set(key, g);
  }

  let costCents = 0;
  for (const g of groups.values()) {
    const rate = getRate(g.provider, g.model);
    // #22 — an unpriced model has no cost to attribute; its tokens still count.
    if (!rate) continue;
    costCents += computeCostCents(rate, {
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      cacheReadTokens: g.cacheReadTokens,
      cacheWriteTokens: g.cacheWriteTokens,
    });
  }
  return { costCents, totalTokens };
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
    stepCount: number;
  }>
> {
  const where: Record<string, unknown> = {};
  if (filter.projectId) where.projectId = filter.projectId;
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
      costCents: row.costCents,
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
