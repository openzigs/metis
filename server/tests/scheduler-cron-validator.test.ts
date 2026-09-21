/**
 * Cron expression validation — Phase 11.
 */
import { describe, expect, it } from "vitest";
import { nextRunOf, validateCron } from "../src/lib/scheduler/cron-validator.js";
import { SchedulerError } from "../src/lib/scheduler/types.js";

describe("validateCron()", () => {
  const from = new Date("2026-01-01T00:00:00.000Z");

  it("accepts a valid 5-field expression and returns next run", () => {
    const v = validateCron("*/5 * * * *", { minIntervalSec: 60, from });
    expect(v.expression).toBe("*/5 * * * *");
    expect(v.intervalMs).toBe(5 * 60 * 1000);
    expect(v.nextRun.getTime()).toBeGreaterThan(from.getTime());
  });

  it("accepts a valid 6-field expression with explicit minute interval", () => {
    const v = validateCron("0 */1 * * * *", { minIntervalSec: 60, from });
    // every minute -> 60s interval
    expect(v.intervalMs).toBe(60_000);
  });

  it("rejects an empty expression", () => {
    expect(() => validateCron("", { minIntervalSec: 60 })).toThrow(SchedulerError);
    expect(() => validateCron("   ", { minIntervalSec: 60 })).toThrow(/required/);
  });

  it("rejects garbage syntax", () => {
    expect(() => validateCron("not a cron", { minIntervalSec: 60 })).toThrow(SchedulerError);
  });

  it("rejects expressions that fire more often than the minimum interval", () => {
    // every-second fires at 1s intervals — must be rejected at 60s minimum.
    expect(() => validateCron("* * * * * *", { minIntervalSec: 60, from })).toThrow(
      /below the minimum/,
    );
  });

  it("allows shorter intervals when the minimum is lowered", () => {
    const v = validateCron("* * * * * *", { minIntervalSec: 1, from });
    expect(v.intervalMs).toBe(1000);
  });

  it("nextRunOf returns null on garbage", () => {
    expect(nextRunOf("not a cron")).toBeNull();
  });

  it("nextRunOf returns a date for a valid expression", () => {
    const next = nextRunOf("*/10 * * * *", from);
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });
});
