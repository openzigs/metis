/**
 * #56 — pin the concurrency guards of the interrupted-generation sweep (#50/#53).
 *
 * The review of #53 showed each guard could be deleted with every test green:
 *
 * - the sweep's `updatedAt` compare-and-set, which stops it failing a LIVE run
 *   whose heartbeat lands between the sweep's read and its write;
 * - the heartbeat's `codeGraphHash: claim` guard, which stops a run that lost
 *   its claim from reviving a row another run now owns;
 * - the heartbeat's `status: "generating"` guard, which stops a finished or
 *   failed row being touched by a heartbeat that outlived its run.
 *
 * Prisma is an in-memory `generated_documents` table whose `updateMany` honours
 * every `where` field exactly, so removing a guard changes which rows match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  projectId: string;
  status: string;
  codeGraphHash: string | null;
  errorMessage: string | null;
  updatedAt: Date;
  deletedAt: Date | null;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  /** Runs after the sweep's read resolves and before its first write. */
  betweenReadAndWrite: null as null | (() => void),
}));

type Where = Record<string, unknown>;
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (cond && typeof cond === "object") {
      const c = cond as { lt?: Date };
      if (c.lt !== undefined) return value instanceof Date && value < c.lt;
      throw new Error(`unsupported where operator on ${key}`);
    }
    return (value ?? null) === (cond ?? null);
  });
}

vi.mock("../prisma.js", () => ({
  prisma: {
    generatedDocument: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        const hit = [...state.rows.values()]
          .filter((r) => matches(r, where))
          .map((r) => ({ ...r }));
        // The interleaving point: anything scheduled here happens after the
        // sweep has read its snapshot and before it writes.
        const between = state.betweenReadAndWrite;
        state.betweenReadAndWrite = null;
        between?.();
        return hit;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Where }) => {
        const hit = [...state.rows.values()].filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }),
    },
  },
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const failedEvent = vi.hoisted(() => vi.fn());
vi.mock("../socket/job-events.js", () => ({ jobEvents: { failed: failedEvent } }));

import {
  GENERATING_STALE_MS,
  GENERATION_INTERRUPTED_MESSAGE,
  failInterruptedGenerations,
  startGenerationHeartbeat,
} from "./interrupted-generations.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const STALE = new Date(NOW.getTime() - GENERATING_STALE_MS - 60_000);

function seed(overrides: Partial<Row> = {}): Row {
  const row: Row = {
    id: "doc-1",
    projectId: "proj-1",
    status: "generating",
    codeGraphHash: "claim-mine",
    errorMessage: null,
    updatedAt: STALE,
    deletedAt: null,
    ...overrides,
  };
  state.rows.set(row.id, row);
  return row;
}

function row(id = "doc-1"): Row {
  return state.rows.get(id) as Row;
}

beforeEach(() => {
  state.rows.clear();
  state.betweenReadAndWrite = null;
  failedEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("failInterruptedGenerations — updatedAt compare-and-set (#56)", () => {
  it("fails a row whose heartbeat really stopped (control)", async () => {
    seed();
    await expect(failInterruptedGenerations(NOW)).resolves.toBe(1);
    expect(row()).toMatchObject({
      status: "failed",
      errorMessage: GENERATION_INTERRUPTED_MESSAGE,
      codeGraphHash: null,
    });
    expect(failedEvent).toHaveBeenCalledOnce();
  });

  it("leaves a live run alone when its heartbeat lands between the sweep's read and write", async () => {
    seed();
    // The live run's heartbeat: same status, same claim — only updatedAt moves.
    state.betweenReadAndWrite = () => {
      row().updatedAt = new Date(NOW.getTime() - 1_000);
    };

    await expect(failInterruptedGenerations(NOW)).resolves.toBe(0);

    expect(row()).toMatchObject({
      status: "generating",
      codeGraphHash: "claim-mine",
      errorMessage: null,
    });
    expect(failedEvent).not.toHaveBeenCalled();
  });
});

describe("startGenerationHeartbeat — claim and status guards (#56)", () => {
  async function beatOnce(claim: string): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stop = startGenerationHeartbeat("doc-1", "proj-1", claim, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    stop();
  }

  it("refreshes the row of the run that holds the claim (control)", async () => {
    seed();
    await beatOnce("claim-mine");
    expect(row().updatedAt.getTime()).toBe(NOW.getTime() + 1_000);
  });

  it("writes nothing for a run that lost its claim", async () => {
    // Another run re-claimed the row; the old run's timer is still ticking.
    seed({ codeGraphHash: "claim-other" });
    await beatOnce("claim-mine");
    expect(row().updatedAt).toEqual(STALE);
    expect(row().codeGraphHash).toBe("claim-other");
  });

  it("writes nothing for a row that is no longer generating", async () => {
    // The row finished (or was failed) but still carries this run's claim.
    seed({ status: "failed", errorMessage: GENERATION_INTERRUPTED_MESSAGE });
    await beatOnce("claim-mine");
    expect(row().updatedAt).toEqual(STALE);
    expect(row().status).toBe("failed");
  });

  it("stops writing once the stop function is called", async () => {
    seed();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stop = startGenerationHeartbeat("doc-1", "proj-1", "claim-mine", 1_000);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(row().updatedAt).toEqual(STALE);
  });
});
