/**
 * Tests for the native-Anthropic prompt-cache TTL resolver (Epic #696 / #702).
 *
 * The resolver is the single place `ANTHROPIC_PROMPT_CACHE_TTL` is read, so the
 * provider wire shape and the cost multiplier stay in lock-step. `config` is
 * injectable, so these tests use a tiny stub rather than the global singleton.
 */
import { describe, it, expect } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import {
  ANTHROPIC_PROMPT_CACHE_TTL_KEY,
  cacheControlFor,
  resolveAnthropicCacheTtl,
} from "./prompt-cache-ttl.js";

/** Minimal ConfigService stub whose `get` returns a fixed value for the key. */
function stubConfig(value: string | undefined): ConfigService {
  return {
    get(key: string): string | undefined {
      return key === ANTHROPIC_PROMPT_CACHE_TTL_KEY ? value : undefined;
    },
  } as unknown as ConfigService;
}

describe("resolveAnthropicCacheTtl", () => {
  it("defaults to '5m' when the key is unset", () => {
    expect(resolveAnthropicCacheTtl(stubConfig(undefined))).toBe("5m");
  });

  it("returns '5m' when explicitly set to '5m'", () => {
    expect(resolveAnthropicCacheTtl(stubConfig("5m"))).toBe("5m");
  });

  it("returns '1h' only for the exact string '1h'", () => {
    expect(resolveAnthropicCacheTtl(stubConfig("1h"))).toBe("1h");
  });

  it("falls back to '5m' for any unrecognized value (defensive)", () => {
    expect(resolveAnthropicCacheTtl(stubConfig("garbage"))).toBe("5m");
    expect(resolveAnthropicCacheTtl(stubConfig("2h"))).toBe("5m");
    expect(resolveAnthropicCacheTtl(stubConfig(""))).toBe("5m");
  });
});

describe("cacheControlFor", () => {
  it("emits a BARE ephemeral breakpoint for '5m' (no ttl key)", () => {
    const cc = cacheControlFor("5m");
    // deep-equal with NO ttl key — the byte-identical regression guard.
    expect(cc).toEqual({ type: "ephemeral" });
    expect("ttl" in cc).toBe(false);
    expect(JSON.stringify(cc)).toBe('{"type":"ephemeral"}');
  });

  it("adds ttl:'1h' for the 1-hour TTL", () => {
    expect(cacheControlFor("1h")).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
