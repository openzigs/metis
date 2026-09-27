/**
 * #308: the local / OpenAI-compatible provider's transport over a REAL
 * loopback server, through undici 8.
 *
 * The provider hands its own undici dispatcher (widened `headersTimeout`,
 * disabled `bodyTimeout`) to Node's built-in `fetch`. Nothing here stubs
 * `fetch`, so each test covers the whole path the upgrade touched: dispatcher,
 * built-in fetch, socket and SSE parsing. Between them they pin streaming, a
 * caller abort, the app-level idle timer (which governs because undici's
 * `bodyTimeout` is off), a body pause that is shorter than the idle budget, the
 * thinking-off fields on the wire, and the per-base-URL FIFO limiter with timers
 * that start only after the slot is acquired.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { OpenAICompatibleProvider, FirstTokenTimeoutError } =
  await import("./openai-compatible-provider.js");

type Opts = ConstructorParameters<typeof OpenAICompatibleProvider>[0];
type Provider = InstanceType<typeof OpenAICompatibleProvider>;

const servers: http.Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

const frame = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const DONE = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;

interface Call {
  body: Record<string, unknown>;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

/**
 * A loopback OpenAI-compatible server. Each chat request is handed to `onChat`
 * once its body has arrived; any other path gets a 404 so a probe never hangs.
 */
async function serve(onChat: (call: Call) => void): Promise<{ baseUrl: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const call = { body: JSON.parse(raw) as Record<string, unknown>, req, res };
      calls.push(call);
      onChat(call);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

function sse(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.flushHeaders();
}

function provider(baseUrl: string, over: Partial<Opts> = {}): Provider {
  return new OpenAICompatibleProvider({
    baseUrl,
    apiKey: "ollama",
    model: "laguna-s-2.1",
    providerKey: "local-gemma",
    maxAttempts: 1,
    sleepFn: async () => undefined,
    ...over,
  });
}

async function collect(p: Provider, opts: Parameters<Provider["stream"]>[1] = {}): Promise<string> {
  let text = "";
  for await (const c of p.stream([{ role: "user", content: "hi" }], opts)) {
    if (c.type === "delta") text += c.content;
  }
  return text;
}

describe("local provider transport over loopback (undici 8)", () => {
  it("streams: a delta reaches the caller before the server sends the next one", async () => {
    let next: () => void = () => undefined;
    const { baseUrl } = await serve(({ res }) => {
      sse(res);
      res.write(frame("one "));
      next = () => res.end(frame("two") + DONE);
    });
    const seen: string[] = [];
    for await (const c of provider(baseUrl).stream([{ role: "user", content: "hi" }])) {
      if (c.type !== "delta") continue;
      seen.push(c.content);
      // The server writes the rest only once the first delta is in hand, so a
      // buffered (non-streaming) transport would deadlock here instead.
      if (seen.length === 1) next();
    }
    expect(seen.join("")).toBe("one two");
  });

  it("sends the thinking-off fields on the wire (local thinking-off)", async () => {
    const { baseUrl, calls } = await serve(({ res }) => {
      sse(res);
      res.end(frame("ok") + DONE);
    });
    expect(await collect(provider(baseUrl, { disableThinking: true }))).toBe("ok");
    expect(calls[0]?.body.think).toBe(false);
    expect(calls[0]?.body.reasoning_effort).toBe("none");
    expect(calls[0]?.body.stream).toBe(true);
  });

  it("a caller abort mid-stream rejects the stream and closes the socket", async () => {
    let closed: Promise<void> | undefined;
    const { baseUrl } = await serve(({ req, res }) => {
      closed = new Promise<void>((r) => req.socket.once("close", () => r()));
      sse(res);
      res.write(frame("partial"));
      // …and never finishes.
    });
    const ac = new AbortController();
    let deltas = 0;
    const err = await (async () => {
      for await (const c of provider(baseUrl, { idleTimeoutMs: 30_000 }).stream(
        [{ role: "user", content: "hi" }],
        { signal: ac.signal },
      )) {
        if (c.type === "delta") {
          deltas++;
          ac.abort();
        }
      }
    })().then(
      () => undefined,
      (e: unknown) => e,
    );
    // The abort landed mid-stream (a delta was delivered first)…
    expect(deltas).toBe(1);
    expect((err as Error | undefined)?.name).toBe("AbortError");
    // …and it reached the socket, not just the reader.
    expect(closed).toBeDefined();
    await closed;
  });

  it("a body pause shorter than the idle budget is not a failure (undici bodyTimeout is off)", async () => {
    const { baseUrl } = await serve(({ res }) => {
      sse(res);
      res.write(frame("a"));
      setTimeout(() => res.end(frame("b") + DONE), 400);
    });
    expect(await collect(provider(baseUrl, { idleTimeoutMs: 5_000 }))).toBe("ab");
  });

  it("a mid-stream stall is ended by the app's idle timer, named in the error", async () => {
    const { baseUrl } = await serve(({ res }) => {
      sse(res);
      res.write(frame("a"));
      // …and then silence.
    });
    const err = await collect(provider(baseUrl, { idleTimeoutMs: 250 })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/no data mid-stream for 250ms/);
    expect(String(err)).not.toMatch(/UND_ERR_BODY_TIMEOUT/);
  });

  it("no response headers within the first-token budget is a FirstTokenTimeoutError, not an undici headers timeout", async () => {
    const { baseUrl } = await serve(() => {
      // Accept the request and never answer.
    });
    const err = await collect(provider(baseUrl, { firstByteTimeoutMs: 250 })).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FirstTokenTimeoutError);
  });

  it("FIFO limiter: one request in flight per base URL, and a queued stream's first-token clock waits for its slot", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { baseUrl, calls } = await serve(({ res }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      res.on("close", () => inFlight--);
      sse(res);
      if (calls.length > 1) {
        res.end(frame("second") + DONE);
        return;
      }
      // The first stream keeps producing for 3x the second's first-token
      // budget, so it holds the only slot the whole time.
      let n = 0;
      const tick = setInterval(() => {
        if (++n < 8) {
          res.write(frame("."));
          return;
        }
        clearInterval(tick);
        res.end(frame("first") + DONE);
      }, 100);
    });
    const p = provider(baseUrl, { firstByteTimeoutMs: 250, idleTimeoutMs: 5_000 });
    const [a, b] = await Promise.all([collect(p), collect(p)]);
    expect(a).toBe(".......first");
    // Had the queued stream's timer started on arrival, it would have fired at
    // 250 ms while the first stream still held the only slot.
    expect(b).toBe("second");
    expect(calls).toHaveLength(2);
    expect(maxInFlight).toBe(1);
  });
});
