/**
 * #1257 — the non-streaming output bound, and the thinking allowance.
 *
 * Two facts from #1223's live reproduction drive every case here:
 *
 * 1. `claude-sonnet-5` emits thinking by DEFAULT — METIS sends no `thinking`
 *    field and `output_tokens_details.thinking_tokens` comes back populated —
 *    and it is spent from the SAME `max_tokens` budget as the answer. Measured
 *    5,088 / 7,708 / 8,308 / 9,763 across four runs that reported it.
 * 2. `@anthropic-ai/sdk` refuses a NON-streaming request whose `max_tokens`
 *    implies over ten minutes of work, client-side, before any network call.
 *
 * The derivation below is pinned against the SDK's OWN function rather than
 * restated, so an SDK bump that moves the formula fails a 20 ms unit test
 * instead of a live run. That oracle is the point: `Math.floor(128000*10/60)`
 * appearing on both sides of an assertion would prove nothing (#1222).
 */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS,
  OBSERVED_THINKING_TOKENS,
  SDK_MODEL_NONSTREAMING_TOKENS,
  boundNonStreamingOutputTokens,
  nonStreamingBoundForModel,
  survivesObservedThinkingRun,
  __resetNonStreamingBoundWarnings,
} from "./nonstreaming-output-bound.js";

/** A client is enough to reach the bound check; no network call is made. */
const sdk = (): Anthropic => new Anthropic({ apiKey: "test-key-not-used" });

describe("#1257 — the bound is DERIVED from the SDK, not asserted against itself", () => {
  it("is the largest max_tokens the installed SDK accepts non-streaming", () => {
    const client = sdk();
    expect(() =>
      client.calculateNonstreamingTimeout(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS),
    ).not.toThrow();
    expect(
      () => client.calculateNonstreamingTimeout(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS + 1),
      "the SDK's non-streaming ceiling moved — re-derive the bound from calculateNonstreamingTimeout",
    ).toThrow(/Streaming is required/);
  });

  it("is 21333 on @anthropic-ai/sdk 0.104.2", () => {
    // A LITERAL, deliberately. The derivation is checked against the SDK above;
    // this pins the number the docs, the ADR and the config registry all quote,
    // so a silent change to either shows up as a diff rather than as agreement
    // between two copies of the same expression (#1222).
    expect(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS).toBe(21_333);
  });

  it("sits below every model ceiling in the #1221 table, which is why the clamp missed it", () => {
    // claude-sonnet-5 is listed at 128,000 there. Both numbers are right about
    // different things; this asserts they do NOT coincide, which is the whole
    // premise of #1257.
    expect(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS).toBeLessThan(128_000);
  });
});

describe("#1257 — boundNonStreamingOutputTokens", () => {
  it("clamps an over-bound request on the direct Anthropic SDK provider", () => {
    __resetNonStreamingBoundWarnings();
    const result = boundNonStreamingOutputTokens(32_768, "anthropic");
    expect(result.clamped).toBe(true);
    expect(result.value).toBe(21_333);
    expect(result.bound).toBe(21_333);
  });

  it("leaves a request inside the bound untouched and silent", () => {
    __resetNonStreamingBoundWarnings();
    const warn = vi.fn();
    const result = boundNonStreamingOutputTokens(16_384, "anthropic", { logger: { warn } });
    expect(result.clamped).toBe(false);
    expect(result.value).toBe(16_384);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts exactly the bound and rejects exactly one more", () => {
    __resetNonStreamingBoundWarnings();
    expect(boundNonStreamingOutputTokens(21_333, "anthropic").clamped).toBe(false);
    expect(boundNonStreamingOutputTokens(21_334, "anthropic").clamped).toBe(true);
  });

  it("does NOT bound a provider that does not go through the Anthropic SDK", () => {
    __resetNonStreamingBoundWarnings();
    // Bedrock speaks to the same models through the AWS SDK, which has no such
    // client-side timeout heuristic. Clamping it would be an over-block: a
    // 32,768-token Bedrock batch is legal and was deliberately chosen (#1226).
    for (const key of ["bedrock-gateway", "copilot-native", "openai", "offline-stub"] as const) {
      const result = boundNonStreamingOutputTokens(32_768, key);
      expect(result.clamped, `${key} was clamped by an Anthropic-SDK-only bound`).toBe(false);
      expect(result.value).toBe(32_768);
      expect(result.bound).toBeNull();
    }
  });

  it("does not bound an unknown or absent provider key", () => {
    __resetNonStreamingBoundWarnings();
    expect(boundNonStreamingOutputTokens(32_768, undefined).clamped).toBe(false);
    expect(boundNonStreamingOutputTokens(32_768, null).clamped).toBe(false);
  });

  it("warns ONCE naming both the request and the bound", () => {
    __resetNonStreamingBoundWarnings();
    const warn = vi.fn();
    const opts = { logger: { warn }, knob: "DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS" };
    boundNonStreamingOutputTokens(32_768, "anthropic", opts);
    boundNonStreamingOutputTokens(32_768, "anthropic", opts);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, meta] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS");
    expect(message).toMatch(/stream/i);
    expect(meta).toMatchObject({
      configured: 32_768,
      sdkNonStreamingBound: 21_333,
      effective: 21_333,
    });
  });

  it("still warns for a genuinely different misconfiguration", () => {
    __resetNonStreamingBoundWarnings();
    const warn = vi.fn();
    boundNonStreamingOutputTokens(32_768, "anthropic", { logger: { warn }, knob: "KNOB_A" });
    boundNonStreamingOutputTokens(64_000, "anthropic", { logger: { warn }, knob: "KNOB_A" });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("#1257 — the measured thinking allowance", () => {
  it("carries the observed band from #1223's five live synthesis calls", () => {
    expect(OBSERVED_THINKING_TOKENS.min).toBe(5_088);
    expect(OBSERVED_THINKING_TOKENS.max).toBe(9_763);
  });

  it("fails the 16,000 cap that #1223 measured truncating", () => {
    // Run 5 truncated at a 16,000 cap having spent 9,763 on thinking, so the
    // payload on that run needed more than the 6,237 remaining. 6,500 is inside
    // the "~5–6k tokens of JSON" band once its wrapper is counted, and it is the
    // arm that makes 16,000 fail — which is the observed outcome.
    expect(survivesObservedThinkingRun(16_000, 6_500)).toBe(false);
    // The SAME cap and payload survive the SMALLEST measured think. That is the
    // #1223 finding stated as a test: the cap did not fail, it sat on the
    // boundary and the run-to-run thinking spread decided each call.
    expect(survivesObservedThinkingRun(16_000, 6_500, { thinkingTokens: 5_088 })).toBe(true);
  });

  it("passes a cap with room for the payload AND the worst measured think", () => {
    expect(survivesObservedThinkingRun(21_000, 6_500)).toBe(true);
    // Exactly at the boundary counts as surviving; one token less does not.
    expect(survivesObservedThinkingRun(9_763 + 6_500, 6_500)).toBe(true);
    expect(survivesObservedThinkingRun(9_763 + 6_500 - 1, 6_500)).toBe(false);
  });
});

describe("#1257 — a non-finite request is a defect, not an over-large cap", () => {
  it("passes NaN through instead of laundering it into the bound", () => {
    // Found by this issue's own sweep test: a mis-resolved import produced
    // `NaN`, `NaN <= 21_333` was false, and the clamp turned it into a
    // legal-looking 21,333 — so the sweep passed while measuring nothing.
    __resetNonStreamingBoundWarnings();
    const warn = vi.fn();
    const result = boundNonStreamingOutputTokens(Number.NaN, "anthropic", { logger: { warn } });
    expect(result.clamped).toBe(false);
    expect(Number.isNaN(result.value)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes Infinity through for the same reason", () => {
    __resetNonStreamingBoundWarnings();
    expect(boundNonStreamingOutputTokens(Number.POSITIVE_INFINITY, "anthropic").value).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

/**
 * #1257 (adversarial panel, `instruction-correctness` + `test-falsifiability`) —
 * the issue as filed named ONE throw condition. The SDK has two.
 *
 * `Messages.create` passes `MODEL_NONSTREAMING_TOKENS[body.model]` as a second
 * argument, and `calculateNonstreamingTimeout` throws when `max_tokens` exceeds
 * it — 8,192 for eight `claude-opus-4*` ids, far below the general 21,333. The
 * original oracle tests called that function with ONE argument, which skips the
 * second condition entirely and so could never have caught this.
 */
describe("#1257 — the SDK's SECOND throw condition, per model", () => {
  it("mirrors the SDK's own table byte-for-byte", async () => {
    // The oracle: the installed SDK's file, read off disk. `./internal/constants`
    // is not in the package `exports` map, so it cannot be imported — but the
    // package root is resolvable from its main entry, and an SDK bump that edits
    // the table then fails HERE instead of in production.
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const require_ = createRequire(import.meta.url);
    const sdkRoot = path.dirname(require_.resolve("@anthropic-ai/sdk"));
    const src = readFileSync(path.join(sdkRoot, "internal", "constants.js"), "utf8");

    const body = src.slice(src.indexOf("{", src.indexOf("MODEL_NONSTREAMING_TOKENS =")));
    const fromSdk: Record<string, number> = {};
    for (const m of body.matchAll(/'([^']+)':\s*(\d+)/g)) fromSdk[m[1]] = Number(m[2]);

    // Anti-vacuity: a parse that silently found nothing would pass every
    // comparison below against an equally empty mirror.
    expect(Object.keys(fromSdk).length).toBe(8);
    expect(SDK_MODEL_NONSTREAMING_TOKENS).toEqual(fromSdk);
  });

  it.each(Object.keys(SDK_MODEL_NONSTREAMING_TOKENS))(
    "%s — the installed SDK accepts our bound and throws one above it",
    (model) => {
      const client = sdk();
      const bound = nonStreamingBoundForModel(model);
      const perModel = SDK_MODEL_NONSTREAMING_TOKENS[model];
      // BOTH arguments, exactly as `Messages.create` calls it. With one argument
      // this assertion passes for any bound at or below 21,333 and proves nothing.
      expect(() => client.calculateNonstreamingTimeout(bound, perModel)).not.toThrow();
      expect(
        () => client.calculateNonstreamingTimeout(bound + 1, perModel),
        `the SDK's per-model ceiling for ${model} moved — re-mirror MODEL_NONSTREAMING_TOKENS`,
      ).toThrow(/Streaming is required/);
    },
  );

  it("drops the effective bound to 8192 for a listed model", () => {
    expect(nonStreamingBoundForModel("claude-opus-4-0")).toBe(8_192);
    expect(nonStreamingBoundForModel("claude-opus-4-1-20250805")).toBe(8_192);
  });

  it("leaves an UNLISTED model on the general bound rather than guessing lower", () => {
    // Mirrors the SDK's `?? undefined`, which skips the per-model condition.
    expect(nonStreamingBoundForModel("claude-sonnet-5")).toBe(21_333);
    expect(nonStreamingBoundForModel("claude-opus-5")).toBe(21_333);
    expect(nonStreamingBoundForModel(undefined)).toBe(21_333);
    expect(nonStreamingBoundForModel(null)).toBe(21_333);
  });

  it("clamps a 21,000-token request that the general bound would have passed", () => {
    // The panel's exact scenario: ANTHROPIC_MODEL=claude-opus-4-0 with the
    // synthesis default. Before this fix the request was reported clean at
    // 21,000 and threw client-side anyway.
    __resetNonStreamingBoundWarnings();
    const warn = vi.fn();
    const result = boundNonStreamingOutputTokens(21_000, "anthropic", {
      logger: { warn },
      model: "claude-opus-4-0",
    });
    expect(result.clamped).toBe(true);
    expect(result.value).toBe(8_192);
    expect(result.bound).toBe(8_192);
    const meta = warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(meta.boundSource).toContain("MODEL_NONSTREAMING_TOKENS");
    expect(meta.model).toBe("claude-opus-4-0");
  });

  it("still reports the general bound's source when that is what bound it", () => {
    __resetNonStreamingBoundWarnings();
    const warn = vi.fn();
    boundNonStreamingOutputTokens(32_768, "anthropic", {
      logger: { warn },
      model: "claude-sonnet-5",
    });
    const meta = warn.mock.calls[0]![1] as Record<string, unknown>;
    expect(meta.boundSource).toContain("ten-minute");
    expect(meta.sdkNonStreamingBound).toBe(21_333);
  });
});
