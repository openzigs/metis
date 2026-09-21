/**
 * Epic #726 / Issue #738 — requirement→code mapping precision/recall eval
 * (CI-gating).
 *
 * Proves, end-to-end and OFFLINE (no live LLM / gateway / embedder / DB), that
 * the deterministic B2 mapping path (`mapRequirementToCode` + `blastRadius` via
 * `computeProjectImpact` — the SAME path #735 wires into analysis) recovers the
 * files a set of replayed PRs actually changed, at or above a regression floor.
 *
 * The predicted set is DERIVED by running the real mapper over the parsed
 * fixture (never hardcoded), so a mapping regression drops the score and fails
 * the eval. The threshold is set below the fixture's measured performance with
 * headroom; a final guard asserts the floors are meaningful (a floor above the
 * measured score would fail), so the gate can never silently degrade to a
 * no-op.
 */
import { describe, expect, it } from "vitest";
import { loadReqMapFixture, type ReqMapFixture } from "./fixture.js";
import {
  checkThresholds,
  predictAffectedFiles,
  REQMAP_EVAL_THRESHOLDS,
  runReqMapEval,
} from "./runner.js";

async function fixture(): Promise<ReqMapFixture> {
  return loadReqMapFixture();
}

describe("reqmap eval — fixture", () => {
  it("loads a self-contained fixture with parsed symbols and ground-truth cases", async () => {
    const f = await fixture();
    expect(f.projectId).toBe("reqmap-eval-project");
    expect(f.symbols.length).toBeGreaterThan(0);
    expect(f.cases.length).toBeGreaterThanOrEqual(3);
    // Every case names ≥1 real changed file.
    for (const c of f.cases) {
      expect(c.changedFiles.length).toBeGreaterThan(0);
      expect(c.requirement.length).toBeGreaterThan(0);
    }
    // No module pseudo-symbols leak into the index (reused #717 parser rule).
    expect(f.symbols.some((s) => s.kind === "module")).toBe(false);
  });

  it("declared edges resolve to real symbols (fixture is internally consistent)", async () => {
    const f = await fixture();
    // A known call site: handleCheckout calls calculateProcessingFee, so the fee
    // function has an incoming edge the blast radius can walk back to checkout.
    const fee = f.symbols.find((s) => s.name === "calculateProcessingFee");
    expect(fee).toBeDefined();
    const incoming = await f.dataSource.getEdgesTo(fee!.id);
    expect(incoming.length).toBeGreaterThanOrEqual(1);
  });
});

describe("reqmap eval — precision/recall vs replayed PRs", () => {
  it("recovers changed files at or above the regression floor", async () => {
    const f = await fixture();
    const { scores, aggregate } = await runReqMapEval(f);

    // One score per replayed PR.
    expect(scores.length).toBe(f.cases.length);
    // Every case at least HITS (finds ≥1 truly-changed file) — the mapping is
    // never entirely wrong for these requirements.
    for (const s of scores) {
      expect(s.hit).toBe(true);
    }

    const { passed, checks } = checkThresholds(aggregate);
    // Surface which metric regressed if this ever fails.
    expect({ passed, checks, aggregate }).toMatchObject({ passed: true });
    expect(aggregate.macroRecall).toBeGreaterThanOrEqual(REQMAP_EVAL_THRESHOLDS.macroRecall);
    expect(aggregate.macroF1).toBeGreaterThanOrEqual(REQMAP_EVAL_THRESHOLDS.macroF1);
  });

  it("the derived prediction anchors on the requirement's own files (not hardcoded)", async () => {
    const f = await fixture();
    // PR-101 is the tiered-fee change; the mapper must surface the fee file.
    const feeCase = f.cases.find((c) => c.id === "PR-101")!;
    const predicted = await predictAffectedFiles(f, feeCase);
    expect(predicted).toContain("payments/fee-calculator.ts");
    // Blast radius recovers the upstream checkout caller via the declared edge.
    expect(predicted).toContain("checkout/checkout-handler.ts");
  });

  it("the threshold is MEANINGFUL — a floor above the measured score would fail", async () => {
    const f = await fixture();
    const { aggregate } = await runReqMapEval(f);
    // Sanity guard: pushing every floor just above the measured macroF1 must
    // flip the gate red, proving the assertion is not a vacuous `>= 0`.
    const tooHigh = {
      macroF1: aggregate.macroF1 + 0.01,
      macroRecall: aggregate.macroRecall,
      microF1: aggregate.microF1,
      hitRate: aggregate.hitRate,
    };
    expect(checkThresholds(aggregate, tooHigh).passed).toBe(false);
    // And the configured floors are strictly positive (never a no-op gate).
    expect(REQMAP_EVAL_THRESHOLDS.macroF1).toBeGreaterThan(0);
    expect(REQMAP_EVAL_THRESHOLDS.macroF1).toBeLessThanOrEqual(aggregate.macroF1);
  });
});
