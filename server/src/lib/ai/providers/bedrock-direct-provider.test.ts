/**
 * Tests for the OpenAI-compatible provider's undici dispatcher wiring (local
 * doc-gen timeout fix) and its existing app-level AbortController timers.
 *
 * Root cause this guards against: Node's global `fetch` (undici) applies its OWN
 * default `headersTimeout`/`bodyTimeout` of 300s, which fired BEFORE this
 * provider's longer `firstByteTimeoutMs` (default 600s) — so a local model that
 * needed >300s for cold-load + large-prompt eval before the first token aborted
 * with an opaque `TypeError: fetch failed`. The fix passes a PER-REQUEST undici
 * `Agent` dispatcher (never global) so the app-level timers stay the governors.
 *
 * `globalThis.fetch` is stubbed so NO network call is made; the stub captures the
 * `RequestInit` (including the non-standard `dispatcher`) so we can assert it.
 */
import { Agent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChunk } from "../types.js";

// Capture structured log lines so we can assert one warn per retry attempt and
// that NO secret (api key / Authorization header) is ever logged. `vi.hoisted`
// makes `logWarn`/`logInfo` available inside the hoisted `vi.mock` factory below.
// `logInfo` is shared by the cache-hit-telemetry module (#390), which logs the
// per-call hit ratio via the SAME `../logger.js` factory.
const { logWarn, logInfo } = vi.hoisted(() => ({ logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: logInfo,
    warn: logWarn,
    error: vi.fn(),
  }),
}));
// The telemetry module resolves the logger via `../logger.js` (one level up from
// providers/) — mock that path too so its `info` lands on the same spy.
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: logInfo,
    warn: logWarn,
    error: vi.fn(),
  }),
}));

const {
  OpenAICompatibleProvider,
  computeBackoffDelay,
  isRetryableNetworkError,
  isRetryableStatus,
  parseRetryAfterMs,
  resolveUndiciTimeouts,
  extractSseErrorMessage,
  embeddedStatusFromStreamError,
} = await import("./bedrock-direct-provider.js");
const { getCacheHitAggregator, __resetCacheHitAggregatorSingleton } =
  await import("../cache-hit-telemetry.js");

type CapturedInit = RequestInit & { dispatcher?: unknown };

const originalFetch = globalThis.fetch;

/** Build a provider with overridable timeout opts (defaults match production). */
function makeProvider(
  over: Partial<{
    firstByteTimeoutMs: number;
    idleTimeoutMs: number;
    requestTimeoutMs: number;
  }> = {},
) {
  return new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "test-model",
    providerKey: "local-gemma",
    ...over,
  });
}

/** A minimal non-streaming OpenAI chat-completions JSON response. */
function jsonResponse(content = "hello") {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      model: "test-model",
    }),
    text: async () => "",
  } as unknown as Response;
}

/**
 * A non-streaming response whose `usage` carries `prompt_tokens_details.cached_tokens`
 * — the gateway's cache-READ count — so we can assert the #390 hit-ratio
 * telemetry emission. `model` echoes the response model id used as the tag.
 */
function jsonResponseWithCache(
  cachedTokens: number,
  promptTokens: number,
  model = "test-model",
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: "hi" } }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 5,
        total_tokens: promptTokens + 5,
        prompt_tokens_details: { cached_tokens: cachedTokens },
      },
      model,
    }),
    text: async () => "",
  } as unknown as Response;
}

/** A streaming SSE response whose final `usage` frame carries cache-read tokens. */
function sseResponseWithCache(cachedTokens: number, promptTokens: number): Response {
  const usageFrame = JSON.stringify({
    choices: [{ delta: {} }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 3,
      total_tokens: promptTokens + 3,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  });
  const frames = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    `data: ${usageFrame}\n\n`,
    "data: [DONE]\n\n",
  ];
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: async () =>
            i < frames.length
              ? { value: enc.encode(frames[i++]), done: false }
              : { value: undefined, done: true },
          cancel: async () => undefined,
        };
      },
    },
    text: async () => "",
  } as unknown as Response;
}

/** A streaming SSE response whose body yields one delta then [DONE]. */
function sseResponse(): Response {
  const frames = ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', "data: [DONE]\n\n"];
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () =>
            i < frames.length
              ? { value: enc.encode(frames[i++]), done: false }
              : { value: undefined, done: true },
          cancel: async () => undefined,
        };
      },
    },
    text: async () => "",
  } as unknown as Response;
}

/**
 * An error/non-OK HTTP response (e.g. 429/503). `retryAfter` populates the
 * `Retry-After` header so we can assert the header-floor behavior.
 */
function errorResponse(status: number, retryAfter?: string): Response {
  const headers = new Map<string, string>();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return {
    ok: false,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    json: async () => ({}),
    text: async () => `simulated ${status}`,
  } as unknown as Response;
}

/** A streaming SSE response that emits ONE delta then throws mid-stream on the
 * NEXT read — to prove a post-first-byte failure is NOT retried. */
function sseThenErrorResponse(): Response {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: async () => {
            if (i === 0) {
              i++;
              return {
                value: enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
                done: false,
              };
            }
            const e = new Error("ECONNRESET mid-stream");
            (e as { code?: string }).code = "ECONNRESET";
            throw e;
          },
          cancel: async () => undefined,
        };
      },
    },
    text: async () => "",
  } as unknown as Response;
}

/** A connection-reset error a fetch() might throw before any byte. */
function connResetError(): Error {
  const e = new Error("socket hang up");
  (e as { code?: string }).code = "ECONNRESET";
  return e;
}

/** Provider tuned for fast retry tests: instant (no-op) sleep + deterministic
 * jitter so backoff math is predictable, with a tiny base delay. */
function makeRetryProvider(
  over: Partial<{
    maxAttempts: number;
    retryBaseDelayMs: number;
    randomFn: () => number;
  }> = {},
  sleeps?: number[],
) {
  return new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "test-model",
    providerKey: "bedrock-gateway",
    maxAttempts: over.maxAttempts ?? 4,
    retryBaseDelayMs: over.retryBaseDelayMs ?? 10,
    // Deterministic full-jitter draw (max of the window) unless overridden.
    randomFn: over.randomFn ?? (() => 0.999999),
    // No real waiting — record the requested delays instead.
    sleepFn: async (ms: number) => {
      if (sleeps) sleeps.push(ms);
    },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  logWarn.mockClear();
  logInfo.mockClear();
  __resetCacheHitAggregatorSingleton();
  vi.restoreAllMocks();
});

describe("resolveUndiciTimeouts", () => {
  it("sizes headersTimeout to the larger first-byte guard plus a margin; bodyTimeout disabled", () => {
    // firstByteTimeoutMs (600s) is the larger guard; +30s margin.
    expect(resolveUndiciTimeouts(600_000, 300_000)).toEqual({
      headersTimeout: 600_000 + 30_000,
      bodyTimeout: 0,
    });
  });

  it("uses requestTimeoutMs when it is the larger guard", () => {
    expect(resolveUndiciTimeouts(120_000, 300_000)).toEqual({
      headersTimeout: 300_000 + 30_000,
      bodyTimeout: 0,
    });
  });

  it("disables headersTimeout (0) when firstByteTimeoutMs is disabled — never re-imposes 300s", () => {
    expect(resolveUndiciTimeouts(0, 300_000).headersTimeout).toBe(0);
  });

  it("disables headersTimeout (0) when requestTimeoutMs is disabled", () => {
    expect(resolveUndiciTimeouts(600_000, 0).headersTimeout).toBe(0);
  });

  it("always disables bodyTimeout so a slow-but-alive stream is only governed by idleTimeoutMs", () => {
    expect(resolveUndiciTimeouts(0, 0).bodyTimeout).toBe(0);
    expect(resolveUndiciTimeouts(1, 1).bodyTimeout).toBe(0);
  });
});

describe("chat() undici dispatcher", () => {
  it("passes a per-request undici Agent dispatcher with the resolved transport timeouts", async () => {
    let captured: CapturedInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      captured = init;
      return jsonResponse();
    }) as unknown as typeof fetch;

    const provider = makeProvider({ firstByteTimeoutMs: 600_000, requestTimeoutMs: 300_000 });
    await provider.chat([{ role: "user", content: "hi" }]);

    expect(captured?.dispatcher).toBeInstanceOf(Agent);
    // The dispatcher is sized from the app-level budgets via the pure resolver:
    // headersTimeout = max(firstByteTimeoutMs, requestTimeoutMs) + 30s margin, so
    // undici cannot preempt the app-level timers. (undici keeps these on an
    // internal symbol; the numeric sizing is asserted directly in the
    // resolveUndiciTimeouts suite above.)
    expect(resolveUndiciTimeouts(600_000, 300_000).headersTimeout).toBe(630_000);
  });

  it("reuses the SAME dispatcher instance across calls (built once per provider)", async () => {
    const seen: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      seen.push(init?.dispatcher);
      return jsonResponse();
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await provider.chat([{ role: "user", content: "a" }]);
    await provider.chat([{ role: "user", content: "b" }]);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBeInstanceOf(Agent);
  });
});

describe("stream() undici dispatcher", () => {
  it("passes a per-request undici Agent dispatcher", async () => {
    let captured: CapturedInit | undefined;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      captured = init;
      return sseResponse();
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }])) {
      chunks.push(c);
    }

    expect(captured?.dispatcher).toBeInstanceOf(Agent);
    // Sanity: the stream still produced a delta + done despite the dispatcher.
    expect(chunks.some((c) => c.type === "delta")).toBe(true);
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });

  it("uses the SAME dispatcher instance as chat() (one Agent per provider)", async () => {
    const seen: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
      seen.push(init?.dispatcher);
      return init?.headers && (init.headers as Record<string, string>).Accept
        ? sseResponse()
        : jsonResponse();
    }) as unknown as typeof fetch;

    const provider = makeProvider();
    await provider.chat([{ role: "user", content: "a" }]);
    for await (const _c of provider.stream([{ role: "user", content: "b" }])) {
      /* drain */
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("app-level AbortController timers still govern (dispatcher does not disable them)", () => {
  it("chat() aborts via requestTimeoutMs when fetch never resolves before the timer", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that rejects only when its abort signal fires — i.e. undici is
      // NOT preempting; the app-level timer must be what aborts.
      globalThis.fetch = vi.fn((_url: unknown, init?: CapturedInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }) as unknown as typeof fetch;

      const provider = makeProvider({ requestTimeoutMs: 1_000 });
      const p = provider.chat([{ role: "user", content: "hi" }]);
      const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stream() aborts via firstByteTimeoutMs when no first byte arrives before the timer", async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn((_url: unknown, init?: CapturedInit) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      }) as unknown as typeof fetch;

      const provider = makeProvider({ firstByteTimeoutMs: 500 });
      const iter = provider.stream([{ role: "user", content: "hi" }]);
      const consume = (async () => {
        for await (const _c of iter) {
          /* drain */
        }
      })();
      const assertion = expect(consume).rejects.toThrow(/stalled/);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// #388 — bounded retry/backoff for Bedrock throttling (429/503) + conn-reset.
// ---------------------------------------------------------------------------

describe("isRetryableStatus", () => {
  it("treats 429 and 503 as retryable", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
  });

  it("treats other 4xx/5xx (400/401/403/404/500/502) as NON-retryable", () => {
    for (const s of [400, 401, 403, 404, 500, 502]) {
      expect(isRetryableStatus(s)).toBe(false);
    }
  });
});

describe("isRetryableNetworkError", () => {
  it("retries connection-reset-class errors (ECONNRESET and friends)", () => {
    const e = new Error("socket hang up");
    (e as { code?: string }).code = "ECONNRESET";
    expect(isRetryableNetworkError(e)).toBe(true);
    expect(isRetryableNetworkError(new Error("read ECONNRESET"))).toBe(true);
    expect(isRetryableNetworkError(new Error("other side closed"))).toBe(true);
  });

  it("retries when the OS code is nested under .cause (undici style)", () => {
    const e = new Error("fetch failed") as Error & { cause?: { code?: string } };
    e.cause = { code: "ECONNREFUSED" };
    expect(isRetryableNetworkError(e)).toBe(true);
  });

  it("does NOT retry an AbortError (our own timeout/cancel) or a plain error", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableNetworkError(abort)).toBe(false);
    expect(isRetryableNetworkError(new Error("validation failed"))).toBe(false);
    expect(isRetryableNetworkError("not an error")).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds into ms", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(" 0 ")).toBe(0);
  });

  it("returns undefined for missing/blank/garbage values", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });

  it("clamps an oversized header so we never sleep unbounded", () => {
    // 9999s would be 9_999_000ms; clamp to the 20s ceiling.
    expect(parseRetryAfterMs("9999")).toBe(20_000);
  });

  it("parses an HTTP-date in the future to a positive delta", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(20_000);
  });

  it("returns 0 for an HTTP-date already in the past (do not wait)", () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });
});

describe("computeBackoffDelay (full jitter)", () => {
  it("draws uniformly from [0, base*2^(n-1)] — random=0 yields 0", () => {
    expect(computeBackoffDelay(1, 500, undefined, () => 0)).toBe(0);
    expect(computeBackoffDelay(2, 500, undefined, () => 0)).toBe(0);
  });

  it("random≈1 yields ~the full exponential window for that attempt", () => {
    // attempt 1 window = 500; attempt 2 window = 1000; attempt 3 window = 2000.
    expect(computeBackoffDelay(1, 500, undefined, () => 0.999999)).toBe(499);
    expect(computeBackoffDelay(2, 500, undefined, () => 0.999999)).toBe(999);
    expect(computeBackoffDelay(3, 500, undefined, () => 0.999999)).toBe(1999);
  });

  it("honors Retry-After as the delay FLOOR even when jitter draws 0", () => {
    // random=0 → jittered 0; Retry-After floor 1500 wins.
    expect(computeBackoffDelay(1, 500, 1500, () => 0)).toBe(1500);
  });

  it("caps the exponential window at 20s so it never runs away", () => {
    // attempt 10 window would be 500*2^9 = 256000; capped to 20000.
    expect(computeBackoffDelay(10, 500, undefined, () => 0.999999)).toBe(19999);
  });
});

describe("chat() retry/backoff", () => {
  it("retries a simulated 429 with backoff, eventually succeeds, one log line per retry", async () => {
    const sleeps: number[] = [];
    // 429, 429, then a 200 success → 2 retries, 2 log lines, 2 sleeps.
    const responses = [errorResponse(429), errorResponse(429), jsonResponse("ok")];
    let call = 0;
    globalThis.fetch = vi.fn(async () => responses[call++]) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 4, retryBaseDelayMs: 10 }, sleeps);
    const res = await provider.chat([{ role: "user", content: "hi" }]);

    expect(res.content).toBe("ok");
    expect(call).toBe(3); // initial + 2 retries
    expect(sleeps).toHaveLength(2); // one delay per retry
    // Each sleep is a positive bounded backoff (deterministic random=0.999999).
    expect(sleeps.every((d) => d >= 0 && d <= 20_000)).toBe(true);

    // Exactly ONE structured warn line per retry attempt, carrying the retry
    // metadata (attempt/delay/status) and NEVER a secret.
    expect(logWarn).toHaveBeenCalledTimes(2);
    const [msg, meta] = logWarn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/retry/i);
    expect(meta.attempt).toBe(1);
    expect(meta.status).toBe(429);
    expect(typeof meta.delayMs).toBe("number");
    // OWASP: the api key and Authorization header must never be logged.
    const serialized = JSON.stringify(logWarn.mock.calls);
    expect(serialized).not.toContain("ollama"); // the apiKey value
    expect(serialized.toLowerCase()).not.toContain("authorization");
    expect(serialized.toLowerCase()).not.toContain("bearer");
  });

  it("surfaces a clear error (no silent hang) once retries are exhausted", async () => {
    const sleeps: number[] = [];
    // Always 503 → exhaust all attempts.
    globalThis.fetch = vi.fn(async () => errorResponse(503)) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 3, retryBaseDelayMs: 10 }, sleeps);
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/503/);
    // 3 total tries → 2 retries → 2 sleeps; the loop is BOUNDED (no infinite retry).
    expect(sleeps).toHaveLength(2);
  });

  it("does NOT retry a non-retryable status (e.g. 401) — fails fast", async () => {
    const sleeps: number[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return errorResponse(401);
    }) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 4 }, sleeps);
    await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/401/);
    expect(call).toBe(1); // no retries
    expect(sleeps).toHaveLength(0);
  });

  it("retries a connection-reset network error then succeeds", async () => {
    const sleeps: number[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 1) throw connResetError();
      return jsonResponse("recovered");
    }) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 3, retryBaseDelayMs: 5 }, sleeps);
    const res = await provider.chat([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("recovered");
    expect(call).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it("honors Retry-After: the sleep for that attempt is >= the header value", async () => {
    const sleeps: number[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      // First response: 429 with Retry-After: 3s; then success.
      return call === 1 ? errorResponse(429, "3") : jsonResponse("ok");
    }) as unknown as typeof fetch;

    // random=0 → pure jitter would be 0, so the only thing that can produce a
    // 3000ms sleep is the Retry-After FLOOR being honored.
    const provider = makeRetryProvider(
      { maxAttempts: 3, retryBaseDelayMs: 10, randomFn: () => 0 },
      sleeps,
    );
    const res = await provider.chat([{ role: "user", content: "hi" }]);
    expect(res.content).toBe("ok");
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(3000);
  });
});

describe("stream() retry boundary (the #388 hard rule)", () => {
  it("retries a 429 BEFORE the first byte, then streams successfully", async () => {
    const sleeps: number[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return call === 1 ? errorResponse(429) : sseResponse();
    }) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 3, retryBaseDelayMs: 5 }, sleeps);
    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }])) {
      chunks.push(c);
    }

    expect(call).toBe(2); // connection retried once
    expect(sleeps).toHaveLength(1);
    expect(chunks.some((c) => c.type === "delta")).toBe(true);
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });

  it("retries a connection-reset BEFORE the first byte, then streams", async () => {
    const sleeps: number[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      if (call === 1) throw connResetError();
      return sseResponse();
    }) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 3, retryBaseDelayMs: 5 }, sleeps);
    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }])) {
      chunks.push(c);
    }
    expect(call).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "delta")).toHaveLength(1);
  });

  it("does NOT retry a failure AFTER tokens are emitted — the error surfaces", async () => {
    const sleeps: number[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return sseThenErrorResponse();
    }) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 4, retryBaseDelayMs: 5 }, sleeps);
    const seen: ChatChunk[] = [];
    const consume = (async () => {
      for await (const c of provider.stream([{ role: "user", content: "hi" }])) {
        seen.push(c);
      }
    })();

    // The mid-stream ECONNRESET surfaces (NOT retried) even though it is a
    // "retryable-class" error — because the first byte was already emitted.
    await expect(consume).rejects.toThrow(/ECONNRESET/);
    // Exactly ONE fetch (no reconnect) and the first delta WAS delivered.
    expect(call).toBe(1);
    expect(sleeps).toHaveLength(0);
    expect(seen.filter((c) => c.type === "delta")).toHaveLength(1);
  });

  it("reframes a mid-stream idle-timeout abort as a clear stall (not retried)", async () => {
    vi.useFakeTimers();
    try {
      const enc = new TextEncoder();
      let reads = 0;
      // First read returns a delta (marks firstChunkSeen, arms the tighter idle
      // timer); the second read hangs until the abort signal fires, then throws.
      globalThis.fetch = vi.fn(async (_url: unknown, init?: CapturedInit) => {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: {
            getReader() {
              return {
                read: async () => {
                  if (reads++ === 0) {
                    return {
                      value: enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
                      done: false,
                    };
                  }
                  return new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () => {
                      const e = new Error("aborted");
                      e.name = "AbortError";
                      reject(e);
                    });
                  });
                },
                cancel: async () => undefined,
              };
            },
          },
          text: async () => "",
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const provider = new OpenAICompatibleProvider({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        model: "test-model",
        providerKey: "bedrock-gateway",
        idleTimeoutMs: 100,
        firstByteTimeoutMs: 100,
        sleepFn: async () => undefined,
      });
      const seen: ChatChunk[] = [];
      const consume = (async () => {
        for await (const c of provider.stream([{ role: "user", content: "hi" }])) {
          seen.push(c);
        }
      })();
      const assertion = expect(consume).rejects.toThrow(/stalled/);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
      // The first delta was delivered; the mid-stream stall was NOT reconnected.
      expect(seen.filter((c) => c.type === "delta")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a clear error when stream connection retries are exhausted", async () => {
    const sleeps: number[] = [];
    globalThis.fetch = vi.fn(async () => errorResponse(503)) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 3, retryBaseDelayMs: 5 }, sleeps);
    const consume = (async () => {
      for await (const _c of provider.stream([{ role: "user", content: "hi" }])) {
        /* drain */
      }
    })();
    await expect(consume).rejects.toThrow(/503/);
    expect(sleeps).toHaveLength(2); // bounded: 3 tries → 2 retries
  });

  it("does NOT retry a non-retryable stream status (e.g. 403) — fails fast", async () => {
    const sleeps: number[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return errorResponse(403);
    }) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 4 }, sleeps);
    const consume = (async () => {
      for await (const _c of provider.stream([{ role: "user", content: "hi" }])) {
        /* drain */
      }
    })();
    await expect(consume).rejects.toThrow(/403/);
    expect(call).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("throws a clear error for an OK response with no stream body", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: null,
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = makeRetryProvider({ maxAttempts: 2 });
    const consume = (async () => {
      for await (const _c of provider.stream([{ role: "user", content: "hi" }])) {
        /* drain */
      }
    })();
    await expect(consume).rejects.toThrow(/empty stream body/);
  });
});

describe("retry default sleep (real timer path)", () => {
  it("uses a real setTimeout-based delay between retries when sleepFn is not injected", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call++;
        return call === 1 ? errorResponse(429) : jsonResponse("ok");
      }) as unknown as typeof fetch;

      // No sleepFn override → the provider builds a setTimeout-based delay; with
      // random=0 and a 1ms base, the floor sleep is tiny — drive it with fake
      // timers so we never wait real time.
      const provider = new OpenAICompatibleProvider({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        model: "test-model",
        providerKey: "bedrock-gateway",
        maxAttempts: 3,
        retryBaseDelayMs: 1,
        randomFn: () => 0.999999,
      });
      const p = provider.chat([{ role: "user", content: "hi" }]);
      // Flush the backoff sleep + the resolved retry.
      await vi.advanceTimersByTimeAsync(50);
      const res = await p;
      expect(res.content).toBe("ok");
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retry env knobs (AI_MAX_RETRIES / AI_RETRY_BASE_DELAY_MS)", () => {
  it("AI_MAX_RETRIES bounds the attempt cap (clamped to [1,6])", async () => {
    const prev = process.env.AI_MAX_RETRIES;
    process.env.AI_MAX_RETRIES = "2";
    try {
      const sleeps: number[] = [];
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call++;
        return errorResponse(429);
      }) as unknown as typeof fetch;

      // No explicit maxAttempts → falls back to AI_MAX_RETRIES=2.
      const provider = new OpenAICompatibleProvider({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        model: "test-model",
        providerKey: "bedrock-gateway",
        retryBaseDelayMs: 5,
        sleepFn: async (ms: number) => {
          sleeps.push(ms);
        },
        randomFn: () => 0,
      });
      await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/429/);
      expect(call).toBe(2); // 2 total tries
      expect(sleeps).toHaveLength(1); // 1 retry
    } finally {
      if (prev === undefined) delete process.env.AI_MAX_RETRIES;
      else process.env.AI_MAX_RETRIES = prev;
    }
  });

  it("AI_MAX_RETRIES=1 disables retrying (single attempt)", async () => {
    const prev = process.env.AI_MAX_RETRIES;
    process.env.AI_MAX_RETRIES = "1";
    try {
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call++;
        return errorResponse(503);
      }) as unknown as typeof fetch;
      const provider = new OpenAICompatibleProvider({
        baseUrl: "http://127.0.0.1:11434/v1",
        apiKey: "ollama",
        model: "test-model",
        providerKey: "bedrock-gateway",
        sleepFn: async () => undefined,
      });
      await expect(provider.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/503/);
      expect(call).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.AI_MAX_RETRIES;
      else process.env.AI_MAX_RETRIES = prev;
    }
  });
});

describe("prompt-cache hit-ratio telemetry (#390)", () => {
  it("chat() emits a hit-ratio log tagged by call type AND model and accumulates", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponseWithCache(768, 1024));
    const provider = makeProvider();

    await provider.chat([{ role: "user", content: "hi" }], { callType: "grounding" });

    // Find the per-call telemetry info line (the module logs "prompt cache hit").
    const hit = logInfo.mock.calls.find(
      (c) => typeof c[0] === "string" && /prompt cache hit/i.test(c[0] as string),
    ) as [string, Record<string, unknown>] | undefined;
    expect(hit).toBeDefined();
    expect(hit?.[1]).toMatchObject({
      callType: "grounding",
      model: "test-model",
      cacheReadTokens: 768,
      promptTokens: 1024,
    });
    expect(hit?.[1].hitRatio).toBeCloseTo(0.75, 6);

    // Aggregator accumulated the call into the (grounding, test-model) bucket.
    const stats = getCacheHitAggregator().snapshot("grounding", "test-model");
    expect(stats).toMatchObject({ calls: 1, sumCacheReadTokens: 768, sumPromptTokens: 1024 });
  });

  it("chat() defaults the call type to 'unknown' when no tag is supplied", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponseWithCache(100, 200));
    await makeProvider().chat([{ role: "user", content: "hi" }]);

    expect(getCacheHitAggregator().snapshot("unknown", "test-model")?.calls).toBe(1);
  });

  it("accumulates across multiple chat() calls in the same bucket", async () => {
    const provider = makeProvider();
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponseWithCache(100, 200));
    await provider.chat([{ role: "user", content: "a" }], { callType: "chat" });
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponseWithCache(300, 300));
    await provider.chat([{ role: "user", content: "b" }], { callType: "chat" });

    const stats = getCacheHitAggregator().snapshot("chat", "test-model");
    // rolling ratio = (100+300) / (200+300) = 400/500 = 0.8
    expect(stats).toMatchObject({ calls: 2, sumCacheReadTokens: 400, sumPromptTokens: 500 });
    expect(stats?.hitRatio).toBeCloseTo(0.8, 6);
  });

  it("guards divide-by-zero: promptTokens=0 yields ratio 0 with no throw", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponseWithCache(0, 0));
    await expect(
      makeProvider().chat([{ role: "user", content: "hi" }], { callType: "chat" }),
    ).resolves.toBeDefined();

    const hit = logInfo.mock.calls.find(
      (c) => typeof c[0] === "string" && /prompt cache hit/i.test(c[0] as string),
    ) as [string, Record<string, unknown>] | undefined;
    expect(hit?.[1].hitRatio).toBe(0);
  });

  it("stream() emits the hit-ratio telemetry from the final usage frame", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponseWithCache(256, 512));
    const provider = makeProvider();

    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }], {
      callType: "synthesis",
    })) {
      chunks.push(c);
    }

    const stats = getCacheHitAggregator().snapshot("synthesis", "test-model");
    expect(stats).toMatchObject({ calls: 1, sumCacheReadTokens: 256, sumPromptTokens: 512 });
    expect(stats?.hitRatio).toBeCloseTo(0.5, 6);
    // emitted exactly once for the stream (not per chunk).
    const hits = logInfo.mock.calls.filter(
      (c) => typeof c[0] === "string" && /prompt cache hit/i.test(c[0] as string),
    );
    expect(hits).toHaveLength(1);
  });

  it("never logs a secret (api key / Authorization header / ARN) in the emission", async () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/secret";
    // Model id echoed back as an ARN must be redacted by the emitter.
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponseWithCache(50, 100, arn));
    await makeProvider().chat([{ role: "user", content: "hi" }], { callType: "chat" });

    const serialized = JSON.stringify(logInfo.mock.calls);
    expect(serialized).not.toContain(arn);
    expect(serialized).not.toMatch(/123456789012/);
    expect(serialized).not.toMatch(/Bearer /i);
    expect(serialized).not.toMatch(/ollama/); // api key value must never appear
  });
});

/** An SSE response that streams the given delta contents then [DONE]. */
function sseFromDeltas(deltas: string[]): Response {
  const frames = [
    ...deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`),
    "data: [DONE]\n\n",
  ];
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          read: async () =>
            i < frames.length
              ? { value: enc.encode(frames[i++]), done: false }
              : { value: undefined, done: true },
          cancel: async () => undefined,
        };
      },
    },
    text: async () => "",
  } as unknown as Response;
}

describe("stream() tool-tag stripping (#718 — local-gemma/qwen path)", () => {
  const visible = (chunks: ChatChunk[]) =>
    chunks
      .filter((c) => c.type === "delta")
      .map((c) => (c.type === "delta" ? c.content : ""))
      .join("");

  async function collect(deltas: string[]): Promise<ChatChunk[]> {
    globalThis.fetch = vi.fn(async () => sseFromDeltas(deltas)) as unknown as typeof fetch;
    const provider = makeProvider();
    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }])) chunks.push(c);
    return chunks;
  }

  it("converts inline qwen <tool_call> XML to a structured event, stripped from text", async () => {
    const chunks = await collect([
      "let me run ",
      '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
      " ok",
    ]);
    expect(visible(chunks)).toBe("let me run  ok");
    expect(visible(chunks)).not.toContain("<tool_call>");
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call?.type === "tool_call" && call.name).toBe("bash");
  });

  it("handles a tool tag split across two SSE deltas without leaking a half-tag", async () => {
    const chunks = await collect([
      "run <tool_ca",
      'll>{"name":"grep","arguments":{}}</tool_call> then stop',
    ]);
    expect(visible(chunks)).toBe("run  then stop");
    expect(visible(chunks)).not.toContain("<tool_");
    expect(chunks.some((c) => c.type === "tool_call")).toBe(true);
  });

  it("still yields a done event after stripping", async () => {
    const chunks = await collect(['<tool_call>{"name":"x","arguments":{}}</tool_call>']);
    expect(chunks.some((c) => c.type === "done")).toBe(true);
  });
});

/**
 * In-band SSE error frames (the empty-document root cause).
 *
 * `bedrock-access-gateway` does NOT fail the HTTP request when the upstream
 * Bedrock `ConverseStream` call is rejected: it answers `200 text/event-stream`
 * and writes the rejection into the body as a single
 * `data: {"error":{"message":"400: ..."}}` frame. The read loop only inspected
 * `choices[0].delta.content`, so the frame was skipped and the stream ended
 * cleanly with ZERO tokens and NO error — every caller then treated the empty
 * string as a successful answer. Live symptom: a Claude Sonnet 5 doc-gen run
 * finished in 9s having made no billable call and persisted a
 * business-requirements document containing only its title and footer, marked
 * `ready` with zero warnings.
 */
describe("in-band SSE error frames", () => {
  /** A `200 text/event-stream` response whose only frame carries an error. */
  function sseErrorFrameResponse(message: string): Response {
    const enc = new TextEncoder();
    const frames = [`data: ${JSON.stringify({ error: { message } })}\n\n`];
    let i = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () =>
              i < frames.length
                ? { value: enc.encode(frames[i++]), done: false }
                : { value: undefined, done: true },
            cancel: async () => undefined,
          };
        },
      },
      text: async () => "",
    } as unknown as Response;
  }

  const TEMP_DEPRECATED =
    "400: An error occurred (ValidationException) when calling the ConverseStream " +
    "operation: The model returned the following errors: `temperature` is deprecated " +
    "for this model.";

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it("extracts the message from an error frame and ignores normal chunks", () => {
    expect(extractSseErrorMessage({ error: { message: " boom " } })).toBe("boom");
    expect(extractSseErrorMessage({ choices: [{ delta: { content: "hi" } }] })).toBeNull();
  });

  it("recovers the upstream status the gateway prefixes onto the message", () => {
    expect(embeddedStatusFromStreamError(TEMP_DEPRECATED)).toBe(400);
    expect(embeddedStatusFromStreamError("no status here")).toBe(0);
  });

  it("THROWS on an error frame instead of ending as an empty success", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseErrorFrameResponse("500: upstream exploded"));
    const provider = makeProvider();
    await expect(async () => {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        // drain
      }
    }).rejects.toThrow(/upstream exploded/);
  });

  it("retries once WITHOUT temperature when the error frame says it is deprecated", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: CapturedInit) => {
      bodies.push(JSON.parse(init.body as string));
      return Promise.resolve(
        bodies.length === 1 ? sseErrorFrameResponse(TEMP_DEPRECATED) : sseResponse(),
      );
    });

    const provider = makeProvider();
    const chunks: ChatChunk[] = [];
    for await (const c of provider.stream([{ role: "user", content: "hi" }])) chunks.push(c);

    // The retry actually produced tokens rather than a silent empty stream.
    expect(chunks.filter((c) => c.type === "delta")).toHaveLength(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("does not retry a second time if the temperature-free attempt also errors", async () => {
    const calls = vi
      .fn()
      .mockImplementation(() => Promise.resolve(sseErrorFrameResponse(TEMP_DEPRECATED)));
    globalThis.fetch = calls;
    const provider = makeProvider();
    await expect(async () => {
      for await (const _ of provider.stream([{ role: "user", content: "hi" }])) {
        // drain
      }
    }).rejects.toThrow(/temperature/i);
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("never restarts the stream once a delta has been emitted (#388)", async () => {
    const enc = new TextEncoder();
    const frames = [
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      `data: ${JSON.stringify({ error: { message: TEMP_DEPRECATED } })}\n\n`,
    ];
    const calls = vi.fn().mockImplementation(() => {
      let i = 0;
      return Promise.resolve({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () =>
              i < frames.length
                ? { value: enc.encode(frames[i++]), done: false }
                : { value: undefined, done: true },
            cancel: async () => undefined,
          }),
        },
        text: async () => "",
      } as unknown as Response);
    });
    globalThis.fetch = calls;

    const provider = makeProvider();
    const seen: ChatChunk[] = [];
    await expect(async () => {
      for await (const c of provider.stream([{ role: "user", content: "hi" }])) seen.push(c);
    }).rejects.toThrow(/temperature/i);
    // The already-emitted token was delivered, and NO second connect happened.
    expect(seen.filter((c) => c.type === "delta")).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});

/** A 400 whose BODY is the gateway's `temperature` deprecation rejection. */
function temperatureRejectedResponse(): Response {
  return {
    ok: false,
    status: 400,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () =>
      JSON.stringify({
        detail:
          "An error occurred (ValidationException) when calling the Converse operation: The model returned the following errors: `temperature` is deprecated for this model.",
      }),
  } as unknown as Response;
}

describe("independent response_format and temperature degradations", () => {
  const responseFormat = {
    type: "json_schema" as const,
    json_schema: { name: "t", strict: true, schema: { type: "object" } },
  };

  it("recovers when the runtime rejects response_format AND temperature", async () => {
    // Claude Sonnet 5 behind bedrock-access-gateway rejects both. An earlier
    // single-catch `chat()` could only recover from one, so enabling structured
    // output turned a recoverable temperature 400 into a hard agent failure.
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: string, init: CapturedInit) => {
      bodies.push(JSON.parse(String(init.body)));
      call += 1;
      // 1st: rejects response_format by status. 2nd: rejects temperature by body.
      if (call === 1) return errorResponse(400);
      if (call === 2) return temperatureRejectedResponse();
      return jsonResponse("recovered");
    }) as unknown as typeof fetch;

    const res = await makeProvider().chat([{ role: "user", content: "hi" }], {
      responseFormat,
      temperature: 0.2,
    });

    expect(res.content).toBe("recovered");
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveProperty("response_format");
    expect(bodies[0]).toHaveProperty("temperature");
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(bodies[2]).not.toHaveProperty("response_format");
    expect(bodies[2]).not.toHaveProperty("temperature");
  });

  it("keeps response_format when only temperature is the problem", async () => {
    // The structured-output branch matches on STATUS alone, so without the
    // body check running first it would strip response_format needlessly.
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: string, init: CapturedInit) => {
      bodies.push(JSON.parse(String(init.body)));
      call += 1;
      return call === 1 ? temperatureRejectedResponse() : jsonResponse("ok");
    }) as unknown as typeof fetch;

    await makeProvider().chat([{ role: "user", content: "hi" }], {
      responseFormat,
      temperature: 0.2,
    });

    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("temperature");
  });

  it("does not retry the same degradation twice", async () => {
    const fetchMock = vi.fn(async () => temperatureRejectedResponse());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      makeProvider().chat([{ role: "user", content: "hi" }], { temperature: 0.2 }),
    ).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * #1226 — the terminal `done` chunk must carry the upstream `finish_reason` so
 * callers can tell a complete answer apart from one the model stopped emitting
 * because it hit its output-token cap. Losing it here is what let docs-gen ship
 * a silently truncated BRD as "ready".
 */
describe("stream() finish_reason forwarding (#1226)", () => {
  /** An SSE response whose last content frame carries `finish_reason`. */
  function sseWithFinishReason(reason: string | null): Response {
    const frames = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      `data: {"choices":[{"delta":{},"finish_reason":${JSON.stringify(reason)}}]}\n\n`,
      "data: [DONE]\n\n",
    ];
    let i = 0;
    const enc = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () =>
              i < frames.length
                ? { value: enc.encode(frames[i++]), done: false }
                : { value: undefined, done: true },
            cancel: async () => undefined,
          };
        },
      },
      text: async () => "",
    } as unknown as Response;
  }

  async function collect(res: Response) {
    globalThis.fetch = vi.fn(async () => res) as unknown as typeof fetch;
    const chunks: Array<{ type: string; finishReason?: string }> = [];
    for await (const c of makeProvider().stream([{ role: "user", content: "hi" }])) {
      chunks.push(c as { type: string; finishReason?: string });
    }
    return chunks;
  }

  it("forwards finish_reason=length on the done chunk (hit the output cap)", async () => {
    const chunks = await collect(sseWithFinishReason("length"));
    const done = chunks.find((c) => c.type === "done");
    expect(done).toEqual({ type: "done", finishReason: "length" });
  });

  it("forwards a normal finish_reason=stop", async () => {
    const chunks = await collect(sseWithFinishReason("stop"));
    expect(chunks.find((c) => c.type === "done")).toEqual({
      type: "done",
      finishReason: "stop",
    });
  });

  it("omits finishReason entirely when the upstream never reports one", async () => {
    const chunks = await collect(sseWithFinishReason(null));
    expect(chunks.find((c) => c.type === "done")).toEqual({ type: "done" });
  });

  it("omits finishReason when no frame carries the field at all", async () => {
    const chunks = await collect(sseResponse());
    expect(chunks.find((c) => c.type === "done")).toEqual({ type: "done" });
  });
});
