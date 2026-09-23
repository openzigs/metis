/**
 * #111 — the local provider's timeouts are operator-tunable, reported as what
 * was observed, and a first-token timeout is never retried.
 *
 * Found live: a 130,482-token docs-gen prompt needed ~9.7 min of prefill on a
 * local Ollama host, the hardcoded 600s first-byte budget aborted it with 98% of
 * the prompt processed, and the error asked whether the model was running.
 *
 * Timer tests stub `globalThis.fetch` and use fake timers (no network). The
 * no-retry tests use a real loopback HTTP server with short real budgets, so the
 * request count is what undici actually sent — not what a stub was asked for.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() }),
}));

const { OpenAICompatibleProvider, FirstTokenTimeoutError, LOCAL_TIMEOUT_ENV } =
  await import("./openai-compatible-provider.js");

type Init = RequestInit & { dispatcher?: unknown };
type Opts = ConstructorParameters<typeof OpenAICompatibleProvider>[0];

const ENV_KEYS = Object.values(LOCAL_TIMEOUT_ENV);
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  logWarn.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

function provider(over: Partial<Opts> = {}) {
  return new OpenAICompatibleProvider({
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    model: "laguna-s-2.1",
    providerKey: "local-gemma",
    maxAttempts: 4,
    sleepFn: async () => undefined,
    ...over,
  });
}

/** A fetch that never answers; it rejects only when its abort signal fires. */
function hangingFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    (_url: unknown, init?: Init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * Drain `p.stream()` under fake timers and report WHEN it rejected, in ms of
 * fake time, by stepping the clock in `stepMs` increments up to `limitMs`.
 */
async function streamRejectsAt(
  p: InstanceType<typeof OpenAICompatibleProvider>,
  limitMs: number,
  stepMs: number,
  content = "hi",
): Promise<{ at: number | null; err: unknown }> {
  let settled = false;
  let err: unknown;
  const run = (async () => {
    for await (const _c of p.stream([{ role: "user", content }])) {
      /* drain */
    }
  })().catch((e: unknown) => {
    err = e;
  });
  void run.finally(() => {
    settled = true;
  });
  for (let t = stepMs; t <= limitMs; t += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    if (settled) return { at: t, err };
  }
  return { at: null, err };
}

describe("LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS", () => {
  it("raises the local provider's first-token budget above the 600s default", async () => {
    vi.useFakeTimers();
    hangingFetch();
    process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS = "900000";
    const { at, err } = await streamRejectsAt(provider(), 1_200_000, 60_000);
    expect(at).toBe(900_000);
    expect(err).toBeInstanceOf(FirstTokenTimeoutError);
  });

  it("keeps the 600s default when unset, blank, negative or non-numeric", async () => {
    vi.useFakeTimers();
    for (const raw of [undefined, "", "-5", "abc"]) {
      hangingFetch();
      if (raw === undefined) delete process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS;
      else process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS = raw;
      const { at } = await streamRejectsAt(provider(), 1_200_000, 60_000);
      expect(at, `raw=${String(raw)}`).toBe(600_000);
    }
  });

  it("an explicit constructor option beats the env knob", async () => {
    vi.useFakeTimers();
    hangingFetch();
    process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS = "900000";
    const { at } = await streamRejectsAt(
      provider({ firstByteTimeoutMs: 120_000 }),
      1_200_000,
      60_000,
    );
    expect(at).toBe(120_000);
  });

  it("does not apply to a non-local provider (bedrock-gateway keeps its default)", async () => {
    vi.useFakeTimers();
    hangingFetch();
    process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS = "900000";
    const { at } = await streamRejectsAt(
      provider({ providerKey: "bedrock-gateway" }),
      1_200_000,
      60_000,
    );
    expect(at).toBe(600_000);
  });

  it("sizes undici's headersTimeout from the env budget, so undici cannot preempt it", async () => {
    let dispatcher: unknown;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: Init) => {
      dispatcher = init?.dispatcher;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "ok" } }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS = "1800000";
    await provider().chat([{ role: "user", content: "hi" }]);
    const optionsSym = Object.getOwnPropertySymbols(dispatcher).find(
      (s) => s.description === "options",
    );
    expect(optionsSym).toBeDefined();
    const options = (dispatcher as Record<symbol, { headersTimeout: number }>)[optionsSym!];
    expect(options.headersTimeout).toBe(1_800_000 + 30_000);
  });
});

describe("LOCAL_GEMMA_REQUEST_TIMEOUT_MS / LOCAL_GEMMA_IDLE_TIMEOUT_MS", () => {
  it("the request knob governs non-streaming chat() and is named in its error", async () => {
    vi.useFakeTimers();
    hangingFetch();
    process.env.LOCAL_GEMMA_REQUEST_TIMEOUT_MS = "450000";
    let err: unknown;
    let settled = false;
    void provider()
      .chat([{ role: "user", content: "hi" }])
      .catch((e: unknown) => {
        err = e;
      })
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(449_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(String(err)).toMatch(/timed out after 450000ms/);
    expect(String(err)).toContain("LOCAL_GEMMA_REQUEST_TIMEOUT_MS");
  });

  it("the idle knob governs the between-chunk stall and is named in its error", async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    globalThis.fetch = vi.fn(async (_url: unknown, init?: Init) => {
      let reads = 0;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              if (reads++ === 0) {
                return {
                  value: enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
                  done: false,
                };
              }
              return new Promise((_r, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  const e = new Error("aborted");
                  e.name = "AbortError";
                  reject(e);
                });
              });
            },
            cancel: async () => undefined,
          }),
        },
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    process.env.LOCAL_GEMMA_IDLE_TIMEOUT_MS = "300000";
    const { at, err } = await streamRejectsAt(provider(), 600_000, 30_000);
    expect(at).toBe(300_000);
    expect(String(err)).toMatch(/no data mid-stream for 300000ms/);
    expect(String(err)).toContain("LOCAL_GEMMA_IDLE_TIMEOUT_MS");
  });
});

describe("first-token timeout message and log (#111)", () => {
  it("states the observed budget and prompt size and names the knob — no 'is the model running?'", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const prompt = "x".repeat(12_345);
    const { err } = await streamRejectsAt(
      provider({ firstByteTimeoutMs: 1_000 }),
      5_000,
      500,
      prompt,
    );
    const msg = String((err as Error).message);
    expect(msg).toContain("no first token within 1000ms");
    expect(msg).toContain("prompt of 12345 chars across 1 message(s)");
    expect(msg).toContain("LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS");
    expect(msg).not.toMatch(/is the local model running/);
    expect(err).toMatchObject({ timeoutMs: 1_000, promptChars: 12_345, messageCount: 1 });
  });

  it("logs the prompt size and budget when the timeout fires", async () => {
    vi.useFakeTimers();
    hangingFetch();
    await streamRejectsAt(provider({ firstByteTimeoutMs: 1_000 }), 5_000, 500, "abcdef");
    const call = logWarn.mock.calls.find(([m]) => /before the first token/.test(String(m)));
    expect(call?.[1]).toMatchObject({
      provider: "local-gemma",
      model: "laguna-s-2.1",
      firstByteTimeoutMs: 1_000,
      promptChars: 6,
      messageCount: 1,
      knob: "LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS",
    });
  });

  it("does not name a LOCAL_GEMMA_* knob on a gateway provider", async () => {
    vi.useFakeTimers();
    hangingFetch();
    const { err } = await streamRejectsAt(
      provider({ providerKey: "bedrock-gateway", firstByteTimeoutMs: 1_000 }),
      5_000,
      500,
    );
    expect(String(err)).toContain("no first token within 1000ms");
    expect(String(err)).not.toContain("LOCAL_GEMMA");
  });
});

describe("a first-token timeout is not retried with the identical prompt (#111)", () => {
  let server: http.Server;
  let hits = 0;

  async function serve(sendHeaders: boolean): Promise<string> {
    hits = 0;
    server = http.createServer((req, res) => {
      hits++;
      req.resume();
      if (sendHeaders) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
      }
      // …and never a token: the prefill outlasts the budget.
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }

  afterEach(() => {
    server.closeAllConnections();
    server.close();
  });

  for (const [phase, sendHeaders] of [
    ["before response headers", false],
    ["after response headers", true],
  ] as const) {
    it(`sends exactly one request when the budget expires ${phase}`, async () => {
      const baseUrl = await serve(sendHeaders);
      const p = provider({ baseUrl, firstByteTimeoutMs: 200, maxAttempts: 4 });
      const run = (async () => {
        for await (const _c of p.stream([{ role: "user", content: "hi" }])) {
          /* drain */
        }
      })();
      await expect(run).rejects.toBeInstanceOf(FirstTokenTimeoutError);
      expect(hits).toBe(1);
    });
  }
});
