import { describe, expect, it } from "vitest";
import {
  createQueryClient,
  RATE_LIMITED_MAX_RETRIES,
  RATE_LIMITED_MAX_WAIT_MS,
} from "@/lib/query-client";
import { ApiError } from "@/lib/api-client";

describe("createQueryClient", () => {
  it("applies sensible defaults", () => {
    const client = createQueryClient();
    const defaults = client.getDefaultOptions();
    expect(defaults.queries?.staleTime).toBe(30_000);
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it("does not retry on 4xx ApiErrors", () => {
    const client = createQueryClient();
    const retry = client.getDefaultOptions().queries?.retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") return;
    const err = new ApiError(401, "nope", "AUTH");
    expect(retry(0, err)).toBe(false);
  });

  it("retries once on 5xx ApiErrors", () => {
    const client = createQueryClient();
    const retry = client.getDefaultOptions().queries?.retry;
    if (typeof retry !== "function") throw new Error("expected function");
    const err = new ApiError(502, "bad gateway");
    expect(retry(0, err)).toBe(true);
    expect(retry(1, err)).toBe(false);
  });

  it("retries unknown errors once", () => {
    const client = createQueryClient();
    const retry = client.getDefaultOptions().queries?.retry;
    if (typeof retry !== "function") throw new Error("expected function");
    expect(retry(0, new Error("network"))).toBe(true);
    expect(retry(1, new Error("network"))).toBe(false);
  });

  it("applies the same policy to mutations", () => {
    const client = createQueryClient();
    const retry = client.getDefaultOptions().mutations?.retry;
    if (typeof retry !== "function") throw new Error("expected function");
    expect(retry(0, new ApiError(400, "x"))).toBe(false);
    expect(retry(0, new ApiError(503, "x"))).toBe(true);
  });

  // #1117 — a 429 on `/api/runs` is a signed-in user's own budget: retrying at
  // once only spends it, and a polling query retries on its next interval.
  it("does not retry a rate-limited (429) query at once", () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry;
    if (typeof retry !== "function") throw new Error("expected function");
    expect(retry(0, new ApiError(429, "Too many", "RUNS_RATE_LIMITED"))).toBe(false);
  });

  // #1570 — a 429 that says when to come back is retried then, not never: the
  // Documentation page's detail froze on its last state after one 429.
  describe("a 429 with Retry-After (#1570)", () => {
    const limited = (retryAfterMs: number) =>
      new ApiError(429, "Too many", "GENERATED_DOCS_RATE_LIMITED", undefined, retryAfterMs);

    it("retries a query after the server's Retry-After", () => {
      const { retry, retryDelay } = createQueryClient().getDefaultOptions().queries ?? {};
      if (typeof retry !== "function" || typeof retryDelay !== "function") {
        throw new Error("expected functions");
      }
      const err = limited(848_000);
      expect(retry(0, err)).toBe(true);
      expect(retryDelay(1, err)).toBe(848_000);
    });

    it("gives up after a bounded number of rate-limited retries", () => {
      const retry = createQueryClient().getDefaultOptions().queries?.retry;
      if (typeof retry !== "function") throw new Error("expected function");
      expect(retry(RATE_LIMITED_MAX_RETRIES - 1, limited(1_000))).toBe(true);
      expect(retry(RATE_LIMITED_MAX_RETRIES, limited(1_000))).toBe(false);
    });

    it("does not retry when the wait is longer than a rate-limit window", () => {
      const retry = createQueryClient().getDefaultOptions().queries?.retry;
      if (typeof retry !== "function") throw new Error("expected function");
      expect(retry(0, limited(RATE_LIMITED_MAX_WAIT_MS + 1))).toBe(false);
      expect(retry(0, limited(RATE_LIMITED_MAX_WAIT_MS))).toBe(true);
    });

    it("keeps the default backoff for every other retried error", () => {
      const retryDelay = createQueryClient().getDefaultOptions().queries?.retryDelay;
      if (typeof retryDelay !== "function") throw new Error("expected function");
      expect(retryDelay(1, new ApiError(502, "bad gateway"))).toBe(2_000);
      expect(retryDelay(10, new Error("network"))).toBe(30_000);
    });

    it("never retries a rate-limited mutation", () => {
      const retry = createQueryClient().getDefaultOptions().mutations?.retry;
      if (typeof retry !== "function") throw new Error("expected function");
      expect(retry(0, limited(1_000))).toBe(false);
    });
  });
});
