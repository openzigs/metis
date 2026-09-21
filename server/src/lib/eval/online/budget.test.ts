/**
 * Issue #1321 — online-eval token budget.
 *
 * The acceptance criterion is "a separate token budget, enforced BEFORE the
 * call and not merely reported", so these tests assert the *debit* happens at
 * reservation time and survives a read-back through a fresh instance (the
 * ledger has to be durable, not just an in-memory counter).
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OnlineEvalBudget, monthBucketUTC } from "./budget.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "online-budget-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const at = (iso: string) => () => new Date(iso);

describe("OnlineEvalBudget", () => {
  it("debits the reservation up front, before any judge call could run", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: at("2026-08-15T00:00:00Z") });
    const d = await b.reserve(400);
    expect(d.allowed).toBe(true);
    expect(d.reserved).toBe(400);
    // The debit is visible immediately — not after a settle().
    expect((await b.status()).tokensUsed).toBe(400);
  });

  it("denies the reservation that would cross the cap, and does not debit it", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: at("2026-08-15T00:00:00Z") });
    await b.reserve(800);
    const denied = await b.reserve(400);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("MONTHLY_BUDGET_EXCEEDED");
    expect(denied.reserved).toBe(0);
    expect((await b.status()).tokensUsed).toBe(800);
  });

  it("fails closed when no budget is configured", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 0, now: at("2026-08-15T00:00:00Z") });
    const d = await b.reserve(1);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("NO_BUDGET_CONFIGURED");
  });

  it("persists the ledger — a fresh instance reads back the same spend", async () => {
    const now = at("2026-08-15T00:00:00Z");
    const first = new OnlineEvalBudget({ dir, cap: () => 1000, now });
    await first.reserve(600);

    // Read back through a brand-new instance (a restart), not the object we wrote.
    const second = new OnlineEvalBudget({ dir, cap: () => 1000, now });
    const state = await second.status();
    expect(state.tokensUsed).toBe(600);
    expect(state.calls).toBe(1);
    const denied = await second.reserve(500);
    expect(denied.allowed).toBe(false);
  });

  it("settles a reservation against the actual usage", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: at("2026-08-15T00:00:00Z") });
    const d = await b.reserve(500);
    await b.settle(d.reserved, 120);
    expect((await b.status()).tokensUsed).toBe(120);
    // The refunded headroom is usable again.
    expect((await b.reserve(800)).allowed).toBe(true);
  });

  it("never lets settle drive the ledger below zero", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: at("2026-08-15T00:00:00Z") });
    const d = await b.reserve(100);
    await b.settle(d.reserved, 0);
    await b.settle(500, 0);
    expect((await b.status()).tokensUsed).toBe(0);
  });

  it("starts a fresh allowance in a new calendar month", async () => {
    let clock = new Date("2026-08-31T23:00:00Z");
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: () => clock });
    await b.reserve(1000);
    expect((await b.reserve(1)).allowed).toBe(false);

    clock = new Date("2026-09-01T00:00:00Z");
    const next = await b.reserve(1000);
    expect(next.allowed).toBe(true);
    expect(next.state.monthBucket).toBe("2026-09");
  });

  it("serialises concurrent reservations so only the affordable ones are granted", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: at("2026-08-15T00:00:00Z") });
    const results = await Promise.all([
      b.reserve(400),
      b.reserve(400),
      b.reserve(400),
      b.reserve(400),
    ]);
    expect(results.filter((r) => r.allowed)).toHaveLength(2);
    expect((await b.status()).tokensUsed).toBe(800);
  });

  it("ignores a corrupt ledger file rather than throwing", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "budget.json"), "{not json", "utf8");
    const b = new OnlineEvalBudget({ dir, cap: () => 100, now: at("2026-08-15T00:00:00Z") });
    expect((await b.reserve(10)).allowed).toBe(true);
  });

  it("refund() walks back BOTH the tokens and the call count", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: at("2026-08-15T00:00:00Z") });
    const d = await b.reserve(400);
    expect((await b.status()).calls).toBe(1);

    const after = await b.refund(d.reserved);
    expect(after.tokensUsed).toBe(0);
    // `settle(reserved, 0)` would leave `calls` at 1, making the operator's
    // counter report reservations rather than completed judge calls.
    expect(after.calls).toBe(0);
  });

  it("refund() never drives either counter below zero", async () => {
    const b = new OnlineEvalBudget({ dir, cap: () => 1000, now: at("2026-08-15T00:00:00Z") });
    const after = await b.refund(9_999);
    expect(after.tokensUsed).toBe(0);
    expect(after.calls).toBe(0);
  });

  it("follows a results-dir change instead of pinning the constructor value", async () => {
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "online-budget-b-"));
    try {
      let target = dir;
      const b = new OnlineEvalBudget({
        dir: () => target,
        cap: () => 1000,
        now: at("2026-08-15T00:00:00Z"),
      });
      await b.reserve(400);
      expect(await fs.readdir(dir)).toContain("budget.json");

      target = second;
      // A fresh directory means a fresh ledger — the cached state must not
      // leak across the move.
      expect((await b.status()).tokensUsed).toBe(0);
      await b.reserve(100);
      expect(await fs.readdir(second)).toContain("budget.json");
      expect((await b.status()).tokensUsed).toBe(100);
    } finally {
      await fs.rm(second, { recursive: true, force: true });
    }
  });
});

describe("monthBucketUTC", () => {
  it("buckets by UTC year-month", () => {
    expect(monthBucketUTC(new Date("2026-01-31T23:59:59Z"))).toBe("2026-01");
    expect(monthBucketUTC(new Date("2026-02-01T00:00:00Z"))).toBe("2026-02");
  });
});
