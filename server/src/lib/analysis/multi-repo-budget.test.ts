/**
 * Issue #741 (Epic #727) — PURE multi-repo budget-cap logic.
 *
 * `capConnectorsForBudget` is the exact decision the initial agentic run uses to
 * truncate the repo list when the per-repo token budget falls below the floor
 * (previously an inline, silently-dropping `connectors.slice`), and the resume
 * endpoint reuses it to re-cap its own skipped set (the loop guard). Testing it
 * directly proves the cap decision + the surfaced skipped list without standing
 * up the whole pipeline.
 */
import { describe, expect, it } from "vitest";
import { capConnectorsForBudget } from "./orchestrator.js";

const TOTAL = 100_000;

function conns(...ids: string[]) {
  return ids.map((id) => ({ id, label: `repo-${id}` }));
}

describe("capConnectorsForBudget", () => {
  it("keeps every connector when the even split clears the floor", () => {
    const { effectiveConnectors, effectiveBudget, skipped } = capConnectorsForBudget(
      conns("a", "b"),
      TOTAL,
    );
    // 100k / 2 = 50k == floor → all run.
    expect(effectiveConnectors.map((c) => c.id)).toEqual(["a", "b"]);
    expect(effectiveBudget).toBe(50_000);
    expect(skipped).toEqual([]);
  });

  it("caps the repo count and returns the dropped connectors when below the floor", () => {
    const { effectiveConnectors, effectiveBudget, skipped } = capConnectorsForBudget(
      conns("a", "b", "c", "d"),
      TOTAL,
    );
    // 100k / 4 = 25k < 50k → maxRepos = floor(100k/50k) = 2.
    expect(effectiveConnectors.map((c) => c.id)).toEqual(["a", "b"]);
    // Survivors re-split the full budget: 100k / 2 = 50k.
    expect(effectiveBudget).toBe(50_000);
    // The dropped connectors are surfaced (not silently sliced away).
    expect(skipped.map((c) => c.id)).toEqual(["c", "d"]);
  });

  it("re-caps a resume set of 3 down to 2 (loop guard leaves 1 remaining)", () => {
    const { effectiveConnectors, skipped } = capConnectorsForBudget(conns("c", "d", "e"), TOTAL);
    expect(effectiveConnectors.map((c) => c.id)).toEqual(["c", "d"]);
    expect(skipped.map((c) => c.id)).toEqual(["e"]);
  });

  it("always runs at least one repo even when a single repo can't clear the floor", () => {
    // A tiny total budget: even one repo is under the floor, but we never drop
    // the last repo — it gets the whole (small) budget.
    const { effectiveConnectors, effectiveBudget, skipped } = capConnectorsForBudget(
      conns("solo"),
      10_000,
    );
    expect(effectiveConnectors.map((c) => c.id)).toEqual(["solo"]);
    expect(effectiveBudget).toBe(10_000);
    expect(skipped).toEqual([]);
  });

  it("preserves the caller's minPerRepo override", () => {
    // Floor lowered to 20k → 100k/4 = 25k clears it, nothing skipped.
    const { skipped } = capConnectorsForBudget(conns("a", "b", "c", "d"), TOTAL, 20_000);
    expect(skipped).toEqual([]);
  });

  it("is a no-op for an empty connector list", () => {
    const { effectiveConnectors, skipped } = capConnectorsForBudget([], TOTAL);
    expect(effectiveConnectors).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
