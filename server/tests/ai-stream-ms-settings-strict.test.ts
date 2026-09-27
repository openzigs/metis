/**
 * #257 — the `AI_STREAM_*` millisecond settings read in `routes/ai.ts` go
 * through the shared strict parser (#123), like every other `AI_*` one.
 *
 * The old `intEnv` used `Number.parseInt` with no upper bound: `1_200_000` and
 * `1.2e6` read as 1 ms, `+900000` was accepted by accident, `3000000000`
 * overflowed Node's 2^31-1 timer ceiling into a 1 ms timer, and a non-digit
 * value was dropped with no warning. Every bad form must keep the setting's
 * default and log a warning that names it; each setting keeps its minimum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));

vi.mock("../src/lib/logger.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/logger.js")>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== "config.env-ms") return real;
      return { ...real, warn: logWarn };
    },
  };
});

import { streamLimits } from "../src/routes/ai.js";
import { MAX_TIMEOUT_MS } from "../src/lib/config/env-ms.js";

type Limits = ReturnType<typeof streamLimits>;

interface Setting {
  env: string;
  field: keyof Limits;
  fallback: number;
  min: number;
}

const SETTINGS: Setting[] = [
  { env: "AI_STREAM_SOCKET_TIMEOUT_MS", field: "socketTimeoutMs", fallback: 60_000, min: 1000 },
  { env: "AI_STREAM_HEARTBEAT_MS", field: "heartbeatIntervalMs", fallback: 15_000, min: 1 },
  { env: "AI_STREAM_MAX_DURATION_MS", field: "hardCeilingMs", fallback: 300_000, min: 1 },
  { env: "AI_STREAM_IDLE_TIMEOUT_MS", field: "idleTimeoutMs", fallback: 90_000, min: 0 },
  { env: "AI_STREAM_QUEUE_MAX_WAIT_MS", field: "queueMaxWaitMs", fallback: 600_000, min: 1 },
];

/** Forms from the issue plus the dispatch's list: none is plain digits in range. */
const BAD = [
  "1_200_000",
  "1.2e6",
  "3000000000",
  String(MAX_TIMEOUT_MS + 1),
  "+900000",
  "-5",
  "abc",
  "120000ms",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const s of SETTINGS) {
    saved[s.env] = process.env[s.env];
    delete process.env[s.env];
  }
  logWarn.mockReset();
});

afterEach(() => {
  for (const s of SETTINGS) {
    if (saved[s.env] === undefined) delete process.env[s.env];
    else process.env[s.env] = saved[s.env];
  }
});

function expectWarned(name: string, raw: string): void {
  expect(logWarn).toHaveBeenCalledWith(
    expect.stringContaining("Ignoring invalid"),
    expect.objectContaining({ env: name, value: raw }),
  );
}

describe.each(SETTINGS)("$env", (s) => {
  it.each(BAD)("written %s keeps the default and warns", (raw) => {
    process.env[s.env] = raw;
    expect(streamLimits()[s.field]).toBe(s.fallback);
    expectWarned(s.env, raw);
  });

  it("below its minimum keeps the default and warns", () => {
    if (s.min === 0) {
      // AI_STREAM_IDLE_TIMEOUT_MS: 0 is the documented "disabled" value.
      process.env[s.env] = "0";
      expect(streamLimits()[s.field]).toBe(0);
      expect(logWarn).not.toHaveBeenCalled();
      return;
    }
    const raw = String(s.min - 1);
    process.env[s.env] = raw;
    expect(streamLimits()[s.field]).toBe(s.fallback);
    expectWarned(s.env, raw);
  });

  it("accepts its minimum, the cap and a whitespace-padded value", () => {
    process.env[s.env] = String(s.min);
    expect(streamLimits()[s.field]).toBe(s.min);
    process.env[s.env] = String(MAX_TIMEOUT_MS);
    expect(streamLimits()[s.field]).toBe(MAX_TIMEOUT_MS);
    process.env[s.env] = " 1200000 ";
    expect(streamLimits()[s.field]).toBe(1_200_000);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("unset or blank keeps the default silently", () => {
    expect(streamLimits()[s.field]).toBe(s.fallback);
    process.env[s.env] = "   ";
    expect(streamLimits()[s.field]).toBe(s.fallback);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
