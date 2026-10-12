/**
 * #1007 (review of #1112, cycle 2) — the polled-summary cache is BOUNDED.
 * `sessionLedgerSummary` remembers one summary per session so a header polled
 * every 2.5 s does not re-read the session's rows; without the bound it would
 * hold one for every analysis ever opened, for the life of the process.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { tokenUsage: { findMany } } }));

import {
  LEDGER_SESSION_BATCH,
  clearSessionLedgerSummaryCache,
  sessionLedgerSummary,
  sessionLedgerTokens,
} from "./ledger-usage-summary.js";

/** The bound under test: `SUMMARY_CACHE_MAX`. */
const BOUND = 256;

const row = (sessionId: string | null = null) => ({
  sessionId,
  provider: "anthropic",
  model: "claude-3-5-sonnet",
  inputTokens: 10,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 11,
  costUsd: 0.001,
  costCents: 0,
  requestTokens: null,
});

beforeEach(() => {
  clearSessionLedgerSummaryCache();
  findMany.mockReset();
  findMany.mockResolvedValue([row()]);
});

describe("sessionLedgerSummary — at most 256 sessions remembered", () => {
  const read = (n: number) => sessionLedgerSummary("p-1", `s-${n}`, "1");

  it("remembers 256 sessions: asking again reads nothing", async () => {
    for (let n = 0; n < BOUND; n += 1) await read(n);
    expect(findMany).toHaveBeenCalledTimes(BOUND);
    for (let n = 0; n < BOUND; n += 1) await read(n);
    expect(findMany).toHaveBeenCalledTimes(BOUND);
  });

  it("forgets the oldest when a 257th arrives, and only that one", async () => {
    for (let n = 0; n < BOUND; n += 1) await read(n);
    await read(BOUND);
    expect(findMany).toHaveBeenCalledTimes(BOUND + 1);

    // Every session but the first is still remembered…
    for (let n = 1; n <= BOUND; n += 1) await read(n);
    expect(findMany).toHaveBeenCalledTimes(BOUND + 1);
    // …and the first is read again.
    await read(0);
    expect(findMany).toHaveBeenCalledTimes(BOUND + 2);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { projectId: "p-1", sessionId: "s-0" } }),
    );
  });

  it("stays at the bound however many sessions pass through", async () => {
    for (let n = 0; n < 3 * BOUND; n += 1) await read(n);
    findMany.mockClear();
    // The newest 256 are remembered; nothing older is.
    for (let n = 2 * BOUND; n < 3 * BOUND; n += 1) await read(n);
    expect(findMany).not.toHaveBeenCalled();
    await read(2 * BOUND - 1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("sessionLedgerTokens — a project's sessions, however many", () => {
  it("names at most LEDGER_SESSION_BATCH session ids in a statement, and loses none", async () => {
    const ids = Array.from({ length: 2 * LEDGER_SESSION_BATCH + 7 }, (_, i) => `an-${i}`);
    findMany.mockImplementation(async (args: { where: { sessionId: { in: string[] } } }) =>
      args.where.sessionId.in.map((id) => row(id)),
    );
    const tokens = await sessionLedgerTokens("p-1", ids);
    expect(findMany).toHaveBeenCalledTimes(3);
    const sizes = findMany.mock.calls.map(
      ([args]) => (args as { where: { sessionId: { in: string[] } } }).where.sessionId.in.length,
    );
    expect(sizes).toEqual([LEDGER_SESSION_BATCH, LEDGER_SESSION_BATCH, 7]);
    for (const [args] of findMany.mock.calls) {
      expect((args as { where: { projectId: string } }).where.projectId).toBe("p-1");
    }
    expect(tokens.size).toBe(ids.length);
    expect(tokens.get("an-0")).toEqual({ withoutCache: 11, withCache: 11 });
    expect(tokens.get(`an-${ids.length - 1}`)).toEqual({ withoutCache: 11, withCache: 11 });
  });

  it("reads nothing for no sessions", async () => {
    expect((await sessionLedgerTokens("p-1", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
