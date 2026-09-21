/**
 * Issue #303 — TOCTOU rebinding integration test for `MCPHttpTransport`.
 *
 * Verifies that the canonical `safeFetch` is invoked per-hop by the
 * transport, so the IP that `assertSafeUrl` validated is the same IP the
 * undici dispatcher would connect to. A malicious resolver that flips its
 * answer between the validation phase and the request must not be able to
 * land traffic on a private IP.
 */
import { describe, expect, it, vi } from "vitest";
import { MCPHttpTransport } from "../../../src/lib/mcp/http-transport.js";

describe("MCPHttpTransport TOCTOU rebinding (issue #303)", () => {
  it("rejects a hostile resolver that flips to RFC1918 between validation and the request", async () => {
    let n = 0;
    const lookup = vi.fn(async () => {
      n += 1;
      // First call (assertSafeUrl during start()) — public.
      // Subsequent calls (canonical safeFetch validateTarget) — RFC1918.
      if (n === 1) return [{ address: "140.82.112.10", family: 4 as const }];
      return [{ address: "10.0.0.5", family: 4 as const }];
    });
    const fetchFn = vi.fn();
    const t = new MCPHttpTransport({
      url: "https://evil.example/mcp",
      fetchFn: fetchFn as never,
      lookupFn: lookup,
    });
    await t.start(); // assertSafeUrl sees the public answer
    await expect(t.request("ping")).rejects.toThrow(/resolves to private/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a redirect target that resolves to AWS metadata even if the initial host is public", async () => {
    let calls = 0;
    const lookup = vi.fn(async (host: string) => {
      if (host === "api.example") return [{ address: "140.82.112.10", family: 4 as const }];
      return [{ address: "169.254.169.254", family: 4 as const }];
    });
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return new Response("", {
        status: 302,
        headers: { location: "https://attacker.example/aws/" },
      });
    });
    const t = new MCPHttpTransport({
      url: "https://api.example/mcp",
      fetchFn: fetchFn as never,
      lookupFn: lookup,
    });
    await t.start();
    await expect(t.request("ping")).rejects.toThrow(/resolves to private/);
    expect(calls).toBe(1);
  });

  it("blocks IPv4-mapped IPv6 RFC1918 returned by hostile DNS", async () => {
    const lookup = vi.fn(async () => [{ address: "::ffff:10.0.0.5", family: 6 as const }]);
    const fetchFn = vi.fn();
    const t = new MCPHttpTransport({
      url: "https://evil.example/mcp",
      fetchFn: fetchFn as never,
      lookupFn: lookup,
    });
    await expect(t.start()).rejects.toThrow(/private/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
