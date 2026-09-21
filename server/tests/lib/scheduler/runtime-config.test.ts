/**
 * Issue #260 — unit tests for the scheduler runtime-config subscriber.
 *
 * The subscriber rebuilds the cron loop on `SCHEDULER_ENABLED` and
 * `SCHEDULER_TICK_INTERVAL_MS` changes. We exercise the behaviours called
 * out by the AC:
 *
 *   - enable → start invoked
 *   - disable → stop invoked, start NOT invoked
 *   - tick interval change while enabled → stop + start (no double-fire)
 *   - tick interval change while disabled → no restart
 *   - same-value events → no-op
 *   - unrelated keys → ignored
 *   - burst of changes → serialized (no overlapping restart cycles)
 *   - unsubscribe detaches the listener
 *
 * The scheduler bootstrap is replaced with a stub that records each
 * stop/start call so we can assert order without touching real timers,
 * Prisma, or croner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigService, __resetConfigSingleton } from "../../../src/lib/config/index.js";
import type { SchedulerBootstrap } from "../../../src/lib/scheduler/index.js";
import { subscribeSchedulerToConfig } from "../../../src/lib/scheduler/runtime-config-subscriber.js";
import type { SchedulerConfig } from "../../../src/lib/scheduler/types.js";

interface FakeScheduler {
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  calls: string[];
}

function makeBootstrap(initial: Partial<SchedulerConfig> = {}): {
  bootstrap: SchedulerBootstrap;
  fake: FakeScheduler;
  config: SchedulerConfig;
} {
  const config: SchedulerConfig = {
    concurrency: 4,
    tickMs: 1000,
    defaultTimeoutMs: 60_000,
    retryBackoffMs: 1000,
    retryBackoffMaxMs: 60_000,
    minCronIntervalSec: 60,
    enabled: true,
    ...initial,
  };
  const calls: string[] = [];
  const stop = vi.fn(async () => {
    calls.push("stop");
  });
  const start = vi.fn(async () => {
    calls.push("start");
  });
  const bootstrap = {
    config,
    scheduler: { stop, start },
    queue: {},
    registry: {},
    emitter: {},
    shutdown: vi.fn(async () => undefined),
  } as unknown as SchedulerBootstrap;
  return { bootstrap, fake: { stop, start, calls }, config };
}

function makeConfigService(initialEnv: Record<string, string | undefined> = {}): ConfigService {
  const env: NodeJS.ProcessEnv = { ...initialEnv };
  return new ConfigService({ env });
}

function setEnv(svc: ConfigService, key: string, value: string | undefined): void {
  const env = (svc as unknown as { env: NodeJS.ProcessEnv }).env;
  if (value === undefined) {
    delete env[key];
  } else {
    env[key] = value;
  }
}

function emit(
  svc: ConfigService,
  key: string,
  oldValue: string | null,
  newValue: string | null,
): void {
  svc.emit("config.changed", {
    key,
    oldValue,
    newValue,
    scope: "global",
    tier: "tunable",
  });
}

async function flushQueue(): Promise<void> {
  // Two macrotask flushes — one for the inflight chain `then`, one for the
  // chained restart promise to settle.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("subscribeSchedulerToConfig (#260)", () => {
  beforeEach(() => {
    __resetConfigSingleton();
  });
  afterEach(() => {
    __resetConfigSingleton();
    vi.restoreAllMocks();
  });

  it("disables the scheduler on SCHEDULER_ENABLED=false (stops, no restart)", async () => {
    const { bootstrap, fake, config } = makeBootstrap({ enabled: true });
    const svc = makeConfigService({ SCHEDULER_ENABLED: "true" });
    const unsubscribe = subscribeSchedulerToConfig(bootstrap, { configService: svc });

    setEnv(svc, "SCHEDULER_ENABLED", "false");
    emit(svc, "SCHEDULER_ENABLED", "true", "false");
    await flushQueue();

    expect(config.enabled).toBe(false);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(fake.start).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("re-enables the scheduler on SCHEDULER_ENABLED=true (stops then starts)", async () => {
    const { bootstrap, fake, config } = makeBootstrap({ enabled: false });
    const svc = makeConfigService({ SCHEDULER_ENABLED: "false" });
    const unsubscribe = subscribeSchedulerToConfig(bootstrap, { configService: svc });

    setEnv(svc, "SCHEDULER_ENABLED", "true");
    emit(svc, "SCHEDULER_ENABLED", "false", "true");
    await flushQueue();

    expect(config.enabled).toBe(true);
    expect(fake.calls).toEqual(["stop", "start"]);

    unsubscribe();
  });

  it("restarts the scheduler when SCHEDULER_TICK_INTERVAL_MS changes while enabled", async () => {
    const { bootstrap, fake, config } = makeBootstrap({ enabled: true, tickMs: 1000 });
    const svc = makeConfigService({ SCHEDULER_TICK_INTERVAL_MS: "1000" });
    const unsubscribe = subscribeSchedulerToConfig(bootstrap, { configService: svc });

    setEnv(svc, "SCHEDULER_TICK_INTERVAL_MS", "2500");
    emit(svc, "SCHEDULER_TICK_INTERVAL_MS", "1000", "2500");
    await flushQueue();

    expect(config.tickMs).toBe(2500);
    // No double-fire — exactly one stop + one start across the restart.
    expect(fake.calls).toEqual(["stop", "start"]);
    expect(fake.stop).toHaveBeenCalledTimes(1);
    expect(fake.start).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("does NOT restart the scheduler when tick interval changes while disabled", async () => {
    const { bootstrap, fake, config } = makeBootstrap({ enabled: false, tickMs: 1000 });
    const svc = makeConfigService({ SCHEDULER_TICK_INTERVAL_MS: "1000" });
    const unsubscribe = subscribeSchedulerToConfig(bootstrap, { configService: svc });

    setEnv(svc, "SCHEDULER_TICK_INTERVAL_MS", "5000");
    emit(svc, "SCHEDULER_TICK_INTERVAL_MS", "1000", "5000");
    await flushQueue();

    expect(config.tickMs).toBe(5000);
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.stop).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("ignores config.changed events for unrelated keys", async () => {
    const { bootstrap, fake } = makeBootstrap();
    const svc = makeConfigService();
    const unsubscribe = subscribeSchedulerToConfig(bootstrap, { configService: svc });

    emit(svc, "PUBLISH_RATE_LIMIT_DELAY_MS", "1000", "2000");
    await flushQueue();

    expect(fake.stop).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("serializes a burst of changes — second cycle waits for first (no overlap)", async () => {
    const { bootstrap, fake, config } = makeBootstrap({ enabled: true, tickMs: 1000 });
    const svc = makeConfigService({
      SCHEDULER_ENABLED: "true",
      SCHEDULER_TICK_INTERVAL_MS: "1000",
    });
    fake.stop.mockReset();
    fake.start.mockReset();
    fake.stop.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      fake.calls.push("stop");
    });
    fake.start.mockImplementation(async () => {
      fake.calls.push("start");
    });
    const unsubscribe = subscribeSchedulerToConfig(bootstrap, { configService: svc });

    // Two events back-to-back. The second is applied AFTER the first cycle
    // finishes — it observes the up-to-date `cfg.tickMs` left by the first
    // restart and applies the new delta. Coalescing into a single restart
    // is acceptable behaviour as long as no overlap occurs.
    setEnv(svc, "SCHEDULER_TICK_INTERVAL_MS", "2000");
    emit(svc, "SCHEDULER_TICK_INTERVAL_MS", "1000", "2000");
    await new Promise((r) => setTimeout(r, 1)); // let the first cycle start
    setEnv(svc, "SCHEDULER_TICK_INTERVAL_MS", "3000");
    emit(svc, "SCHEDULER_TICK_INTERVAL_MS", "2000", "3000");

    await new Promise((r) => setTimeout(r, 50));

    // Final state reflects the latest event — no double-fire of either
    // restart cycle.
    expect(config.tickMs).toBe(3000);
    // Calls are interleaved without ever overlapping (each "start" follows
    // the matching "stop"). Either one or two cycles ran depending on
    // exact event timing — both are valid for "no overlap".
    expect(fake.calls.filter((c) => c === "stop").length).toBeGreaterThanOrEqual(1);
    expect(fake.calls.filter((c) => c === "start").length).toEqual(
      fake.calls.filter((c) => c === "stop").length,
    );
    // Verify strict alternation — never two stops or two starts in a row.
    for (let i = 0; i < fake.calls.length - 1; i += 2) {
      expect(fake.calls[i]).toBe("stop");
      expect(fake.calls[i + 1]).toBe("start");
    }

    unsubscribe();
  });

  it("unsubscribe detaches the listener — subsequent events are ignored", async () => {
    const { bootstrap, fake } = makeBootstrap();
    const svc = makeConfigService({ SCHEDULER_ENABLED: "true" });
    const unsubscribe = subscribeSchedulerToConfig(bootstrap, { configService: svc });
    unsubscribe();

    setEnv(svc, "SCHEDULER_ENABLED", "false");
    emit(svc, "SCHEDULER_ENABLED", "true", "false");
    await flushQueue();

    expect(fake.stop).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("logs but does not throw when scheduler.stop rejects", async () => {
    const { bootstrap, fake } = makeBootstrap({ enabled: true });
    fake.stop.mockReset();
    fake.stop.mockRejectedValueOnce(new Error("boom"));
    const svc = makeConfigService({ SCHEDULER_ENABLED: "true" });
    subscribeSchedulerToConfig(bootstrap, { configService: svc });

    setEnv(svc, "SCHEDULER_ENABLED", "false");
    expect(() => emit(svc, "SCHEDULER_ENABLED", "true", "false")).not.toThrow();
    await flushQueue();
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("no-ops when SCHEDULER_ENABLED change resolves to the same value", async () => {
    const { bootstrap, fake } = makeBootstrap({ enabled: true });
    const svc = makeConfigService({ SCHEDULER_ENABLED: "true" });
    subscribeSchedulerToConfig(bootstrap, { configService: svc });

    emit(svc, "SCHEDULER_ENABLED", "true", "true");
    await flushQueue();

    expect(fake.stop).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("no-ops when SCHEDULER_TICK_INTERVAL_MS change resolves to the same value", async () => {
    const { bootstrap, fake } = makeBootstrap({ enabled: true, tickMs: 1000 });
    const svc = makeConfigService({ SCHEDULER_TICK_INTERVAL_MS: "1000" });
    subscribeSchedulerToConfig(bootstrap, { configService: svc });

    emit(svc, "SCHEDULER_TICK_INTERVAL_MS", "1000", "1000");
    await flushQueue();

    expect(fake.stop).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
  });
});
