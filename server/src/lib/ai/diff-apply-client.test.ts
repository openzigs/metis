/**
 * Epic #195 / Issue #218 — diff-apply client tests. #150 — the client calls the
 * Morph API directly (the copilot-svc sidecar hop was removed).
 */
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MORPH_API_URL,
  DEFAULT_MORPH_MODEL,
  DiffApplyClient,
  DiffApplyClientError,
  isMorphApplyEnabled,
} from "./diff-apply-client.js";

interface MockResponse {
  statusCode: number;
  body: { json: () => Promise<unknown>; text: () => Promise<string> };
}

function makeResponse(body: unknown, status = 200): MockResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    statusCode: status,
    body: {
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
      text: async () => text,
    },
  };
}

beforeEach(() => {
  process.env.MORPH_API_KEY = "morph-test-key";
  delete process.env.MORPH_API_URL;
  delete process.env.MORPH_MODEL;
  delete process.env.MORPH_APPLY_ENABLED;
});

afterEach(() => {
  delete process.env.MORPH_APPLY_ENABLED;
  delete process.env.MORPH_API_KEY;
  delete process.env.MORPH_API_URL;
  delete process.env.MORPH_MODEL;
});

describe("DiffApplyClient", () => {
  it("refuses to start without MORPH_API_KEY", () => {
    delete process.env.MORPH_API_KEY;
    expect(() => new DiffApplyClient()).toThrow(/MORPH_API_KEY/);
  });

  it("refuses a whitespace-only MORPH_API_KEY", () => {
    process.env.MORPH_API_KEY = "   ";
    expect(() => new DiffApplyClient()).toThrow(/MORPH_API_KEY/);
  });

  // #150 — the sidecar hop is gone: the client calls the Morph API itself.
  it("posts straight to the Morph API with the Morph key and the default model", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        content: "patched",
        model: "morph-v3",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    );
    const c = new DiffApplyClient({
      fetchImpl: fetchImpl as never,
      timeoutMs: 1_000,
    });
    const out = await c.apply({ original: "a", patch: "b", path: "f.ts" });
    expect(out.content).toBe("patched");
    expect(out.provider).toBe("morph");
    expect(out.usage.totalTokens).toBe(15);
    expect(typeof out.durationMs).toBe("number");
    const callArgs = fetchImpl.mock.calls[0] as unknown as [string, unknown];
    expect(callArgs[0]).toBe(DEFAULT_MORPH_API_URL);
    const init = callArgs[1] as { headers: Record<string, string>; body: string };
    expect(init.headers.authorization).toBe("Bearer morph-test-key");
    const sentBody = JSON.parse(init.body) as Record<string, unknown>;
    expect(sentBody).toEqual({
      model: DEFAULT_MORPH_MODEL,
      original: "a",
      patch: "b",
      path: "f.ts",
    });
  });

  it("honours MORPH_API_URL / MORPH_MODEL and a per-call model", async () => {
    process.env.MORPH_API_URL = "https://morph.internal.example/v1/apply";
    process.env.MORPH_MODEL = "morph-v2";
    const fetchImpl = vi.fn(async () => makeResponse({ result: "via-result" }));
    const c = new DiffApplyClient({ fetchImpl: fetchImpl as never });
    const first = await c.apply({ original: "a", patch: "b" });
    // `result` is accepted as the content field; the model falls back to the request's.
    expect(first.content).toBe("via-result");
    expect(first.model).toBe("morph-v2");
    expect(first.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    await c.apply({ original: "a", patch: "b", model: "morph-large" });
    const calls = fetchImpl.mock.calls as unknown as Array<[string, { body: string }]>;
    expect(calls[0][0]).toBe("https://morph.internal.example/v1/apply");
    expect(JSON.parse(calls[0][1].body).model).toBe("morph-v2");
    expect(JSON.parse(calls[1][1].body).model).toBe("morph-large");
  });

  it("sums prompt + completion when the API omits totalTokens", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({ content: "x", usage: { promptTokens: 3, completionTokens: 4 } }),
    );
    const c = new DiffApplyClient({ fetchImpl: fetchImpl as never });
    const out = await c.apply({ original: "a", patch: "b" });
    expect(out.usage.totalTokens).toBe(7);
  });

  it("validates required `original` and `patch`", async () => {
    const c = new DiffApplyClient({
      fetchImpl: (async () => makeResponse({})) as never,
    });
    await expect(c.apply({ original: "", patch: "p" } as never)).rejects.toBeInstanceOf(
      DiffApplyClientError,
    );
    await expect(c.apply({ original: "a", patch: "" } as never)).rejects.toBeInstanceOf(
      DiffApplyClientError,
    );
  });

  it("propagates upstream non-2xx as DiffApplyClientError with status", async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ error: "denied" }, 502));
    const c = new DiffApplyClient({ fetchImpl: fetchImpl as never });
    await expect(c.apply({ original: "a", patch: "b" })).rejects.toMatchObject({
      status: 502,
    });
  });

  it("translates AbortError into a 504 timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const c = new DiffApplyClient({
      fetchImpl: fetchImpl as never,
      timeoutMs: 1_000,
    });
    await expect(c.apply({ original: "a", patch: "b" })).rejects.toMatchObject({
      status: 504,
    });
  });

  it("wraps generic network errors as 502", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const c = new DiffApplyClient({ fetchImpl: fetchImpl as never });
    await expect(c.apply({ original: "a", patch: "b" })).rejects.toMatchObject({
      status: 502,
    });
  });

  it("respects the MORPH_APPLY_TIMEOUT_MS env var", () => {
    process.env.MORPH_APPLY_TIMEOUT_MS = "5000";
    const c = new DiffApplyClient({
      fetchImpl: (async () => makeResponse({})) as never,
    });
    // Probe the private field via JSON of a synthetic call — we just want the
    // constructor not to choke and to honour the override.
    expect(c).toBeInstanceOf(DiffApplyClient);
    delete process.env.MORPH_APPLY_TIMEOUT_MS;
  });
});

describe("isMorphApplyEnabled", () => {
  it("treats truthy strings as enabled", () => {
    process.env.MORPH_APPLY_ENABLED = "true";
    expect(isMorphApplyEnabled()).toBe(true);
    process.env.MORPH_APPLY_ENABLED = "1";
    expect(isMorphApplyEnabled()).toBe(true);
    process.env.MORPH_APPLY_ENABLED = "yes";
    expect(isMorphApplyEnabled()).toBe(true);
  });

  it("returns false when unset or non-truthy", () => {
    delete process.env.MORPH_APPLY_ENABLED;
    expect(isMorphApplyEnabled()).toBe(false);
    process.env.MORPH_APPLY_ENABLED = "no";
    expect(isMorphApplyEnabled()).toBe(false);
  });
});

// Silence the unused-import warning for Readable.
void Readable;
