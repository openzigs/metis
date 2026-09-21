/**
 * Issue #1219 — `BEDROCK_MODEL_PROFILES` key-name hardening.
 *
 * `buildModelProfileMap` turns the `BEDROCK_MODEL_PROFILES` JSON blob into the
 * model-ID -> profile-ARN map that `BedrockDirectProvider.resolveModel` reads
 * by bracket lookup. Zod validates the SHAPE of that record (flat, string
 * values) but says nothing about the key NAMES, so `constructor` used to
 * survive as an own property of the returned map and shadow the member the
 * lookup inherits from `Object.prototype`.
 *
 * These tests pin the two prototype-pollution key names that are rejected and,
 * just as importantly, pin what is deliberately NOT rejected — ordinary model
 * IDs, and other `Object.prototype` member names such as `toString` — so the
 * guard can neither quietly grow into a filter that refuses real configuration
 * nor be mistaken for a fix to the separate inherited-lookup hazard in
 * `BedrockDirectProvider.resolveModel`.
 */
import { describe, expect, it } from "vitest";
import { loadAIConfig } from "../../../src/lib/ai/config.js";
import { AIConfigError } from "../../../src/lib/ai/errors.js";

const MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const ARN = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123";

describe("BEDROCK_MODEL_PROFILES key names (#1219)", () => {
  it("builds the map from a well-formed flat JSON object", () => {
    const cfg = loadAIConfig({
      BEDROCK_MODEL_PROFILES: JSON.stringify({ [MODEL_ID]: ARN }),
    });
    expect(cfg.modelProfileMap).toEqual({ [MODEL_ID]: ARN });
  });

  it("rejects a `constructor` key instead of letting it shadow the inherited member", () => {
    // Pre-#1219 this did NOT throw: `Object.assign` copies `constructor` as an
    // own enumerable property, so `cfg.modelProfileMap.constructor` came back
    // as the attacker-supplied string.
    expect(() =>
      loadAIConfig({
        BEDROCK_MODEL_PROFILES: JSON.stringify({ constructor: ARN }),
      }),
    ).toThrow(AIConfigError);
    expect(() =>
      loadAIConfig({
        BEDROCK_MODEL_PROFILES: JSON.stringify({ constructor: ARN }),
      }),
    ).toThrow(/constructor/);
  });

  it("rejects a `__proto__` key, which JSON.parse keeps but Zod silently drops", () => {
    // `JSON.parse` gives `__proto__` as a real own property; Zod's object
    // rebuild assigns it back through the `__proto__` setter, which ignores a
    // string value, so the key vanished without a word. Rejecting makes the
    // misconfiguration visible at boot rather than never.
    expect(() =>
      loadAIConfig({
        BEDROCK_MODEL_PROFILES: `{"__proto__":${JSON.stringify(ARN)}}`,
      }),
    ).toThrow(AIConfigError);
  });

  it("rejects a forbidden key even when a legitimate model ID sits beside it", () => {
    expect(() =>
      loadAIConfig({
        BEDROCK_MODEL_PROFILES: JSON.stringify({ [MODEL_ID]: ARN, constructor: ARN }),
      }),
    ).toThrow(AIConfigError);
  });

  it("accepts model IDs that merely CONTAIN a forbidden word — the match is exact", () => {
    // Guards against the rejection widening into a substring test.
    const ids = ["my-constructor-model", "constructors", "x__proto__y", "prototype"];
    const profiles = Object.fromEntries(ids.map((id) => [id, ARN]));
    const cfg = loadAIConfig({ BEDROCK_MODEL_PROFILES: JSON.stringify(profiles) });
    for (const id of ids) {
      expect(cfg.modelProfileMap?.[id]).toBe(ARN);
    }
  });

  it("does NOT reject other Object.prototype member names — the guard is pollution-only", () => {
    // Documents the boundary the guard deliberately stops at. `toString` and
    // friends are reachable through a plain-object lookup, but shadowing one
    // with a string here is harmless; the bare-bracket lookup in
    // `BedrockDirectProvider.resolveModel` is a separate, pre-existing hazard
    // that is equally present when this map is empty, so widening the list
    // would not fix it. If that lookup is ever hardened, revisit this test —
    // do not silently widen the guard and leave this assertion asserting the
    // opposite of the intent.
    const ids = ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf"];
    const cfg = loadAIConfig({
      BEDROCK_MODEL_PROFILES: JSON.stringify(Object.fromEntries(ids.map((id) => [id, ARN]))),
    });
    for (const id of ids) {
      expect(Object.hasOwn(cfg.modelProfileMap ?? {}, id)).toBe(true);
      expect(cfg.modelProfileMap?.[id]).toBe(ARN);
    }
  });

  it("never mutates Object.prototype for any of these inputs", () => {
    for (const raw of [
      `{"__proto__":{"polluted":"yes"}}`,
      `{"constructor":{"prototype":{"polluted":"yes"}}}`,
      `{"__proto__":${JSON.stringify(ARN)}}`,
    ]) {
      try {
        loadAIConfig({ BEDROCK_MODEL_PROFILES: raw });
      } catch {
        // Rejection is the expected outcome for these; the assertion below is
        // about the global object either way.
      }
    }
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("still rejects malformed JSON and non-string values", () => {
    expect(() => loadAIConfig({ BEDROCK_MODEL_PROFILES: "not json" })).toThrow(
      /must be valid JSON/,
    );
    expect(() =>
      loadAIConfig({ BEDROCK_MODEL_PROFILES: JSON.stringify({ [MODEL_ID]: { nested: ARN } }) }),
    ).toThrow(/flat JSON object/);
  });

  it("leaves the map undefined when BEDROCK_MODEL_PROFILES is absent", () => {
    expect(loadAIConfig({}).modelProfileMap).toBeUndefined();
  });
});
