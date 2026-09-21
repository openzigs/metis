/**
 * Tests for the config-gated claim-extraction model override (#701).
 *
 * The resolver is the single place `DOCS_GEN_CLAIM_MODEL` is read. `config` is
 * injectable, so these use a tiny stub rather than the global singleton. Default
 * (unset) must return `undefined` so `docsGenTuning` keeps the Haiku default —
 * the "no behaviour change unless enabled" guarantee.
 */
import { describe, it, expect } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import { DOCS_GEN_CLAIM_MODEL_KEY, resolveClaimModelOverride } from "./claim-model-config.js";

/** Minimal ConfigService stub whose `get` returns a fixed value for the key. */
function stubConfig(value: string | undefined): ConfigService {
  return {
    get(key: string): string | undefined {
      return key === DOCS_GEN_CLAIM_MODEL_KEY ? value : undefined;
    },
  } as unknown as ConfigService;
}

describe("resolveClaimModelOverride", () => {
  it("returns undefined when unset (default = current Haiku behaviour)", () => {
    expect(resolveClaimModelOverride(stubConfig(undefined))).toBeUndefined();
  });

  it("returns the configured model id when the key is set (flip)", () => {
    expect(resolveClaimModelOverride(stubConfig("us.anthropic.claude-sonnet-4-6"))).toBe(
      "us.anthropic.claude-sonnet-4-6",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(resolveClaimModelOverride(stubConfig("  claude-sonnet-4-6  "))).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("treats a blank / whitespace-only value as unset", () => {
    expect(resolveClaimModelOverride(stubConfig(""))).toBeUndefined();
    expect(resolveClaimModelOverride(stubConfig("   "))).toBeUndefined();
  });
});
