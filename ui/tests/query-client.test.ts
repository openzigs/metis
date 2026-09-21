import { describe, expect, it } from "vitest";
import { createQueryClient } from "@/lib/query-client";
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
});
