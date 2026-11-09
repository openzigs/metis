/**
 * #1959 — the retry every SERIALIZABLE transaction on the login and SCIM paths
 * now runs through. Its predicate, `isSerializationFailure`, is pinned in
 * `tests/lib/db/prisma-errors.test.ts`; the paths themselves are proven against
 * real SQLite and Postgres in `tests/helpers/write-conflict-retry-1959-suite.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  retryOnWriteConflict,
  WRITE_CONFLICT_ATTEMPTS,
  WRITE_CONFLICT_BACKOFF_MS,
} from "./write-conflict-retry.js";

/** Prisma's own code for a transaction aborted on a write conflict or deadlock. */
const p2034 = () => Object.assign(new Error("write conflict or deadlock"), { code: "P2034" });
/** What `@prisma/adapter-pg` throws for 40001 / 40P01: no Prisma code, a mapped cause. */
const adapterConflict = () =>
  Object.assign(new Error("TransactionWriteConflict"), {
    name: "DriverAdapterError",
    cause: { originalCode: "40001", kind: "TransactionWriteConflict" },
  });

describe("retryOnWriteConflict", () => {
  const noWait = () => vi.fn(async (_ms: number) => undefined);

  it("returns the first attempt's result without waiting", async () => {
    const sleep = noWait();
    const run = vi.fn(async () => "done");
    await expect(retryOnWriteConflict(run, { sleep })).resolves.toBe("done");
    expect(run).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["P2034", p2034],
    ["adapter-pg TransactionWriteConflict", adapterConflict],
  ])("runs the transaction again after a %s, backing off further each time", async (_, make) => {
    const sleep = noWait();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(make())
      .mockRejectedValueOnce(make())
      .mockResolvedValueOnce("won");
    await expect(retryOnWriteConflict(run, { sleep })).resolves.toBe("won");
    expect(run).toHaveBeenCalledTimes(3);
    const [first, second] = sleep.mock.calls.map(([ms]) => ms);
    expect(first).toBeGreaterThanOrEqual(WRITE_CONFLICT_BACKOFF_MS);
    expect(first).toBeLessThan(WRITE_CONFLICT_BACKOFF_MS * 2);
    expect(second).toBeGreaterThanOrEqual(WRITE_CONFLICT_BACKOFF_MS * 2);
    expect(second).toBeLessThan(WRITE_CONFLICT_BACKOFF_MS * 3);
  });

  it("surfaces the last conflict once every attempt lost one", async () => {
    const last = adapterConflict();
    const run = vi
      .fn<() => Promise<never>>()
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(p2034())
      .mockRejectedValueOnce(last);
    await expect(retryOnWriteConflict(run, { sleep: noWait() })).rejects.toBe(last);
    expect(run).toHaveBeenCalledTimes(WRITE_CONFLICT_ATTEMPTS);
  });

  it("answers the caller's named error instead, given the last conflict", async () => {
    const last = p2034();
    const exhausted = vi.fn(() => new Error("try again"));
    const run = vi.fn(async () => {
      throw last;
    });
    await expect(
      retryOnWriteConflict(run, { attempts: 2, exhausted, sleep: noWait() }),
    ).rejects.toThrow("try again");
    expect(run).toHaveBeenCalledTimes(2);
    expect(exhausted).toHaveBeenCalledWith(last);
  });

  it("never retries any other error", async () => {
    const sleep = noWait();
    const failure = Object.assign(new Error("dup"), { code: "P2002" });
    const run = vi.fn(async () => {
      throw failure;
    });
    await expect(
      retryOnWriteConflict(run, { sleep, exhausted: () => new Error("x") }),
    ).rejects.toBe(failure);
    expect(run).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  // #1971 — a caller whose re-read judges the other writer's row may retry more.
  it("runs the transaction again after an error the caller names, and only that one", async () => {
    const sleep = noWait();
    const dup = () => Object.assign(new Error("dup"), { code: "P2002" });
    const alsoRetry = (error: unknown) => (error as { code?: string }).code === "P2002";
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(dup())
      .mockRejectedValueOnce(p2034())
      .mockResolvedValueOnce("won");
    await expect(retryOnWriteConflict(run, { sleep, alsoRetry })).resolves.toBe("won");
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);

    const other = new Error("boom");
    const failing = vi.fn(async () => {
      throw other;
    });
    await expect(retryOnWriteConflict(failing, { sleep, alsoRetry })).rejects.toBe(other);
    expect(failing).toHaveBeenCalledOnce();
  });

  it("answers the caller's named error once every attempt lost the error it named", async () => {
    const dup = Object.assign(new Error("dup"), { code: "P2002" });
    const exhausted = vi.fn(() => new Error("try again"));
    const run = vi.fn(async () => {
      throw dup;
    });
    await expect(
      retryOnWriteConflict(run, { exhausted, alsoRetry: () => true, sleep: noWait() }),
    ).rejects.toThrow("try again");
    expect(run).toHaveBeenCalledTimes(WRITE_CONFLICT_ATTEMPTS);
    expect(exhausted).toHaveBeenCalledWith(dup);
  });

  it("waits on a real timer by default", async () => {
    vi.useFakeTimers();
    try {
      const run = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(p2034())
        .mockResolvedValueOnce("won");
      const result = retryOnWriteConflict(run);
      await vi.advanceTimersByTimeAsync(WRITE_CONFLICT_BACKOFF_MS * 2);
      await expect(result).resolves.toBe("won");
    } finally {
      vi.useRealTimers();
    }
  });
});
