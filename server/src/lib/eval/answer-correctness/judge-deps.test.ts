/**
 * Epic #1316 / Issue #1338 — the judging side.
 *
 * The property under test is NOT "a judge exists". It is that with no provider
 * the run says WHY it could not judge, in a way an author can act on, and that
 * nothing anywhere turns that into a score of zero.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../../ai/types.js";
import { ClaimExtractor } from "../../docs-gen/grounding/claim-extractor.js";
import { FaithfulnessJudge } from "../../docs-gen/grounding/faithfulness-judge.js";
import {
  OFFLINE_STUB_REASON,
  offlineJudgeDeps,
  providerJudgeDeps,
  resolveJudgeDeps,
} from "./judge-deps.js";
import { scoreAnswerCorrectness } from "./metric.js";

const fakeProvider = (offline: boolean): AIProvider =>
  ({
    key: offline ? "offline-stub" : "anthropic",
    model: "test-model",
    offline,
    chat: async () => {
      throw new Error("no test should reach the network");
    },
  }) as unknown as AIProvider;

describe("offlineJudgeDeps", () => {
  it("scores every answer as UNVERIFIABLE — never 0, and never null precision with a number recall", async () => {
    const { deps, unavailableReason } = offlineJudgeDeps("no provider configured for this test");
    expect(unavailableReason).toBe("no provider configured for this test");

    const result = await scoreAnswerCorrectness(
      {
        queryId: "dq-ops-01",
        answer: "The metrics route returns 404 until METRICS_TOKEN is set.",
        reference: "Until METRICS_TOKEN is set, /metrics answers 404.",
      },
      deps,
    );
    expect(result.f1).toBeNull();
    expect(result.f1).not.toBe(0);
    expect(result.precision).toBeNull();
    expect(result.recall).toBeNull();
  });

  it("blames the JUDGE, not the extractor — the reason an author must act on", async () => {
    // If the offline extractor returned NO claims instead of one, the reason
    // would be `no-claims`: a true statement about the extractor and a
    // misdiagnosis of a run whose real problem is an unconfigured provider.
    const result = await scoreAnswerCorrectness(
      { queryId: "q", answer: "An answer.", reference: "A reference." },
      offlineJudgeDeps("offline").deps,
    );
    expect(result.unverifiableReason).toBe("judge-unavailable");
  });
});

describe("providerJudgeDeps", () => {
  it("builds the #1317/#1318 substrate — ClaimExtractor + FaithfulnessJudge — for a live provider", () => {
    const { deps, unavailableReason } = providerJudgeDeps(fakeProvider(false));
    expect(unavailableReason).toBeNull();
    // The no-second-judging-stack constraint, asserted rather than asserted in prose.
    expect(deps.extractor).toBeInstanceOf(ClaimExtractor);
    expect(deps.judge).toBeInstanceOf(FaithfulnessJudge);
  });

  it("refuses the offline stub, so a deterministic non-answer is never scored", () => {
    const resolved = providerJudgeDeps(fakeProvider(true));
    expect(resolved.unavailableReason).toBe(OFFLINE_STUB_REASON);
    expect(resolved.deps.extractor).not.toBeInstanceOf(ClaimExtractor);
  });

  it("passes the model and char-budget overrides through", () => {
    const resolved = providerJudgeDeps(fakeProvider(false), { model: "haiku", charBudget: 1234 });
    expect(resolved.deps.charBudget).toBe(1234);
    expect(resolved.deps.extractor).toBeInstanceOf(ClaimExtractor);
  });

  it("passes an abort signal through to both calls", () => {
    const controller = new AbortController();
    const resolved = providerJudgeDeps(fakeProvider(false), { signal: controller.signal });
    expect(resolved.deps.signal).toBe(controller.signal);
  });

  it("carries the SAME provider out, so answers and judgements come from one resolution", () => {
    const provider = fakeProvider(false);
    expect(providerJudgeDeps(provider).provider).toBe(provider);
    expect(providerJudgeDeps(fakeProvider(true)).provider).toBeNull();
    expect(offlineJudgeDeps("offline").provider).toBeNull();
  });

  it("omits charBudget rather than writing undefined into the deps", () => {
    expect("charBudget" in providerJudgeDeps(fakeProvider(false)).deps).toBe(false);
  });
});

describe("resolveJudgeDeps", () => {
  it("degrades a credential failure into a REASON, so the CLI stays exit-0 offline", () => {
    const resolved = resolveJudgeDeps(() => {
      throw new Error("ANTHROPIC_API_KEY is not set");
    });
    expect(resolved.unavailableReason).toContain("ANTHROPIC_API_KEY is not set");
    expect(resolved.unavailableReason).toContain("no AI provider could be constructed");
  });

  it("reports a non-Error failure without crashing on `.message`", () => {
    const resolved = resolveJudgeDeps(() => {
      throw "provider factory blew up";
    });
    expect(resolved.unavailableReason).toContain("provider factory blew up");
    expect(resolved.provider).toBeNull();
  });

  it("does not construct a provider twice", () => {
    const build = vi.fn(() => fakeProvider(false));
    expect(resolveJudgeDeps(build).unavailableReason).toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
  });
});
