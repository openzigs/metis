/**
 * Process-wide FIFO concurrency limiter for the local provider.
 *
 * Ollama serves one request at a time by default and sends nothing — not even
 * headers — until the served request's first token. With METIS firing three
 * Phase-1 calls at once, the 2nd and 3rd waited in Ollama's queue while their
 * first-byte clocks ran, and were aborted as "stalls" (three modules lost their
 * facts in one measured run). These tests pin: at most N in flight per base URL,
 * FIFO order, timers armed only AFTER a slot is held, and the slot released on
 * every exit path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logDebug, logInfo, logWarn } = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: logDebug, info: logInfo, warn: logWarn, error: vi.fn() }),
}));

const { OpenAICompatibleProvider, FirstTokenTimeoutError } =
  await import("./openai-compatible-provider.js");
const {
  FifoSemaphore,
  LOCAL_MAX_CONCURRENCY_ENV,
  localConcurrencyLimiter,
  resolveLocalMaxConcurrency,
  resetLocalConcurrencyLimitersForTests,
} = await import("./local-concurrency-limiter.js");

type Opts = ConstructorParameters<typeof OpenAICompatibleProvider>[0];
type Provider = InstanceType<typeof OpenAICompatibleProvider>;

const BASE = "http://127.0.0.1:11434/v1";
const originalFetch = globalThis.fetch;
let savedLimit: string | undefined;

beforeEach(() => {
  savedLimit = process.env[LOCAL_MAX_CONCURRENCY_ENV];
  delete process.env[LOCAL_MAX_CONCURRENCY_ENV];
  resetLocalConcurrencyLimitersForTests();
  logDebug.mockReset();
  logInfo.mockReset();
  logWarn.mockReset();
});

afterEach(() => {
  if (savedLimit === undefined) delete process.env[LOCAL_MAX_CONCURRENCY_ENV];
  else process.env[LOCAL_MAX_CONCURRENCY_ENV] = savedLimit;
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function provider(over: Partial<Opts> = {}): Provider {
  return new OpenAICompatibleProvider({
    baseUrl: BASE,
    apiKey: "ollama",
    model: "laguna-s-2.1",
    providerKey: "local-gemma",
    maxAttempts: 1,
    sleepFn: async () => undefined,
    ...over,
  });
}

function jsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** An SSE response whose frames the test pushes by hand. */
function manualSse() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    delta(text: string) {
      ctrl.enqueue(
        enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
      );
    },
    finish() {
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
    errorFrame(message: string) {
      ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`));
    },
    fail(err: unknown) {
      ctrl.error(err);
    },
  };
}

function sseOnce(text: string): Response {
  const s = manualSse();
  s.delta(text);
  s.finish();
  return s.response;
}

interface PendingFetch {
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

/**
 * A fetch whose every call stays pending until the test settles it. Rejects with
 * an AbortError when its signal aborts, like undici.
 */
function controllableFetch() {
  const calls: PendingFetch[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const done = () => {
          inFlight--;
        };
        const call: PendingFetch = {
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          signal: init?.signal ?? undefined,
          resolve: (r) => {
            done();
            resolve(r);
          },
          reject: (e) => {
            done();
            reject(e);
          },
        };
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          call.reject(e);
        });
        calls.push(call);
      }),
  ) as unknown as typeof fetch;
  return {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

const flush = async (n = 10) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

const tag = (c: PendingFetch) =>
  (c.body.messages as Array<{ content: string }>).at(-1)?.content ?? "";

function limiter() {
  return localConcurrencyLimiter(BASE);
}

describe("LOCAL_GEMMA_MAX_CONCURRENCY parsing", () => {
  it("defaults to 1 (Ollama's own default) and accepts plain positive integers", () => {
    expect(resolveLocalMaxConcurrency(undefined)).toBe(1);
    expect(resolveLocalMaxConcurrency(" ")).toBe(1);
    expect(resolveLocalMaxConcurrency("3")).toBe(3);
    expect(resolveLocalMaxConcurrency(" 4 ")).toBe(4);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it.each(["0", "-2", "1.5", "2e1", "abc", "99999999999999999999"])(
    "rejects %s and keeps the default",
    (raw) => {
      expect(resolveLocalMaxConcurrency(raw)).toBe(1);
      expect(logWarn).toHaveBeenCalledTimes(1);
    },
  );

  it("reads the env when the limiter is first created and logs the limit once", () => {
    process.env[LOCAL_MAX_CONCURRENCY_ENV] = "2";
    provider();
    provider();
    expect(limiter().limit).toBe(2);
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(
      "Local model concurrency limit in effect",
      // The key is the normalised origin, so one Ollama is one limiter.
      expect.objectContaining({ maxConcurrency: 2, target: "http://localhost:11434" }),
    );
  });
});

describe("limiter key normalisation (PR #187 review)", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://LOCALHOST:11434/v1/",
    "http://127.0.0.1:11434",
    "http://[::1]:11434/v1",
    "http://127.0.0.1:11434/v1//",
  ])("%s shares the 127.0.0.1:11434 limiter", (spelling) => {
    expect(localConcurrencyLimiter(spelling)).toBe(localConcurrencyLimiter(BASE));
  });

  it("keeps different hosts, ports and schemes apart", () => {
    const base = localConcurrencyLimiter(BASE);
    expect(localConcurrencyLimiter("http://127.0.0.1:8000/v1")).not.toBe(base);
    expect(localConcurrencyLimiter("http://10.0.0.5:11434/v1")).not.toBe(base);
    expect(localConcurrencyLimiter("https://127.0.0.1:11434/v1")).not.toBe(base);
  });

  it("two providers spelling one host differently never exceed the limit together", async () => {
    const f = controllableFetch();
    const a = provider({ baseUrl: "http://localhost:11434/v1" });
    const b = provider({ baseUrl: "http://127.0.0.1:11434/v1" });
    const ra = a.chat([{ role: "user", content: "a" }]);
    const rb = b.chat([{ role: "user", content: "b" }]);
    await flush();
    expect(f.calls).toHaveLength(1);
    f.calls[0].resolve(jsonResponse("A"));
    await ra;
    await flush();
    expect(f.calls).toHaveLength(2);
    f.calls[1].resolve(jsonResponse("B"));
    await rb;
    expect(f.maxInFlight).toBe(1);
  });

  it("fills in the scheme's default port", () => {
    expect(localConcurrencyLimiter("http://localhost/v1")).toBe(
      localConcurrencyLimiter("http://127.0.0.1:80"),
    );
    expect(localConcurrencyLimiter("https://gpu-box.lan/v1")).toBe(
      localConcurrencyLimiter("https://GPU-BOX.lan:443"),
    );
  });

  it("an unparseable base URL still gets a (trimmed) limiter of its own", () => {
    expect(localConcurrencyLimiter("not a url/")).toBe(localConcurrencyLimiter("not a url"));
  });
});

describe("FifoSemaphore", () => {
  it("grants in arrival order and hands a released slot straight to the oldest waiter", async () => {
    const sem = new FifoSemaphore(1, "t");
    const order: string[] = [];
    const r1 = await sem.acquire();
    const p2 = sem.acquire().then((r) => (order.push("2"), r));
    const p3 = sem.acquire().then((r) => (order.push("3"), r));
    expect(sem.queued).toBe(2);
    r1();
    r1(); // idempotent — must not free a second slot
    const r2 = await p2;
    expect(sem.inFlight).toBe(1);
    expect(order).toEqual(["2"]);
    r2();
    (await p3)();
    expect(order).toEqual(["2", "3"]);
    expect(sem.inFlight).toBe(0);
  });

  it("drops a waiter whose signal aborts, without consuming a slot", async () => {
    const sem = new FifoSemaphore(1, "t");
    const r1 = await sem.acquire();
    const ac = new AbortController();
    const aborted = sem.acquire(ac.signal);
    const p3 = sem.acquire();
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    expect(sem.queued).toBe(1);
    r1();
    (await p3)();
    expect(sem.inFlight).toBe(0);
    await expect(sem.acquire(ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("provider requests are limited per base URL", () => {
  it("serves concurrent chat() calls strictly one at a time, in FIFO order", async () => {
    const f = controllableFetch();
    const p = provider();
    const results = ["a", "b", "c"].map((t) => p.chat([{ role: "user", content: t }]));
    await flush();
    expect(f.calls.map(tag)).toEqual(["a"]);
    f.calls[0].resolve(jsonResponse("A"));
    await flush();
    expect(f.calls.map(tag)).toEqual(["a", "b"]);
    f.calls[1].resolve(jsonResponse("B"));
    await flush();
    f.calls[2].resolve(jsonResponse("C"));
    expect((await Promise.all(results)).map((r) => r.content)).toEqual(["A", "B", "C"]);
    expect(f.maxInFlight).toBe(1);
    expect(limiter().inFlight).toBe(0);
    expect(logDebug).toHaveBeenCalledWith(
      "Local model request acquired a concurrency slot after waiting",
      expect.objectContaining({ waitedMs: expect.any(Number) }),
    );
  });

  it("never exceeds LOCAL_GEMMA_MAX_CONCURRENCY across instances sharing a base URL", async () => {
    process.env[LOCAL_MAX_CONCURRENCY_ENV] = "2";
    const f = controllableFetch();
    const a = provider();
    const b = provider({ model: "other" });
    const all = Array.from({ length: 6 }, (_, i) =>
      (i % 2 ? a : b).chat([{ role: "user", content: String(i) }]),
    );
    for (let settled = 0; settled < 6; settled++) {
      await flush();
      expect(f.calls.length - settled).toBeLessThanOrEqual(2);
      f.calls[settled].resolve(jsonResponse(String(settled)));
    }
    await Promise.all(all);
    expect(f.maxInFlight).toBe(2);
    expect(f.calls.map(tag)).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("does not limit a non-local provider", async () => {
    const f = controllableFetch();
    const p = provider({ providerKey: "bedrock-gateway" });
    const all = [
      p.chat([{ role: "user", content: "a" }]),
      p.chat([{ role: "user", content: "b" }]),
    ];
    await flush();
    expect(f.calls).toHaveLength(2);
    f.calls.forEach((c) => c.resolve(jsonResponse("x")));
    await Promise.all(all);
  });

  it("holds a stream's slot until the stream is fully consumed", async () => {
    const f = controllableFetch();
    const p = provider();
    const s1 = manualSse();
    const run1 = (async () => {
      let t = "";
      for await (const c of p.stream([{ role: "user", content: "s1" }]))
        if (c.type === "delta") t += c.content;
      return t;
    })();
    const run2 = p.chat([{ role: "user", content: "c2" }]);
    await flush();
    f.calls[0].resolve(s1.response);
    await flush();
    s1.delta("hel");
    await flush();
    expect(f.calls).toHaveLength(1); // headers + a token received; still streaming
    s1.delta("lo");
    s1.finish();
    expect(await run1).toBe("hello");
    await flush();
    expect(f.calls).toHaveLength(2);
    f.calls[1].resolve(jsonResponse("ok"));
    await run2;
  });
});

describe("timers start only after the slot is acquired", () => {
  it("a queued stream's first-byte clock does not run while it waits", async () => {
    vi.useFakeTimers();
    const f = controllableFetch();
    const p = provider({ firstByteTimeoutMs: 1_000, idleTimeoutMs: 1_000 });
    const s1 = manualSse();
    const run1 = (async () => {
      for await (const _ of p.stream([{ role: "user", content: "long" }])) {
        /* drain */
      }
    })();
    let err2: unknown;
    let text2 = "";
    const run2 = (async () => {
      for await (const c of p.stream([{ role: "user", content: "queued" }]))
        if (c.type === "delta") text2 += c.content;
    })().catch((e: unknown) => {
      err2 = e;
    });
    await vi.advanceTimersByTimeAsync(500);
    f.calls[0].resolve(s1.response);
    // The first request streams for 5s — 5x the queued request's first-byte budget.
    for (let t = 0; t < 10; t++) {
      s1.delta(".");
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(f.calls).toHaveLength(1);
    expect(err2).toBeUndefined();
    s1.finish();
    await run1;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(2);
    // Now its own clock runs: answering inside the budget succeeds…
    await vi.advanceTimersByTimeAsync(900);
    f.calls[1].resolve(sseOnce("done"));
    await run2;
    expect(err2).toBeUndefined();
    expect(text2).toBe("done");
  });

  it("…and still fires once the slot is held and the budget elapses", async () => {
    vi.useFakeTimers();
    const f = controllableFetch();
    const p = provider({ firstByteTimeoutMs: 1_000 });
    let err: unknown;
    const run = (async () => {
      for await (const _ of p.stream([{ role: "user", content: "x" }])) {
        /* drain */
      }
    })().catch((e: unknown) => {
      err = e;
    });
    await vi.advanceTimersByTimeAsync(1_001);
    await run;
    expect(err).toBeInstanceOf(FirstTokenTimeoutError);
    expect(f.calls).toHaveLength(1);
    expect(limiter().inFlight).toBe(0); // released on timeout
  });

  it("a queued chat()'s request timeout does not run while it waits", async () => {
    vi.useFakeTimers();
    const f = controllableFetch();
    const p = provider({ requestTimeoutMs: 1_000 });
    const first = p.chat([{ role: "user", content: "a" }]);
    let err2: unknown;
    const second = p.chat([{ role: "user", content: "b" }]).catch((e: unknown) => {
      err2 = e;
    });
    await vi.advanceTimersByTimeAsync(900);
    f.calls[0].resolve(jsonResponse("A"));
    await first;
    // Hold the second past what would have been its deadline had it started at t=0.
    await vi.advanceTimersByTimeAsync(900);
    expect(err2).toBeUndefined();
    f.calls[1].resolve(jsonResponse("B"));
    await second;
    expect(err2).toBeUndefined();
  });
});

describe("the slot is released on every exit path", () => {
  async function nextCallRuns(p: Provider, f: ReturnType<typeof controllableFetch>) {
    const before = f.calls.length;
    const next = p.chat([{ role: "user", content: "next" }]);
    await flush();
    expect(f.calls).toHaveLength(before + 1);
    f.calls[before].resolve(jsonResponse("ok"));
    await next;
    expect(limiter().inFlight).toBe(0);
  }

  it("on a chat() HTTP error", async () => {
    const f = controllableFetch();
    const p = provider();
    const failing = p.chat([{ role: "user", content: "x" }]);
    await flush();
    f.calls[0].resolve(new Response("boom", { status: 500 }));
    await expect(failing).rejects.toThrow(/500/);
    await nextCallRuns(p, f);
  });

  it("on a chat() network error", async () => {
    const f = controllableFetch();
    const p = provider();
    const failing = p.chat([{ role: "user", content: "x" }]);
    await flush();
    f.calls[0].reject(new TypeError("fetch failed"));
    await expect(failing).rejects.toThrow(/fetch failed/);
    await nextCallRuns(p, f);
  });

  it("on a caller abort mid-request", async () => {
    const f = controllableFetch();
    const p = provider();
    const ac = new AbortController();
    const failing = p.chat([{ role: "user", content: "x" }], { signal: ac.signal });
    await flush();
    ac.abort();
    await expect(failing).rejects.toMatchObject({ name: "AbortError" });
    await nextCallRuns(p, f);
  });

  it("on a caller abort while still queued (never sends the request)", async () => {
    const f = controllableFetch();
    const p = provider();
    const first = p.chat([{ role: "user", content: "first" }]);
    const ac = new AbortController();
    const queued = p.chat([{ role: "user", content: "queued" }], { signal: ac.signal });
    await flush();
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    f.calls[0].resolve(jsonResponse("A"));
    await first;
    await nextCallRuns(p, f);
    expect(f.calls.map(tag)).toEqual(["first", "next"]);
  });

  it("on a stream() HTTP error", async () => {
    const f = controllableFetch();
    const p = provider();
    const run = (async () => {
      for await (const _ of p.stream([{ role: "user", content: "x" }])) {
        /* drain */
      }
    })();
    await flush();
    f.calls[0].resolve(new Response("nope", { status: 404 }));
    await expect(run).rejects.toThrow(/404/);
    await nextCallRuns(p, f);
  });

  it("on a mid-stream in-band error frame", async () => {
    const f = controllableFetch();
    const p = provider();
    const s = manualSse();
    const run = (async () => {
      for await (const _ of p.stream([{ role: "user", content: "x" }])) {
        /* drain */
      }
    })();
    await flush();
    f.calls[0].resolve(s.response);
    s.delta("a");
    s.errorFrame("kaboom");
    await expect(run).rejects.toThrow(/kaboom/);
    await nextCallRuns(p, f);
  });

  it("when the consumer stops iterating early", async () => {
    const f = controllableFetch();
    const p = provider();
    const s = manualSse();
    const run = (async () => {
      for await (const c of p.stream([{ role: "user", content: "x" }])) {
        if (c.type === "delta") break;
      }
    })();
    await flush();
    f.calls[0].resolve(s.response);
    s.delta("first");
    await run;
    expect(limiter().inFlight).toBe(0);
    await nextCallRuns(p, f);
  });

  it("on a chat() request timeout while in flight", async () => {
    vi.useFakeTimers();
    const f = controllableFetch();
    const p = provider({ requestTimeoutMs: 1_000 });
    const failing = p.chat([{ role: "user", content: "x" }]);
    const settled = expect(failing).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_001);
    await settled;
    expect(f.calls).toHaveLength(1);
    expect(limiter().inFlight).toBe(0);
    vi.useRealTimers();
    await nextCallRuns(p, f);
  });

  it("on a stream() caller abort while still queued (never sends the request)", async () => {
    const f = controllableFetch();
    const p = provider();
    const first = p.chat([{ role: "user", content: "first" }]);
    const ac = new AbortController();
    const queued = (async () => {
      for await (const _ of p.stream([{ role: "user", content: "queued" }], {
        signal: ac.signal,
      })) {
        /* drain */
      }
    })();
    await flush();
    expect(limiter().queued).toBe(1);
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(limiter().queued).toBe(0);
    f.calls[0].resolve(jsonResponse("A"));
    await first;
    await nextCallRuns(p, f);
    expect(f.calls.map(tag)).toEqual(["first", "next"]);
  });

  it("across a 429 → backoff → retry cycle: the slot is free during the sleep", async () => {
    const f = controllableFetch();
    const inFlightDuringSleep: number[] = [];
    const p = provider({
      maxAttempts: 2,
      sleepFn: async () => {
        inFlightDuringSleep.push(limiter().inFlight);
      },
    });
    const run = p.chat([{ role: "user", content: "x" }]);
    await flush();
    f.calls[0].resolve(new Response("slow down", { status: 429 }));
    await flush(20);
    expect(inFlightDuringSleep).toEqual([0]);
    expect(f.calls).toHaveLength(2);
    f.calls[1].resolve(jsonResponse("ok"));
    await expect(run).resolves.toMatchObject({ content: "ok" });
    expect(limiter().inFlight).toBe(0);
    await nextCallRuns(p, f);
  });

  it("on a caller abort mid-stream", async () => {
    const f = controllableFetch();
    const p = provider();
    const s = manualSse();
    const ac = new AbortController();
    const run = (async () => {
      for await (const _ of p.stream([{ role: "user", content: "x" }], { signal: ac.signal })) {
        ac.abort();
      }
    })();
    await flush();
    // Like undici: aborting the request errors its body stream.
    f.calls[0].signal?.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      s.fail(e);
    });
    f.calls[0].resolve(s.response);
    s.delta("first");
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    await nextCallRuns(p, f);
  });
});
