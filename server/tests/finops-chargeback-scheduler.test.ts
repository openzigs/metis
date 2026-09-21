/**
 * Unit tests for the chargeback cron scheduler (Epic #47 / Issue #52).
 * Verifies the AC cron `0 6 1 * *` resolves to 06:00 UTC on the 1st of the
 * next month and the handle stops cleanly.
 */
import { describe, expect, it, vi } from "vitest";

const { runMonthlyChargeback } = vi.hoisted(() => ({
  runMonthlyChargeback: vi.fn(async () => ({ workspaces: 0, emailsSent: 0 })),
}));
vi.mock("../src/lib/finops/chargeback-report.js", () => ({
  runMonthlyChargeback,
}));

import {
  CHARGEBACK_CRON,
  startChargebackScheduler,
} from "../src/lib/finops/chargeback-scheduler.js";

describe("chargeback scheduler", () => {
  it("uses the AC cron expression 0 6 1 * *", () => {
    expect(CHARGEBACK_CRON).toBe("0 6 1 * *");
  });

  it("schedules the next run for 06:00 UTC on the 1st of a month", () => {
    const handle = startChargebackScheduler();
    const next = handle.nextRun();
    expect(next).not.toBeNull();
    const d = next as Date;
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(6);
    expect(d.getUTCMinutes()).toBe(0);
    handle.stop();
  });

  it("stops without throwing", () => {
    const handle = startChargebackScheduler();
    expect(() => handle.stop()).not.toThrow();
  });

  it("invokes runMonthlyChargeback when the cron fires", async () => {
    runMonthlyChargeback.mockClear();
    // Fire every second so the callback runs within the test window.
    const handle = startChargebackScheduler({}, "* * * * * *");
    await vi.waitFor(() => expect(runMonthlyChargeback).toHaveBeenCalled(), {
      timeout: 3000,
      interval: 100,
    });
    handle.stop();
  });

  it("swallows a chargeback-run rejection inside the cron callback", async () => {
    runMonthlyChargeback.mockClear();
    runMonthlyChargeback.mockRejectedValueOnce(new Error("run blew up"));
    const handle = startChargebackScheduler({}, "* * * * * *");
    await vi.waitFor(() => expect(runMonthlyChargeback).toHaveBeenCalled(), {
      timeout: 3000,
      interval: 100,
    });
    // No unhandled rejection should escape; the handle still stops cleanly.
    expect(() => handle.stop()).not.toThrow();
  });
});
