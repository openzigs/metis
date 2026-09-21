/**
 * Epic #272 / Sub-issue #292 — Token-bucket log streamer for k8s-sse pods.
 *
 * Pipes pod stdout/stderr lines into the METIS structured logger with a
 * token-bucket rate limiter in front. Drops excess lines and emits a single
 * throttle warning per minute with the cumulative drop count.
 *
 * EKS / Container Insights / Fluent Bit handle the actual CloudWatch ship
 * out-of-band — this module only mirrors logs into METIS so admins can tail
 * MCP output from the server log stream without kubectl.
 */
import type { Logger } from "winston";

export interface TokenBucketOptions {
  /** Steady-state refill rate (lines per second). */
  ratePerSec: number;
  /** Burst capacity (max tokens in the bucket). */
  burst: number;
  /** Test seam — clock in milliseconds. */
  now?: () => number;
}

/**
 * Minimal token-bucket — refills `ratePerSec` tokens per second up to
 * `burst`. `tryConsume()` returns true if a token was available, else false.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(opts: TokenBucketOptions) {
    if (opts.ratePerSec <= 0) throw new Error("ratePerSec must be > 0");
    if (opts.burst <= 0) throw new Error("burst must be > 0");
    this.rate = opts.ratePerSec;
    this.capacity = opts.burst;
    this.tokens = opts.burst;
    this.now = opts.now ?? (() => Date.now());
    this.last = this.now();
  }

  tryConsume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = this.now();
    const elapsedSec = (now - this.last) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.rate);
    this.last = now;
  }
}

export interface LogStreamerOptions {
  serverId: string;
  bucket: TokenBucket;
  /** Sink for forwarded log lines (typically the per-MCP child logger). */
  logger: Pick<Logger, "info" | "warn">;
  /** How often (ms) to flush throttle warnings. Default 60_000. */
  warnIntervalMs?: number;
  /** Test seam — clock. */
  now?: () => number;
}

/** Hard cap per forwarded line (bytes). Lines beyond this are truncated. */
export const LOG_LINE_MAX_BYTES = 8 * 1024;
const TRUNCATED_SUFFIX = "… (truncated)";

/**
 * Strip ASCII control characters (0x00–0x1F except `\t` and `\n`) and DEL
 * (0x7F) from a log line. ANSI escape sequences (`ESC[…m`) start with 0x1B
 * and are removed by the same filter — handy because pod stdout often
 * contains colourised output that pollutes structured log sinks.
 *
 * Lines longer than `LOG_LINE_MAX_BYTES` are truncated (after sanitisation)
 * with a marker suffix so operators can tell when output was elided rather
 * than silently truncated.
 */
export function sanitiseLogLine(raw: string): string {
  const stripped = raw.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  if (stripped.length <= LOG_LINE_MAX_BYTES) return stripped;
  const room = LOG_LINE_MAX_BYTES - TRUNCATED_SUFFIX.length;
  return `${stripped.slice(0, Math.max(0, room))}${TRUNCATED_SUFFIX}`;
}

/**
 * Stateful log line forwarder. Wraps a TokenBucket and accumulates dropped
 * counts so we emit at most one throttle warning per `warnIntervalMs`.
 */
export class K8sLogStreamer {
  private dropped = 0;
  private lastWarnAt: number;
  private readonly warnIntervalMs: number;
  private readonly now: () => number;
  private stopped = false;
  private cancel: (() => void) | null = null;

  constructor(private readonly opts: LogStreamerOptions) {
    this.warnIntervalMs = opts.warnIntervalMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    // Initialise so the FIRST throttle fires immediately rather than waiting
    // a full interval — operators want to know about back-pressure ASAP.
    this.lastWarnAt = -this.warnIntervalMs;
  }

  /** Process a single log line. Returns true when forwarded, false when dropped. */
  ingest(line: string): boolean {
    if (this.stopped) return false;
    if (this.opts.bucket.tryConsume(1)) {
      this.opts.logger.info("mcp pod log", {
        source: "mcp",
        serverId: this.opts.serverId,
        line: sanitiseLogLine(line),
      });
      return true;
    }
    this.dropped += 1;
    const now = this.now();
    if (now - this.lastWarnAt >= this.warnIntervalMs) {
      this.opts.logger.warn("mcp pod log throttled", {
        source: "mcp",
        serverId: this.opts.serverId,
        droppedSinceLastWarn: this.dropped,
        ratePerSec: this.bucketRateInfo().rate,
      });
      this.dropped = 0;
      this.lastWarnAt = now;
    }
    return false;
  }

  /** Wire a stream of NDJSON-or-newline-delimited bytes through the bucket. */
  attach(
    read: AsyncIterable<Uint8Array | string>,
    decoder?: { decode: (chunk: Uint8Array, opts?: { stream: boolean }) => string },
  ): void {
    const dec = decoder ?? new globalThis.TextDecoder();
    if (this.stopped) return;
    let aborted = false;
    this.cancel = () => {
      aborted = true;
    };
    void (async () => {
      let buf = "";
      for await (const chunk of read) {
        if (aborted) break;
        buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
        let nlIdx;
        while ((nlIdx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nlIdx);
          buf = buf.slice(nlIdx + 1);
          if (line.length > 0) this.ingest(line);
        }
      }
      if (buf.length > 0 && !aborted) this.ingest(buf);
    })();
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  // Test helper — exposes the bucket's configured rate without leaking the
  // private field. (We don't want public access to the TokenBucket itself.)
  private bucketRateInfo(): { rate: number } {
    return { rate: (this.opts.bucket as unknown as { rate: number }).rate };
  }
}
