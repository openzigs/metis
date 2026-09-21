/**
 * Importer HTTP helper — backoff, rate-limit handling, link parsing.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ImporterHttpError,
  computeRetryDelay,
  fetchWithBackoff,
  isRetryable,
  parseLinkHeader,
} from "../src/lib/importers/http.js";

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("parseLinkHeader", () => {
  it("returns {} for null", () => {
    expect(parseLinkHeader(null)).toEqual({});
  });

  it("extracts rel → url pairs", () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(parseLinkHeader(header)).toEqual({
      next: "https://api.github.com/x?page=2",
      last: "https://api.github.com/x?page=9",
    });
  });
});

describe("isRetryable", () => {
  it("retries 429/500/502/503/504/408/425", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isRetryable(res(s))).toBe(true);
    }
  });

  it("retries a 403 secondary rate limit", () => {
    expect(isRetryable(res(403, {}, { "x-ratelimit-remaining": "0" }))).toBe(true);
  });

  it("does not retry a plain 403 or 404", () => {
    expect(isRetryable(res(403))).toBe(false);
    expect(isRetryable(res(404))).toBe(false);
  });
});

describe("computeRetryDelay", () => {
  const opts = { baseDelayMs: 500, maxDelayMs: 30_000, now: () => 1_000_000, random: () => 0.5 };

  it("honours Retry-After seconds", () => {
    expect(computeRetryDelay(res(429, {}, { "retry-after": "3" }), 0, opts)).toBe(3000);
  });

  it("caps Retry-After at maxDelayMs", () => {
    expect(computeRetryDelay(res(429, {}, { "retry-after": "9999" }), 0, opts)).toBe(30_000);
  });

  it("uses X-RateLimit-Reset when remaining is 0", () => {
    const reset = String((1_000_000 + 5000) / 1000); // epoch seconds 5s ahead
    const delay = computeRetryDelay(
      res(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }),
      0,
      opts,
    );
    expect(delay).toBe(5000);
  });

  it("falls back to exponential backoff with jitter", () => {
    // attempt=2 → 500 * 2^2 = 2000, * random(0.5) = 1000
    expect(computeRetryDelay(null, 2, opts)).toBe(1000);
  });
});

describe("fetchWithBackoff", () => {
  const fast = {
    baseDelayMs: 1,
    maxDelayMs: 2,
    sleep: async () => undefined,
    now: () => 0,
    random: () => 0,
  };

  it("returns a successful response", async () => {
    const fetchFn = vi.fn(async () => res(200, { ok: true }));
    const r = await fetchWithBackoff("https://x/y", { method: "GET" }, { fetchFn, ...fast });
    expect(await r.json()).toEqual({ ok: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 500 then succeeds", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(500))
      .mockResolvedValueOnce(res(200, { ok: true }));
    const r = await fetchWithBackoff("https://x/y", {}, { fetchFn, ...fast });
    expect(r.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws ImporterHttpError on a non-retryable 404", async () => {
    const fetchFn = vi.fn(async () => res(404, "nope"));
    await expect(fetchWithBackoff("https://x/y", {}, { fetchFn, ...fast })).rejects.toBeInstanceOf(
      ImporterHttpError,
    );
  });

  it("retries network errors then throws after exhausting retries", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      fetchWithBackoff("https://x/y", {}, { fetchFn, ...fast, maxRetries: 2 }),
    ).rejects.toBeInstanceOf(ImporterHttpError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("aborts immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn(async () => res(200));
    await expect(
      fetchWithBackoff("https://x/y", {}, { fetchFn, signal: controller.signal, ...fast }),
    ).rejects.toThrow(/aborted/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
