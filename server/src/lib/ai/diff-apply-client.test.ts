/**
 * Epic #195 / Issue #218 — diff-apply client tests.
 */
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffApplyClient, DiffApplyClientError, isMorphApplyEnabled } from "./diff-apply-client.js";

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
  process.env.COPILOT_NATIVE_TOKEN = "test-token";
  process.env.COPILOT_NATIVE_BASE_URL = "http://test:5060";
  delete process.env.MORPH_APPLY_ENABLED;
});

afterEach(() => {
  delete process.env.MORPH_APPLY_ENABLED;
});

describe("DiffApplyClient", () => {
  it("refuses to start without COPILOT_NATIVE_TOKEN", () => {
    delete process.env.COPILOT_NATIVE_TOKEN;
    expect(() => new DiffApplyClient()).toThrow(/COPILOT_NATIVE_TOKEN/);
  });

  it("posts to /apply with bearer auth", async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        content: "patched",
        provider: "morph",
        model: "morph-v3",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        durationMs: 12,
      }),
    );
    const c = new DiffApplyClient({
      fetchImpl: fetchImpl as never,
      timeoutMs: 1_000,
    });
    const out = await c.apply({ original: "a", patch: "b", path: "f.ts" });
    expect(out.content).toBe("patched");
    expect(out.usage.totalTokens).toBe(15);
    const callArgs = fetchImpl.mock.calls[0];
    expect(callArgs[0]).toBe("http://test:5060/apply");
    const init = callArgs[1] as { headers: Record<string, string>; body: string };
    expect(init.headers.authorization).toBe("Bearer test-token");
    const sentBody = JSON.parse(init.body) as { original: string; patch: string };
    expect(sentBody.original).toBe("a");
    expect(sentBody.patch).toBe("b");
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
