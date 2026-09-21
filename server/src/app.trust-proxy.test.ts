/**
 * Issue #17.3 — TRUST_PROXY parsing/validation (A07).
 *
 * A bad `TRUST_PROXY` value must never silently make the rate limiter trust
 * every hop (IP-spoofable). Invalid input falls back to 1 with a warning;
 * valid numeric, boolean, and predicate forms are preserved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTrustProxy } from "./app.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseTrustProxy", () => {
  it("defaults to 1 when unset", () => {
    expect(parseTrustProxy(undefined)).toBe(1);
  });

  it("defaults to 1 for an empty / whitespace string", () => {
    expect(parseTrustProxy("")).toBe(1);
    expect(parseTrustProxy("   ")).toBe(1);
  });

  it("returns a valid non-negative number of hops", () => {
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("0")).toBe(0);
  });

  it("maps 'true' / 'false' to booleans", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("passes through Express predicate strings verbatim", () => {
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
  });

  it("rejects a negative number and falls back to 1 with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTrustProxy("-3")).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("does NOT produce NaN for a malformed numeric-ish value", () => {
    // The old `Number(env)` form turned this into NaN → truthy → trust all.
    // Now it is treated as a predicate string, never NaN.
    const result = parseTrustProxy("3abc");
    expect(result).not.toBeNaN();
    expect(typeof result).toBe("string");
  });
});
