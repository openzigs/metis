/**
 * #1422 — `threadCpuMs` is the clock the linear-time checks read so that a
 * starved test worker cannot fail them. What makes it load-independent is that
 * time spent NOT running is not counted, so that is what is pinned: a wait
 * accrues (almost) nothing, where `performance.now()` accrues all of it.
 */
import { describe, expect, it } from "vitest";

import { threadCpuMs } from "./linear-time.js";

describe("threadCpuMs", () => {
  it("does not count time the thread spends waiting", async () => {
    const cpu0 = threadCpuMs();
    const wall0 = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const wall = performance.now() - wall0;
    const cpu = threadCpuMs() - cpu0;
    expect(wall).toBeGreaterThanOrEqual(190);
    // Waking the timer costs microseconds; 50 ms is a quarter of the wait.
    expect(cpu).toBeLessThan(50);
  });

  it("counts work the thread does", () => {
    const cpu0 = threadCpuMs();
    let x = 0;
    for (let i = 0; i < 20_000_000; i++) x = (x + i) % 7919;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(threadCpuMs()).toBeGreaterThan(cpu0);
  });
});
