/**
 * Tests for replay/runs-service.ts (#110).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

interface RunRow {
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
  steps: StepRow[];
  _count?: { steps: number };
}

interface StepRow {
  id: string;
  runId: string;
  ord: number;
  kind: string;
  content: string;
  spanId: string | null;
  traceId: string | null;
  latencyMs: number | null;
  createdAt: Date;
}

interface UsageRow {
  sessionId: string | null;
  projectId: string;
  requestTokens: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costCents: number | null;
  costUsd: number | null;
  createdAt: Date;
}

const runs: RunRow[] = [];
const steps: StepRow[] = [];
const usage: UsageRow[] = [];
let usageReadFails = false;
/** Every `where` the ledger was read with, in order. */
const ledgerWheres: Array<Record<string, unknown>> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    agentRun: {
      create: vi.fn(async ({ data }: { data: Partial<RunRow> }) => {
        const id = `run_${runs.length + 1}`;
        const row: RunRow = {
          id,
          sessionId: data.sessionId ?? "",
          projectId: data.projectId ?? null,
          kind: data.kind ?? "chat",
          status: data.status ?? "running",
          startedAt: new Date(),
          completedAt: null,
          latencyMs: null,
          totalTokens: 0,
          costCents: 0,
          steps: [],
        };
        runs.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({
          where,
          include,
        }: {
          where: { id: string };
          include?: { steps?: { orderBy?: unknown } };
        }) => {
          const r = runs.find((x) => x.id === where.id);
          if (!r) return null;
          if (include?.steps) {
            return {
              ...r,
              steps: steps.filter((s) => s.runId === r.id).sort((a, b) => a.ord - b.ord),
            };
          }
          return r;
        },
      ),
      findMany: vi.fn(
        async ({ where, take }: { where?: Record<string, unknown>; take?: number }) => {
          const filtered = runs.filter((r) => {
            if (!where) return true;
            if (where.projectId !== undefined && r.projectId !== where.projectId) return false;
            if (where.sessionId !== undefined && r.sessionId !== where.sessionId) return false;
            const startedAt = where.startedAt as { gte?: Date; lte?: Date } | undefined;
            if (startedAt) {
              if (startedAt.gte && r.startedAt < startedAt.gte) return false;
              if (startedAt.lte && r.startedAt > startedAt.lte) return false;
            }
            return true;
          });
          return filtered.slice(0, take).map((r) => ({
            ...r,
            _count: { steps: steps.filter((s) => s.runId === r.id).length },
          }));
        },
      ),
      // #943 — honours `orderBy: { startedAt }`, so the order `reopenRun` asks for is tested.
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { sessionId: string; kind: string };
          orderBy?: { startedAt?: "asc" | "desc" };
        }) => {
          const sign = orderBy?.startedAt === "desc" ? -1 : 1;
          const match = runs
            .filter((r) => r.sessionId === where.sessionId && r.kind === where.kind)
            .sort((a, b) => sign * (a.startedAt.getTime() - b.startedAt.getTime()));
          return match[0] ? { id: match[0].id, totalTokens: match[0].totalTokens } : null;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data);
        return r;
      }),
    },
    tokenUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            sessionId?: string | null | { in: string[] };
            projectId?: string | { in: string[] };
            createdAt?: { gt?: Date; gte?: Date; lte?: Date };
          };
        }) => {
          if (usageReadFails) throw new Error("ledger unavailable");
          ledgerWheres.push(where);
          return usage.filter((u) => {
            const pid = where.projectId;
            if (pid && typeof pid === "object") {
              if (!pid.in.includes(u.projectId)) return false;
            } else if (pid !== undefined && u.projectId !== pid) return false;
            const sid = where.sessionId;
            if (sid && typeof sid === "object") {
              if (u.sessionId === null || !sid.in.includes(u.sessionId)) return false;
            } else if (sid !== undefined && u.sessionId !== sid) return false;
            if (where.createdAt) {
              if (where.createdAt.gt && u.createdAt <= where.createdAt.gt) return false;
              if (where.createdAt.gte && u.createdAt < where.createdAt.gte) return false;
              if (where.createdAt.lte && u.createdAt > where.createdAt.lte) return false;
            }
            return true;
          });
        },
      ),
    },
    agentRunStep: {
      count: vi.fn(
        async ({ where }: { where: { runId: string } }) =>
          steps.filter((s) => s.runId === where.runId).length,
      ),
      create: vi.fn(async ({ data }: { data: Partial<StepRow> }) => {
        const row: StepRow = {
          id: `step_${steps.length + 1}`,
          runId: data.runId ?? "",
          ord: data.ord ?? 0,
          kind: data.kind ?? "prompt",
          content: data.content ?? "",
          spanId: data.spanId ?? null,
          traceId: data.traceId ?? null,
          latencyMs: data.latencyMs ?? null,
          createdAt: new Date(),
        };
        steps.push(row);
        return row;
      }),
    },
  },
}));

import {
  startRun,
  recordStep,
  finishRun,
  listRuns,
  getRun,
  computeRunCost,
  pageSize,
  reopenRun,
} from "../src/lib/replay/runs-service.js";
import {
  ledgerRowSummedRequests,
  priceLedgerTokensExact,
} from "../src/lib/finops/token-tracker.js";
import { getRate } from "../src/lib/finops/provider-rates.js";

beforeEach(() => {
  runs.length = 0;
  steps.length = 0;
  usage.length = 0;
  ledgerWheres.length = 0;
  usageReadFails = false;
});

/**
 * Seed a ledger row. Its cost is STORED the way `recordUsage` stores it — the
 * row priced when it was recorded, each request in its own tier, `null` for an
 * unpriced model — unless the test gives the stored cost itself. A run's cost
 * is that stored figure (#1007 review): nothing is re-priced when it is read.
 */
function seedUsage(row: Partial<UsageRow> & { sessionId: string | null; createdAt: Date }): void {
  const provider = row.provider ?? "anthropic";
  const model = row.model ?? "claude-3-5-sonnet";
  const counts = {
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    cacheWriteTokens: row.cacheWriteTokens ?? 0,
  };
  const requestTokens = row.requestTokens ?? null;
  const recordedCents = priceLedgerTokensExact(
    provider,
    getRate(provider, model),
    counts,
    ledgerRowSummedRequests({ ...counts, requestTokens }),
  );
  const costUsd =
    row.costUsd !== undefined ? row.costUsd : recordedCents === null ? null : recordedCents / 100;
  usage.push({
    provider,
    model,
    ...counts,
    costUsd,
    costCents:
      row.costCents !== undefined
        ? row.costCents
        : costUsd === null
          ? null
          : Math.round(costUsd * 100),
    totalTokens:
      row.totalTokens ??
      (row.inputTokens ?? 0) +
        (row.outputTokens ?? 0) +
        (row.cacheReadTokens ?? 0) +
        (row.cacheWriteTokens ?? 0),
    sessionId: row.sessionId,
    projectId: row.projectId ?? "p-default",
    requestTokens: row.requestTokens ?? null,
    createdAt: row.createdAt,
  });
}

describe("replay/runs-service", () => {
  it("startRun creates a row with running status and returns id", async () => {
    const id = await startRun({ sessionId: "s1", projectId: "p1", kind: "analysis" });
    expect(id).toMatch(/^run_/);
    expect(runs).toHaveLength(1);
    expect(runs[0].sessionId).toBe("s1");
    expect(runs[0].kind).toBe("analysis");
    expect(runs[0].status).toBe("running");
  });

  it("startRun without projectId stores null", async () => {
    await startRun({ sessionId: "s1" });
    expect(runs[0].projectId).toBeNull();
    expect(runs[0].kind).toBe("chat");
  });

  it("recordStep persists JSON-encoded content with monotonic ord", async () => {
    const runId = await startRun({ sessionId: "s1" });
    await recordStep({ runId, kind: "prompt", content: { text: "hi" } });
    await recordStep({ runId, kind: "tool_call", content: { name: "x" } });
    expect(steps).toHaveLength(2);
    expect(steps[0].ord).toBe(0);
    expect(steps[1].ord).toBe(1);
    expect(JSON.parse(steps[0].content)).toEqual({ text: "hi" });
  });

  it("recordStep truncates payloads exceeding 64KB", async () => {
    const runId = await startRun({ sessionId: "s1" });
    const big = "x".repeat(80_000);
    await recordStep({ runId, kind: "response", content: big });
    const parsed = JSON.parse(steps[0].content);
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.preview).toBe("string");
  });

  it("recordStep handles unstringifiable content gracefully", async () => {
    const runId = await startRun({ sessionId: "s1" });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await recordStep({ runId, kind: "prompt", content: circular });
    expect(steps[0].content).toContain("unstringifiable");
  });

  it("finishRun stamps completedAt + latency + status", async () => {
    const runId = await startRun({ sessionId: "s1" });
    runs[0].startedAt = new Date(Date.now() - 1000);
    await finishRun({ runId, status: "completed", totalTokens: 42, costCents: 5 });
    expect(runs[0].status).toBe("completed");
    expect(runs[0].latencyMs).toBeGreaterThanOrEqual(900);
    expect(runs[0].totalTokens).toBe(42);
    expect(runs[0].costCents).toBe(5);
  });

  it("finishRun is a no-op when run does not exist", async () => {
    await finishRun({ runId: "missing", status: "completed" });
    // No throw; just nothing happens.
  });

  it("listRuns filters by projectId, sessionId, and date range", async () => {
    await startRun({ sessionId: "s1", projectId: "p1" });
    await startRun({ sessionId: "s2", projectId: "p2" });
    let out = await listRuns({ projectId: "p1" });
    expect(out).toHaveLength(1);
    expect(out[0].projectId).toBe("p1");
    out = await listRuns({ sessionId: "s2" });
    expect(out).toHaveLength(1);
    out = await listRuns({ from: new Date(Date.now() - 1000), to: new Date(Date.now() + 1000) });
    expect(out.length).toBe(2);
    out = await listRuns({ from: new Date(Date.now() + 60_000) });
    expect(out).toHaveLength(0);
  });

  it("listRuns caps limit at 200", async () => {
    for (let i = 0; i < 5; i += 1) {
      await startRun({ sessionId: `s${i}` });
    }
    const out = await listRuns({ limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("getRun returns null for missing id", async () => {
    expect(await getRun("missing")).toBeNull();
  });

  it("getRun returns the run with parsed step content in ord order", async () => {
    const runId = await startRun({ sessionId: "s1" });
    await recordStep({ runId, kind: "prompt", content: { p: 1 } });
    await recordStep({ runId, kind: "response", content: { r: 2 } });
    const out = await getRun(runId);
    expect(out).not.toBeNull();
    expect(out!.steps).toHaveLength(2);
    expect(out!.steps[0].content).toEqual({ p: 1 });
    expect(out!.steps[1].content).toEqual({ r: 2 });
  });

  it("getRun falls back to raw string when content is not valid JSON", async () => {
    const runId = await startRun({ sessionId: "s1" });
    // Inject a corrupt step to exercise the parse fallback.
    steps.push({
      id: "x",
      runId,
      ord: 0,
      kind: "response",
      content: "not-json{",
      spanId: null,
      traceId: null,
      latencyMs: null,
      createdAt: new Date(),
    });
    const out = await getRun(runId);
    expect(out!.steps[0].content).toBe("not-json{");
  });
});

describe("replay/runs-service computeRunCost", () => {
  it("returns zero (no throw) when the run does not exist", async () => {
    const cost = await computeRunCost("missing");
    expect(cost).toEqual({
      costCents: 0,
      costUsd: 0,
      totalTokens: 0,
      tokens: { withCache: 0, withoutCache: 0 },
      unpricedTokens: 0,
      tokensAfterRun: { withCache: 0, withoutCache: 0 },
    });
  });

  it("returns zero when no usage rows fall in the run window", async () => {
    const runId = await startRun({ sessionId: "s1" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    // Usage exists but for a different session.
    seedUsage({
      sessionId: "other",
      createdAt: new Date("2026-01-01T00:30:00Z"),
      inputTokens: 1000,
      outputTokens: 1000,
    });
    const cost = await computeRunCost(runId);
    expect(cost).toEqual({
      costCents: 0,
      costUsd: 0,
      totalTokens: 0,
      tokens: { withCache: 0, withoutCache: 0 },
      unpricedTokens: 0,
      tokensAfterRun: { withCache: 0, withoutCache: 0 },
    });
  });

  it("attributes no cost to an unpriced model but still counts its tokens (#22)", async () => {
    const runId = await startRun({ sessionId: "sess-U" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    // Priced: 10k in + 2k out of claude-3-5-sonnet = 6 cents.
    seedUsage({
      sessionId: "sess-U",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    // Unpriced: before #22 the anthropic:default row billed this at Sonnet rates.
    seedUsage({
      sessionId: "sess-U",
      model: "deepseek-v4-pro",
      createdAt: new Date("2026-01-01T00:20:00Z"),
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const cost = await computeRunCost(runId);
    expect(cost).toEqual({
      costCents: 6,
      costUsd: 0.06,
      totalTokens: 2_012_000,
      tokens: { withCache: 2_012_000, withoutCache: 2_012_000 },
      // Said to be unpriced, by how much — never folded into the cost.
      unpricedTokens: 2_000_000,
      tokensAfterRun: { withCache: 0, withoutCache: 0 },
    });
  });

  it("aggregates in-window usage grouped by provider+model into integer cents", async () => {
    const runId = await startRun({ sessionId: "sess-A" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    // anthropic:claude-3-5-sonnet → input 0.3¢/1k, output 1.5¢/1k.
    // 10k in + 2k out = (10000*0.3 + 2000*1.5)/1000 = 3 + 3 = 6 cents.
    seedUsage({
      sessionId: "sess-A",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    // openai:gpt-4o → input 0.25¢/1k, output 1.0¢/1k.
    // 4k in + 1k out = (4000*0.25 + 1000*1.0)/1000 = 1 + 1 = 2 cents.
    seedUsage({
      sessionId: "sess-A",
      createdAt: new Date("2026-01-01T00:20:00Z"),
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 4_000,
      outputTokens: 1_000,
    });
    const cost = await computeRunCost(runId);
    expect(cost.costCents).toBe(8); // 6 + 2
    expect(cost.totalTokens).toBe(10_000 + 2_000 + 4_000 + 1_000);
  });

  it("sums multiple rows of the same provider+model before applying the rate", async () => {
    const runId = await startRun({ sessionId: "sess-G" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    // Two rows, same provider/model: 600 + 400 = 1000 input tokens.
    // (1000 * 0.3)/1000 = 0.3 → rounds to 0 cents per-row, but 1 group sums
    // to 1000 tokens = 0.3 → still 0 here; use larger numbers to prove summing.
    seedUsage({
      sessionId: "sess-G",
      createdAt: new Date("2026-01-01T00:05:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 6_000,
    });
    seedUsage({
      sessionId: "sess-G",
      createdAt: new Date("2026-01-01T00:06:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 4_000,
    });
    // Grouped: 10_000 input * 0.3 / 1000 = 3 cents.
    const cost = await computeRunCost(runId);
    expect(cost.costCents).toBe(3);
    expect(cost.totalTokens).toBe(10_000);
  });

  it("NO DOUBLE-COUNT: two runs in one session attribute only their own window", async () => {
    // Run 1: 00:00 → 00:30. Run 2: 00:30 → 01:00. Same session.
    const run1 = await startRun({ sessionId: "shared" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T00:30:00Z");
    const run2 = await startRun({ sessionId: "shared" });
    runs[1].startedAt = new Date("2026-01-01T00:30:00Z");
    runs[1].completedAt = new Date("2026-01-01T01:00:00Z");

    // Usage inside run 1's window: 10k in + 2k out (sonnet) = 6 cents.
    seedUsage({
      sessionId: "shared",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    // Usage inside run 2's window: 4k in + 1k out (gpt-4o) = 2 cents.
    seedUsage({
      sessionId: "shared",
      createdAt: new Date("2026-01-01T00:45:00Z"),
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 4_000,
      outputTokens: 1_000,
    });

    const cost1 = await computeRunCost(run1);
    const cost2 = await computeRunCost(run2);
    // Each run gets ONLY its own window's cost, not the session total (8).
    expect(cost1.costCents).toBe(6);
    expect(cost1.totalTokens).toBe(12_000);
    expect(cost2.costCents).toBe(2);
    expect(cost2.totalTokens).toBe(5_000);
  });

  it("NO DOUBLE-COUNT on a shared boundary: a usage row exactly at run1.completedAt == run2.startedAt attributes only to the earlier run", async () => {
    // Adjacent windows sharing an exact boundary timestamp.
    const boundary = new Date("2026-01-01T00:30:00Z");
    const run1 = await startRun({ sessionId: "edge" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = boundary;
    const run2 = await startRun({ sessionId: "edge" });
    runs[1].startedAt = boundary;
    runs[1].completedAt = new Date("2026-01-01T01:00:00Z");

    // A single usage row timestamped EXACTLY on the shared boundary.
    // sonnet: 10k in + 2k out = 6 cents, 12_000 tokens.
    seedUsage({
      sessionId: "edge",
      createdAt: boundary,
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });

    const cost1 = await computeRunCost(run1);
    const cost2 = await computeRunCost(run2);

    // Inclusive-upper / exclusive-lower: the boundary row belongs to run1 only.
    expect(cost1.costCents).toBe(6);
    expect(cost1.totalTokens).toBe(12_000);
    // run2's lower bound is exclusive, so the boundary row is NOT counted here.
    expect(cost2.costCents).toBe(0);
    expect(cost2.totalTokens).toBe(0);
    // Sum across both runs equals the session total: the row is counted once.
    expect(cost1.costCents + cost2.costCents).toBe(6);
    expect(cost1.totalTokens + cost2.totalTokens).toBe(12_000);
  });

  it("uses now() as the upper bound when completedAt is null", async () => {
    const runId = await startRun({ sessionId: "open" });
    runs[0].startedAt = new Date(Date.now() - 60_000);
    runs[0].completedAt = null;
    seedUsage({
      sessionId: "open",
      createdAt: new Date(Date.now() - 30_000),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    const cost = await computeRunCost(runId);
    expect(cost.costCents).toBe(6);
  });

  it("finishRun persists a non-zero costCents when in-window usage exists", async () => {
    const runId = await startRun({ sessionId: "wire" });
    runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
    runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
    seedUsage({
      sessionId: "wire",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    const cost = await computeRunCost(runId);
    await finishRun({ runId, status: "completed", ...cost });
    expect(runs[0].costCents).toBe(6);
    expect(runs[0].totalTokens).toBe(12_000);
    expect(runs[0].status).toBe("completed");
  });
});

describe("replay/runs-service computeRunCost — cached input is priced once (#264)", () => {
  // Claude 3.5 Sonnet v2 on the gateway: 0.3c / 1k input, 0.03c / 1k cache read.
  const GATEWAY_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

  function windowedRun(sessionId: string): Promise<string> {
    return startRun({ sessionId }).then((id) => {
      runs[0].startedAt = new Date("2026-01-01T00:00:00Z");
      runs[0].completedAt = new Date("2026-01-01T01:00:00Z");
      return id;
    });
  }

  it("prices a gateway row whose prompt tokens are all cache reads at the cache-read rate only", async () => {
    const runId = await windowedRun("sess-gw");
    // OpenAI-compatible convention: the 1M prompt tokens INCLUDE the 1M reads.
    seedUsage({
      sessionId: "sess-gw",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "bedrock-gateway",
      model: GATEWAY_MODEL,
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      totalTokens: 1_000_000,
    });
    const cost = await computeRunCost(runId);
    // 1,000 × 0.03c = 30c. The double-billed figure was 300c + 30c = 330c.
    expect(cost.costCents).toBe(30);
    // The agent-run row a reader sees carries the corrected figure.
    await finishRun({ runId, status: "completed", ...cost });
    expect(runs[0].costCents).toBe(30);
  });

  it("normalises per row, so one malformed row cannot borrow another row's prompt tokens", async () => {
    const runId = await windowedRun("sess-rows");
    // Row 1 is malformed (more reads than prompt): its reads clamp to 0.
    seedUsage({
      sessionId: "sess-rows",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "bedrock-gateway",
      model: GATEWAY_MODEL,
      inputTokens: 0,
      cacheReadTokens: 1_000_000,
      totalTokens: 0,
    });
    // Row 2 is 1M fresh prompt tokens.
    seedUsage({
      sessionId: "sess-rows",
      createdAt: new Date("2026-01-01T00:20:00Z"),
      provider: "bedrock-gateway",
      model: GATEWAY_MODEL,
      inputTokens: 1_000_000,
      totalTokens: 1_000_000,
    });
    const cost = await computeRunCost(runId);
    // Row 2 alone at the input rate: 300c. Normalising the SUMMED group would
    // have read 1M prompt with 1M reads and billed 30c.
    expect(cost.costCents).toBe(300);
  });

  it("reports the corrected token total even for a row written before the fix (#264 review)", async () => {
    const runId = await windowedRun("sess-legacy");
    // A pre-#248 gateway row: 1M prompt tokens that INCLUDE 1M cache reads,
    // stored with the double-counted total (prompt + reads + output).
    seedUsage({
      sessionId: "sess-legacy",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "bedrock-gateway",
      model: GATEWAY_MODEL,
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 500,
      totalTokens: 2_000_500,
    });
    const cost = await computeRunCost(runId);
    expect(cost.totalTokens).toBe(1_000_500);
  });

  it("leaves native Anthropic unchanged: input_tokens EXCLUDES the reads, so both are billed", async () => {
    const runId = await windowedRun("sess-native");
    seedUsage({
      sessionId: "sess-native",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    const cost = await computeRunCost(runId);
    // Sonnet: $3 / MTok input (300c) + $0.30 / MTok cache read (30c).
    expect(cost.costCents).toBe(330);
  });
});

describe("replay/runs-service reopenRun (#943)", () => {
  it("re-opens only the session's latest run of that kind", async () => {
    const older = await startRun({ sessionId: "an-1", kind: "analysis" });
    const runId = await startRun({ sessionId: "an-1", kind: "analysis" });
    await startRun({ sessionId: "an-1", kind: "chat" });
    runs[0].startedAt = new Date("2026-10-08T17:00:00Z");
    runs[1].startedAt = new Date("2026-10-08T17:35:56Z");
    runs[2].startedAt = new Date("2026-10-08T17:50:00Z");
    runs[0].status = "completed";
    runs[1].status = "completed";
    runs[1].completedAt = new Date("2026-10-08T17:41:16Z");
    runs[1].latencyMs = 320_000;
    runs[1].totalTokens = 900;

    const reopened = await reopenRun("an-1", "analysis");

    expect(reopened).toEqual({ id: runId, totalTokens: 900 });
    expect(runs[1]).toMatchObject({ status: "running", completedAt: null, latencyMs: null });
    // An earlier run of the session stays closed.
    expect(runs.find((r) => r.id === older)?.status).toBe("completed");
  });

  it("returns null when the session has no run of that kind", async () => {
    await startRun({ sessionId: "an-2", kind: "chat" });
    expect(await reopenRun("an-2", "analysis")).toBeNull();
    expect(await reopenRun("missing", "analysis")).toBeNull();
  });
});

describe("replay/runs-service — an analysis run is priced over its whole session (#943)", () => {
  // 10k in + 2k out on claude-3-5-sonnet = 6 cents a row.
  const seedRow = (sessionId: string, at: string) =>
    seedUsage({ sessionId, createdAt: new Date(at), inputTokens: 10_000, outputTokens: 2_000 });

  async function closedRun(sessionId: string, kind: "analysis" | "chat"): Promise<string> {
    const id = await startRun({ sessionId, kind });
    const run = runs.find((r) => r.id === id)!;
    run.startedAt = new Date("2026-10-08T17:35:56Z");
    run.completedAt = new Date("2026-10-08T17:41:16Z");
    run.status = "completed";
    return id;
  }

  it("counts spend after the run finished for an analysis, but not for a chat", async () => {
    const analysisRun = await closedRun("an-1", "analysis");
    const chatRun = await closedRun("chat-1", "chat");
    for (const session of ["an-1", "chat-1"]) {
      seedRow(session, "2026-10-08T17:40:00Z");
      // A regenerate on the finished analysis, 18 minutes later.
      seedRow(session, "2026-10-08T17:59:50Z");
    }

    expect((await computeRunCost(analysisRun)).costCents).toBe(12);
    expect((await computeRunCost(chatRun)).costCents).toBe(6);
  });

  it("getRun shows an analysis run's live cost, not the stale stored one", async () => {
    const analysisRun = await closedRun("an-1", "analysis");
    const chatRun = await closedRun("chat-1", "chat");
    runs.forEach((r) => (r.costCents = 6));
    for (const session of ["an-1", "chat-1"]) {
      seedRow(session, "2026-10-08T17:40:00Z");
      seedRow(session, "2026-10-08T17:59:50Z");
    }

    expect((await getRun(analysisRun))?.run.costCents).toBe(12);
    expect((await getRun(chatRun))?.run.costCents).toBe(6);
  });
});

describe("replay/runs-service — exact, unrounded run cost (#977)", () => {
  // claude-3-5-sonnet input is 0.3¢ per 1k tokens: a 1k-token chat turn costs
  // 0.3¢, which whole cents round to 0 — and a 1.7k one (0.51¢) to a full 1¢.
  async function windowRun(sessionId: string): Promise<string> {
    const id = await startRun({ sessionId });
    const run = runs.find((r) => r.id === id)!;
    run.startedAt = new Date("2026-01-01T00:00:00Z");
    run.completedAt = new Date("2026-01-01T01:00:00Z");
    return id;
  }

  it("computeRunCost reports the sub-cent cost in costUsd, rounding only costCents", async () => {
    const runId = await windowRun("turn-1");
    seedUsage({
      sessionId: "turn-1",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      inputTokens: 1_700,
    });
    const cost = await computeRunCost(runId);
    expect(cost.costCents).toBe(1);
    expect(cost.costUsd).toBeCloseTo(0.0051, 10);
  });

  it("prices each Haiku 5.5 row in its own prompt-length tier before summing (#1080)", async () => {
    const runId = await windowRun("haiku-55");
    const row = (minute: number, inputTokens: number, cacheReadTokens = 0) =>
      seedUsage({
        sessionId: "haiku-55",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        createdAt: new Date(`2026-01-01T00:${String(minute).padStart(2, "0")}:00Z`),
        inputTokens,
        cacheReadTokens,
      });
    // Two 60,000-token requests — 120,000 together, each under the 100,000
    // threshold: 120,000 × $0.10/M = 1.2¢.
    row(10, 60_000);
    row(11, 60_000);
    // One request over it, counting its cache read (50,000 + 100,000):
    // 50,000 × $0.50/M + 100,000 × $0.05/M = 2.5¢ + 0.5¢.
    row(12, 50_000, 100_000);
    const cost = await computeRunCost(runId);
    // Pricing the 270,000 summed tokens as one request gives 9¢:
    // 170,000 × $0.50/M + 100,000 × $0.05/M = 8.5¢ + 0.5¢ (measured with
    // `runs-service.ts` reverted to its base: `costUsd` 0.09).
    expect(cost.costUsd).toBeCloseTo(0.042, 10);
    expect(cost.costCents).toBe(4);
    expect(cost.totalTokens).toBe(270_000);
  });

  it("rounds a multi-model run once, not once per model", async () => {
    // 0.45¢ on each of two models: per-model rounding gave 0 + 0 = 0¢.
    const runId = await windowRun("turn-2");
    seedUsage({
      sessionId: "turn-2",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      inputTokens: 1_500,
    });
    seedUsage({
      sessionId: "turn-2",
      provider: "openai",
      model: "gpt-4o",
      createdAt: new Date("2026-01-01T00:11:00Z"),
      inputTokens: 1_800,
    });
    const cost = await computeRunCost(runId);
    expect(cost.costUsd).toBeCloseTo(0.009, 10);
    expect(cost.costCents).toBe(1);
  });

  it("listRuns carries each run's unrounded costUsd over its own window and session", async () => {
    const a = await windowRun("list-a");
    const b = await windowRun("list-b");
    seedUsage({
      sessionId: "list-a",
      createdAt: new Date("2026-01-01T00:10:00Z"),
      inputTokens: 1_000,
    });
    // Outside run A's window — never billed to it.
    seedUsage({
      sessionId: "list-a",
      createdAt: new Date("2026-01-01T02:00:00Z"),
      inputTokens: 9_000,
    });
    seedUsage({
      sessionId: "list-b",
      createdAt: new Date("2026-01-01T00:20:00Z"),
      inputTokens: 2_000,
    });

    const items = await listRuns({});
    const byId = new Map(items.map((r) => [r.id, r]));
    expect(byId.get(a)!.costUsd).toBeCloseTo(0.003, 10);
    expect(byId.get(b)!.costUsd).toBeCloseTo(0.006, 10);
  });

  it("listRuns still lists runs, with costUsd null, when the ledger cannot be read", async () => {
    const a = await windowRun("list-c");
    runs[0].costCents = 4;
    usageReadFails = true;
    const items = await listRuns({});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: a, costCents: 4, costUsd: null });
  });
});

describe("replay/runs-service — run tokens read the ledger (#1007)", () => {
  async function run(
    sessionId: string,
    opts: { kind?: "analysis" | "chat"; projectId?: string; running?: boolean } = {},
  ): Promise<string> {
    const id = await startRun({ sessionId, kind: opts.kind, projectId: opts.projectId });
    const row = runs.find((r) => r.id === id)!;
    row.startedAt = new Date("2026-01-01T00:00:00Z");
    row.completedAt = opts.running ? null : new Date("2026-01-01T01:00:00Z");
    if (!opts.running) row.status = "completed";
    return id;
  }
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));

  it("reports tokens with and without cache, each cached token once", async () => {
    const id = await run("tok-1");
    // Native Anthropic: input excludes the cache fields.
    seedUsage({
      sessionId: "tok-1",
      createdAt: at(10),
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 3_000,
      cacheWriteTokens: 500,
    });
    // OpenAI convention: the 800 prompt tokens INCLUDE the 600 cache reads.
    seedUsage({
      sessionId: "tok-1",
      provider: "openai",
      model: "gpt-4o",
      createdAt: at(11),
      inputTokens: 800,
      outputTokens: 50,
      cacheReadTokens: 600,
    });
    const cost = await computeRunCost(id);
    expect(cost.tokens).toEqual({
      withoutCache: 1_000 + 200 + (800 - 600) + 50,
      withCache: 1_000 + 200 + 3_000 + 500 + 800 + 50,
    });
    expect(cost.totalTokens).toBe(cost.tokens.withCache);
  });

  it("listRuns reads each run's tokens from the ledger, not the stored column", async () => {
    const id = await run("tok-list", { kind: "analysis" });
    runs.find((r) => r.id === id)!.totalTokens = 439_244;
    seedUsage({ sessionId: "tok-list", createdAt: at(10), inputTokens: 400, outputTokens: 57 });
    seedUsage({ sessionId: "tok-list", createdAt: at(11), inputTokens: 1, cacheReadTokens: 87 });
    // After the run finished: an analysis run still counts it (#943).
    seedUsage({
      sessionId: "tok-list",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      inputTokens: 2,
    });
    const [item] = await listRuns({});
    expect(item!.tokens).toEqual({ withoutCache: 460, withCache: 547 });
    expect(item!.totalTokens).toBe(439_244);
  });

  it("a run that is going shows its ledger total so far; one with no row yet shows zero", async () => {
    const going = await run("tok-going", { running: true });
    const quiet = await run("tok-quiet", { running: true });
    seedUsage({
      sessionId: "tok-going",
      createdAt: new Date(Date.now() - 1_000),
      inputTokens: 700,
      cacheReadTokens: 50,
    });
    // The fake stamps `startedAt` at creation; open the window for the row.
    runs.find((r) => r.id === going)!.startedAt = new Date(Date.now() - 60_000);
    const items = await listRuns({});
    const byId = new Map(items.map((r) => [r.id, r]));
    expect(byId.get(going)).toMatchObject({
      status: "running",
      totalTokens: 0,
      tokens: { withoutCache: 700, withCache: 750 },
    });
    expect(byId.get(quiet)!.tokens).toEqual({ withoutCache: 0, withCache: 0 });
  });

  it("windows a chat-kind run's tokens exactly as its cost", async () => {
    const id = await run("tok-win", { kind: "chat" });
    seedUsage({ sessionId: "tok-win", createdAt: at(10), inputTokens: 100 });
    seedUsage({
      sessionId: "tok-win",
      createdAt: new Date("2026-01-01T02:00:00Z"),
      inputTokens: 9_000,
    });
    const [item] = await listRuns({});
    expect(item!.id).toBe(id);
    expect(item!.tokens).toEqual({ withoutCache: 100, withCache: 100 });
    expect((await computeRunCost(id)).tokens).toEqual(item!.tokens);
  });

  it("counts only the run's own project's rows, in the list and for one run", async () => {
    const id = await run("tok-scope", { kind: "analysis", projectId: "p-a" });
    seedUsage({ sessionId: "tok-scope", projectId: "p-a", createdAt: at(10), inputTokens: 300 });
    // The same session id billed to another project.
    seedUsage({
      sessionId: "tok-scope",
      projectId: "p-other",
      createdAt: at(11),
      inputTokens: 7_000,
    });
    const [item] = await listRuns({});
    expect(item!.tokens).toEqual({ withoutCache: 300, withCache: 300 });
    expect(item!.costUsd).toBeCloseTo(0.0009, 10);
    const cost = await computeRunCost(id);
    expect(cost.tokens).toEqual({ withoutCache: 300, withCache: 300 });
    expect(cost.costUsd).toBeCloseTo(0.0009, 10);
  });

  it("a project-less run is not narrowed by project", async () => {
    const id = await run("tok-system", { kind: "analysis" });
    seedUsage({ sessionId: "tok-system", projectId: "p-x", createdAt: at(10), inputTokens: 40 });
    expect((await computeRunCost(id)).tokens.withCache).toBe(40);
    expect((await listRuns({}))[0]!.tokens!.withCache).toBe(40);
  });

  it("getRun carries the ledger tokens for every kind of run", async () => {
    const analysis = await run("tok-get-a", { kind: "analysis" });
    const chat = await run("tok-get-c", { kind: "chat" });
    seedUsage({ sessionId: "tok-get-a", createdAt: at(10), inputTokens: 10, cacheReadTokens: 5 });
    seedUsage({ sessionId: "tok-get-c", createdAt: at(10), inputTokens: 20, outputTokens: 1 });
    expect((await getRun(analysis))!.run.tokens).toEqual({ withoutCache: 10, withCache: 15 });
    expect((await getRun(chat))!.run.tokens).toEqual({ withoutCache: 21, withCache: 21 });
  });

  it("getRun reads every kind of run's cost from the ledger, as the list does", async () => {
    const chat = await run("tok-cost-c", { kind: "chat" });
    // The column written at finish is stale: the ledger holds 30¢ for this run.
    runs.find((r) => r.id === chat)!.costCents = 7;
    seedUsage({ sessionId: "tok-cost-c", createdAt: at(10), inputTokens: 100_000 });
    const detail = await getRun(chat);
    const [item] = await listRuns({});
    expect(detail!.run.costCents).toBe(30);
    expect(detail!.run.costUsd).toBeCloseTo(0.3, 10);
    expect(item!.costUsd).toBeCloseTo(0.3, 10);
    expect(detail!.run.tokens).toEqual({ withoutCache: 100_000, withCache: 100_000 });
  });

  describe("the cost is the STORED ledger cost (review of #1112)", () => {
    it("is what the row was recorded at, not the tokens at today's rate card", async () => {
      const id = await run("stored-cost", { kind: "analysis" });
      // 100,000 Sonnet input tokens are 30¢ at today's rates; the ledger holds 7¢.
      seedUsage({
        sessionId: "stored-cost",
        createdAt: at(10),
        inputTokens: 100_000,
        costUsd: 0.07,
      });
      const cost = await computeRunCost(id);
      expect(cost.costUsd).toBeCloseTo(0.07, 12);
      expect(cost.costCents).toBe(7);
      expect((await listRuns({}))[0]!.costUsd).toBeCloseTo(0.07, 12);
      expect((await getRun(id))!.run).toMatchObject({ costCents: 7, unpricedTokens: 0 });
    });

    it("reads a row from before #761 from its whole-cent column", async () => {
      const id = await run("legacy-cost", { kind: "analysis" });
      seedUsage({
        sessionId: "legacy-cost",
        createdAt: at(10),
        inputTokens: 100_000,
        costUsd: null,
        costCents: 12,
      });
      expect((await computeRunCost(id)).costUsd).toBeCloseTo(0.12, 12);
    });

    it("does not price a row the ledger holds as unpriced, though a rate exists today", async () => {
      const id = await run("unpriced-row", { kind: "analysis" });
      seedUsage({
        sessionId: "unpriced-row",
        createdAt: at(10),
        inputTokens: 1_000_000,
        costUsd: 1,
      });
      // Recorded unpriced: 100,000 tokens of a model that has a price now.
      seedUsage({
        sessionId: "unpriced-row",
        createdAt: at(11),
        inputTokens: 60_000,
        cacheReadTokens: 40_000,
        costUsd: null,
        costCents: null,
      });
      const cost = await computeRunCost(id);
      expect(cost.costUsd).toBe(1);
      expect(cost.unpricedTokens).toBe(100_000);
      const [item] = await listRuns({});
      expect(item).toMatchObject({ costUsd: 1, unpricedTokens: 100_000 });
      expect((await getRun(id))!.run).toMatchObject({
        costCents: 100,
        costUsd: 1,
        unpricedTokens: 100_000,
      });
    });
  });

  describe("spend recorded after the run finished", () => {
    it("is in an analysis run's figure and reported apart", async () => {
      const id = await run("after", { kind: "analysis" });
      seedUsage({ sessionId: "after", createdAt: at(10), inputTokens: 1_000, outputTokens: 100 });
      // Exactly at the finish: the run's own.
      seedUsage({ sessionId: "after", createdAt: at(60), inputTokens: 5 });
      // A deep dive afterwards.
      seedUsage({
        sessionId: "after",
        createdAt: at(75),
        inputTokens: 300,
        outputTokens: 30,
        cacheReadTokens: 70,
      });
      const after = { withoutCache: 330, withCache: 400 };
      const cost = await computeRunCost(id);
      expect(cost.tokens).toEqual({ withoutCache: 1_435, withCache: 1_505 });
      expect(cost.tokensAfterRun).toEqual(after);
      expect((await listRuns({}))[0]!.tokensAfterRun).toEqual(after);
      expect((await getRun(id))!.run.tokensAfterRun).toEqual(after);
    });

    it("is zero for a run that is still going, and for a windowed run", async () => {
      const going = await run("after-going", { kind: "analysis", running: true });
      seedUsage({ sessionId: "after-going", createdAt: at(10), inputTokens: 50 });
      expect((await computeRunCost(going)).tokensAfterRun).toEqual({
        withoutCache: 0,
        withCache: 0,
      });
      const chat = await run("after-chat", { kind: "chat" });
      seedUsage({ sessionId: "after-chat", createdAt: at(75), inputTokens: 50 });
      const cost = await computeRunCost(chat);
      expect(cost.tokens).toEqual({ withoutCache: 0, withCache: 0 });
      expect(cost.tokensAfterRun).toEqual({ withoutCache: 0, withCache: 0 });
    });

    it("is null in the list and on the run when the ledger cannot be read", async () => {
      const id = await run("after-down", { kind: "analysis" });
      usageReadFails = true;
      expect((await listRuns({}))[0]).toMatchObject({ tokensAfterRun: null, unpricedTokens: null });
      expect((await getRun(id))!.run).toMatchObject({
        tokensAfterRun: null,
        unpricedTokens: null,
        costUsd: null,
      });
    });
  });

  describe("the list's ledger read", () => {
    it("names the page's projects, so the (projectId, createdAt) index is used", async () => {
      await run("idx-a", { kind: "analysis", projectId: "p-1" });
      await run("idx-b", { kind: "analysis", projectId: "p-2" });
      await run("idx-c", { kind: "analysis", projectId: "p-1" });
      await listRuns({});
      expect(ledgerWheres).toHaveLength(1);
      const where = ledgerWheres[0] as { projectId: { in: string[] }; sessionId: { in: string[] } };
      expect([...where.projectId.in].sort()).toEqual(["p-1", "p-2"]);
      expect([...where.sessionId.in].sort()).toEqual(["idx-a", "idx-b", "idx-c"]);
    });

    it("has no project term when the page holds a project-less run", async () => {
      await run("idx-system", { kind: "analysis" });
      await run("idx-d", { kind: "analysis", projectId: "p-1" });
      await listRuns({});
      expect(ledgerWheres[0]).not.toHaveProperty("projectId");
    });
  });

  describe("pageSize", () => {
    it("takes a positive whole number, capped; anything else is the default", () => {
      expect(pageSize(7, 50, 200)).toBe(7);
      expect(pageSize(7.9, 50, 200)).toBe(7);
      expect(pageSize(5_000, 50, 200)).toBe(200);
      for (const bad of [undefined, Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) {
        expect(pageSize(bad, 50, 200)).toBe(50);
      }
    });

    it("listRuns never hands Prisma a NaN or negative take", async () => {
      for (let i = 0; i < 3; i += 1) await run(`take-${i}`, { kind: "analysis" });
      expect(await listRuns({ limit: Number.NaN })).toHaveLength(3);
      expect(await listRuns({ limit: -2 })).toHaveLength(3);
      expect(await listRuns({ limit: 2 })).toHaveLength(2);
    });
  });

  it("tokens are null, and the run still loads, when the ledger cannot be read", async () => {
    const id = await run("tok-down", { kind: "analysis" });
    runs.find((r) => r.id === id)!.costCents = 4;
    usageReadFails = true;
    const [item] = await listRuns({});
    expect(item).toMatchObject({ id, tokens: null, costUsd: null });
    const detail = await getRun(id);
    expect(detail!.run).toMatchObject({ id, tokens: null, costCents: 4 });
  });

  it("splits a summed row into its requests for the tokens as for the cost (#1080)", async () => {
    const id = await run("tok-summed", { kind: "analysis" });
    // One row summing two Haiku 5.5 requests of 60,000 prompt tokens each.
    seedUsage({
      sessionId: "tok-summed",
      model: "claude-haiku-5-5",
      createdAt: at(10),
      inputTokens: 120_000,
      outputTokens: 200,
      requestTokens: JSON.stringify([
        [60_000, 100, 0, 0],
        [60_000, 100, 0, 0],
      ]),
    });
    const cost = await computeRunCost(id);
    expect(cost.tokens).toEqual({ withoutCache: 120_200, withCache: 120_200 });
    // 120,000 × $0.10/M + 200 × $0.50/M: each request under the 100,000 threshold.
    expect(cost.costUsd).toBeCloseTo(0.0121, 10);
  });
});
