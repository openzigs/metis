/**
 * #1273 — the OpenAI-compatible adapter retries a non-streamed reply whose
 * body dropped while it was being read, up to `maxAttempts` times INSIDE one
 * `chat()` call. Each such attempt was generated and billed by the provider,
 * so each is reported to the caller (`ChatOptions.onRetriedAttempt`) to be
 * metered — or, with no caller listening, recorded as unmetered by the adapter
 * itself. A loopback server drops the body for real: no `fetch` stub.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetriedAttempt } from "../types.js";

vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
const { auditSpy } = vi.hoisted(() => ({ auditSpy: vi.fn() }));
vi.mock("../../audit/audit-service.js", () => ({ audit: auditSpy }));

const { OpenAICompatibleProvider } = await import("./openai-compatible-provider.js");
const { mayHaveBeenBilled } = await import("./bedrock-direct-provider.js");
const { UNMETERED_ATTEMPT_AUDIT_ACTION } = await import("../retried-attempts.js");

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
beforeEach(() => auditSpy.mockClear());

const USAGE = { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 };

/**
 * A loopback chat server answering each request with the next scripted reply:
 * `drop` sends 200 and part of the JSON body, then destroys the socket;
 * `throttle` answers 429; `ok` answers a complete reply with usage.
 */
async function serve(
  script: Array<"drop" | "throttle" | "ok">,
): Promise<{ baseUrl: string; calls: () => number }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const step = script[calls++] ?? "ok";
      if (step === "throttle") {
        res.writeHead(429, { "content-type": "application/json" }).end('{"error":"slow down"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (step === "drop") {
        res.write(
          '{"id":"c1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assi',
        );
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          model: "gpt-4.1",
          choices: [
            { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
          ],
          usage: USAGE,
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls: () => calls,
  };
}

function provider(baseUrl: string) {
  return new OpenAICompatibleProvider({
    baseUrl,
    apiKey: "k",
    model: "gpt-4.1",
    providerKey: "openai",
    maxAttempts: 4,
    sleepFn: async () => undefined,
  });
}

const ask = [{ role: "user" as const, content: "hello" }];

describe("#1273 — chat() attempts retried inside the OpenAI-compatible adapter", () => {
  it("reports each dropped body it retried to the caller's listener, once, before returning the retry", async () => {
    const { baseUrl, calls } = await serve(["drop", "drop", "ok"]);
    const seen: RetriedAttempt[] = [];
    const res = await provider(baseUrl).chat(ask, { onRetriedAttempt: (a) => seen.push(a) });

    expect(calls()).toBe(3);
    expect(res.content).toBe("hi");
    // The returned usage is the completed attempt's alone.
    expect(res.usage).toMatchObject({ promptTokens: 40, completionTokens: 5, totalTokens: 45 });
    expect(seen.map((a) => a.attempt)).toEqual([1, 2]);
    for (const a of seen) {
      expect(a).toMatchObject({
        errorClass: "stream-terminated",
        provider: "openai",
        model: "gpt-4.1",
      });
      expect(a.error).toBeInstanceOf(Error);
    }
    // A listener claimed them, so the adapter recorded nothing itself.
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("with no listener, records each dropped attempt as unmetered itself (never silently lost)", async () => {
    const { baseUrl } = await serve(["drop", "ok"]);
    await provider(baseUrl).chat(ask, { callType: "synthesis" });

    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({
      action: UNMETERED_ATTEMPT_AUDIT_ACTION,
      target: { type: "ai_provider", id: "openai" },
      metadata: {
        provider: "openai",
        model: "gpt-4.1",
        attempt: 1,
        errorClass: "stream-terminated",
        retriedBy: "adapter",
        callType: "synthesis",
      },
    });
  });

  it("reports only the attempts it retried when every one drops: the last is the caller's to meter", async () => {
    const { baseUrl, calls } = await serve(["drop", "drop", "drop", "drop"]);
    const seen: RetriedAttempt[] = [];
    await expect(
      provider(baseUrl).chat(ask, { onRetriedAttempt: (a) => seen.push(a) }),
    ).rejects.toThrow(/terminated/);
    expect(calls()).toBe(4);
    expect(seen.map((a) => a.attempt)).toEqual([1, 2, 3]);
  });

  it("does not report a 429 it retried: the provider refused it, nothing was generated", async () => {
    const { baseUrl, calls } = await serve(["throttle", "ok"]);
    const seen: RetriedAttempt[] = [];
    await provider(baseUrl).chat(ask, { onRetriedAttempt: (a) => seen.push(a) });
    expect(calls()).toBe(2);
    expect(seen).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("a listener that throws never breaks the call", async () => {
    const { baseUrl } = await serve(["drop", "ok"]);
    const res = await provider(baseUrl).chat(ask, {
      onRetriedAttempt: () => {
        throw new Error("listener bug");
      },
    });
    expect(res.content).toBe("hi");
  });
});

describe("#1273 — mayHaveBeenBilled", () => {
  const withCode = (message: string, code: string) =>
    Object.assign(new TypeError(message), { cause: Object.assign(new Error(code), { code }) });

  it("is true for a reset or a body that died mid-read", () => {
    expect(mayHaveBeenBilled(new TypeError("terminated"))).toBe(true);
    expect(mayHaveBeenBilled(withCode("fetch failed", "ECONNRESET"))).toBe(true);
    expect(mayHaveBeenBilled(withCode("fetch failed", "UND_ERR_SOCKET"))).toBe(true);
  });

  it("is false when the request never reached the provider, or was not a network failure", () => {
    expect(mayHaveBeenBilled(withCode("fetch failed", "ECONNREFUSED"))).toBe(false);
    expect(mayHaveBeenBilled(withCode("fetch failed", "EAI_AGAIN"))).toBe(false);
    expect(mayHaveBeenBilled(new Error("openai returned 400: bad"))).toBe(false);
    expect(mayHaveBeenBilled("terminated")).toBe(false);
  });

  // PR #1274 review — an ETIMEDOUT is "never reached" only on the connect.
  const etimedout = (over: Record<string, unknown>) =>
    Object.assign(new Error((over.message as string) ?? "read ETIMEDOUT"), {
      code: "ETIMEDOUT",
      ...over,
    });

  it("an ETIMEDOUT on the connect never reached the provider (by syscall or by message)", () => {
    const bySyscall = new TypeError("fetch failed", { cause: etimedout({ syscall: "connect" }) });
    const byMessage = new TypeError("fetch failed", {
      cause: etimedout({ message: "connect ETIMEDOUT 10.0.0.1:443" }),
    });
    expect(mayHaveBeenBilled(bySyscall)).toBe(false);
    expect(mayHaveBeenBilled(byMessage)).toBe(false);
  });

  it("any other ETIMEDOUT may have ended a reply the provider billed", () => {
    expect(mayHaveBeenBilled(new TypeError("terminated", { cause: etimedout({}) }))).toBe(true);
    expect(
      mayHaveBeenBilled(new TypeError("fetch failed", { cause: etimedout({ syscall: "read" }) })),
    ).toBe(true);
  });
});

describe("#1273 — the error class an adapter-retried attempt is reported under", () => {
  it("is classified from the error, not fixed (a read timeout is `timeout`)", async () => {
    const { baseUrl } = await serve(["ok"]);
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "read" });
      })
      .mockImplementation((...args) => realFetch(...args));
    try {
      const seen: RetriedAttempt[] = [];
      await provider(baseUrl).chat(ask, { onRetriedAttempt: (a) => seen.push(a) });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.errorClass).toBe("timeout");
    } finally {
      spy.mockRestore();
    }
  });
});
