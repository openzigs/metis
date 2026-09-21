/**
 * Epic #272 / Sub-issue #292 — Log streamer + token-bucket unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  K8sLogStreamer,
  LOG_LINE_MAX_BYTES,
  TokenBucket,
  sanitiseLogLine,
} from "../src/lib/mcp/provisioners/log-streamer.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  } as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}

describe("TokenBucket", () => {
  it("rejects non-positive rates and bursts", () => {
    expect(() => new TokenBucket({ ratePerSec: 0, burst: 1 })).toThrow();
    expect(() => new TokenBucket({ ratePerSec: 1, burst: 0 })).toThrow();
  });

  it("starts full and allows up to `burst` tokens before blocking", () => {
    const now = 1_000;
    const b = new TokenBucket({ ratePerSec: 1, burst: 3, now: () => now });
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
  });

  it("refills tokens at the configured rate", () => {
    let now = 0;
    const b = new TokenBucket({ ratePerSec: 10, burst: 5, now: () => now });
    while (b.tryConsume()) {
      /* drain */
    }
    // 0.5s elapsed → +5 tokens.
    now = 500;
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
  });

  it("caps refill at burst capacity", () => {
    let now = 0;
    const b = new TokenBucket({ ratePerSec: 1, burst: 2, now: () => now });
    // 1 hour elapsed but only 2 tokens max.
    now = 3_600_000;
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
  });
});

describe("K8sLogStreamer", () => {
  it("forwards lines to the logger when tokens are available", () => {
    const logger = makeLogger();
    const bucket = new TokenBucket({ ratePerSec: 100, burst: 100 });
    const s = new K8sLogStreamer({ serverId: "abc", bucket, logger });
    expect(s.ingest("hello")).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      "mcp pod log",
      expect.objectContaining({ serverId: "abc", line: "hello" }),
    );
  });

  it("drops when the bucket is empty and emits a single throttle warning per interval", () => {
    let now = 0;
    const logger = makeLogger();
    const bucket = new TokenBucket({ ratePerSec: 1, burst: 1, now: () => now });
    const s = new K8sLogStreamer({
      serverId: "abc",
      bucket,
      logger,
      warnIntervalMs: 60_000,
      now: () => now,
    });
    expect(s.ingest("ok")).toBe(true);
    expect(s.ingest("drop1")).toBe(false);
    expect(s.ingest("drop2")).toBe(false);
    expect(s.ingest("drop3")).toBe(false);
    // First drop should have produced one warn.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenLastCalledWith(
      "mcp pod log throttled",
      expect.objectContaining({ droppedSinceLastWarn: expect.any(Number) }),
    );
    // Within the 60s window, no additional warnings.
    now = 30_000;
    s.ingest("drop4");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Past the window, ensure another drop is forced (drain the freshly
    // refilled token first, then the next call drops and emits warn #2).
    now = 70_000;
    s.ingest("ok-after-refill"); // consumes the 1 refilled token
    s.ingest("drop5"); // bucket empty again → drop → fires warn #2
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("stops processing after stop()", () => {
    const logger = makeLogger();
    const bucket = new TokenBucket({ ratePerSec: 100, burst: 100 });
    const s = new K8sLogStreamer({ serverId: "abc", bucket, logger });
    s.stop();
    expect(s.ingest("after-stop")).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("attach() splits NDJSON chunks on newlines", async () => {
    const logger = makeLogger();
    const bucket = new TokenBucket({ ratePerSec: 1000, burst: 1000 });
    const s = new K8sLogStreamer({ serverId: "abc", bucket, logger });
    async function* gen() {
      yield "line1\nlin";
      yield "e2\nline3";
    }
    s.attach(gen());
    // Drain the microtask queue so the async iterator finishes.
    await new Promise((r) => setImmediate(r));
    expect(logger.info).toHaveBeenCalledTimes(3);
    s.stop();
  });
});

describe("sanitiseLogLine", () => {
  it("strips ANSI colour escape sequences", () => {
    expect(sanitiseLogLine("\x1b[31mred\x1b[0m text")).toBe("[31mred[0m text");
  });

  it("strips control chars but keeps tab and newline", () => {
    expect(sanitiseLogLine("a\tb\nc\x07d\x00e")).toBe("a\tb\ncde");
  });

  it("removes DEL (0x7F)", () => {
    expect(sanitiseLogLine("hello\x7fworld")).toBe("helloworld");
  });

  it("truncates lines longer than LOG_LINE_MAX_BYTES with a marker suffix", () => {
    const big = "x".repeat(LOG_LINE_MAX_BYTES + 100);
    const out = sanitiseLogLine(big);
    expect(out.length).toBe(LOG_LINE_MAX_BYTES);
    expect(out.endsWith("… (truncated)")).toBe(true);
  });

  it("leaves short clean lines untouched", () => {
    expect(sanitiseLogLine("plain log line")).toBe("plain log line");
  });
});

describe("K8sLogStreamer sanitisation integration", () => {
  it("forwards sanitised lines to the logger", () => {
    const logger = makeLogger();
    const bucket = new TokenBucket({ ratePerSec: 100, burst: 100 });
    const s = new K8sLogStreamer({ serverId: "abc", bucket, logger });
    s.ingest("\x1b[31mhello\x1b[0m");
    expect(logger.info).toHaveBeenCalledWith(
      "mcp pod log",
      expect.objectContaining({ line: "[31mhello[0m" }),
    );
  });

  it("truncates oversized lines before forwarding", () => {
    const logger = makeLogger();
    const bucket = new TokenBucket({ ratePerSec: 100, burst: 100 });
    const s = new K8sLogStreamer({ serverId: "abc", bucket, logger });
    s.ingest("y".repeat(LOG_LINE_MAX_BYTES + 50));
    const arg = logger.info.mock.calls[0]?.[1] as { line: string };
    expect(arg.line.length).toBe(LOG_LINE_MAX_BYTES);
    expect(arg.line.endsWith("… (truncated)")).toBe(true);
  });
});
