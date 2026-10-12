/**
 * #1060 — the files a plan was given are recorded beside the plan.
 *
 * In #706 run 7 three plans said `internal/storage`,
 * `internal/database/migrations.go` and `entry_query_builder.go` were not in
 * the retrieved context. Nothing recorded what the plans had been given, so the
 * sentence could be neither confirmed nor refuted. `plan-context.md` is that
 * record: a reader opens it and looks.
 */
import { describe, expect, it } from "vitest";
import {
  METIS_INTERNAL_FEATURE_ARTIFACTS,
  PLAN_CONTEXT_ARTIFACT,
  describeContextDropped,
  renderPlanContext,
} from "./grounding.js";

describe("describeContextDropped", () => {
  it("list what was left out, or count it and point at the artifact that lists it", () => {
    const dropped = ["Writers of `feeds`: 2 more", "Excerpts not shown: A"];
    expect(describeContextDropped(dropped)).toBe(
      " Left out of the plan's context (token budget, list cap or time limit): Writers of `feeds`: 2 more; Excerpts not shown: A.",
    );
    expect(describeContextDropped(dropped, "plan-context.md")).toBe(
      " Left out of the plan's context (token budget, list cap or time limit): 2 items, listed in `plan-context.md`.",
    );
    expect(describeContextDropped(dropped.slice(0, 1), "plan-context.md")).toBe(
      " Left out of the plan's context (token budget, list cap or time limit): 1 item, listed in `plan-context.md`.",
    );
    expect(describeContextDropped([], "plan-context.md")).toBe("");
  });
});

describe("renderPlanContext", () => {
  it("records the files given and what was left out, and says it is not the change list", () => {
    const text = renderPlanContext({
      usedChunks: 9,
      usedSymbols: 31,
      files: ["internal/storage/feed.go", "client/model.go"],
      dropped: ["Readers of `feeds`: 6 more readers not listed (in internal/storage/icon.go)"],
    });
    expect(PLAN_CONTEXT_ARTIFACT).toBe("plan-context.md");
    expect(text).toContain("# Plan context");
    expect(text).toContain("when it wrote the current `plan.md`");
    expect(text).toContain("NOT the list of files to change");
    expect(text).toContain("- Grounding: grounded on 9 retrieved chunks and 31 code symbols");
    expect(text).toContain("- Files named in the context: 2");
    expect(text).toContain("- `internal/storage/feed.go`\n- `client/model.go`");
    expect(text).toContain(
      "## Left out (token budget, list cap or time limit)\n\n- Readers of `feeds`: 6 more readers not listed",
    );
  });

  it("names the plan.md version it describes, so a record left from an earlier plan says so", () => {
    const text = renderPlanContext(
      { usedChunks: 1, usedSymbols: 1, files: ["a/b.go"], dropped: [] },
      { planVersion: 3 },
    );
    expect(text).toContain("What `/speckit.plan` was given when it wrote `plan.md` v3.");
    expect(text).toContain("If `plan.md` is at another version, this record was not rewritten");
    expect(text).not.toContain("the current `plan.md`");
  });

  it("says so when nothing was retrieved or nothing was left out", () => {
    const text = renderPlanContext({ usedChunks: 0, usedSymbols: 0, files: [], dropped: [] });
    expect(text).toContain("- Grounding: ungrounded (no project knowledge retrieved)");
    expect(text).toContain("## Files in the retrieved context\n\nNone.");
    expect(text).toContain("## Left out (token budget, list cap or time limit)\n\nNothing.");
  });

  it("is a METIS record, not a Spec Kit artifact", () => {
    expect([...METIS_INTERNAL_FEATURE_ARTIFACTS]).toEqual(["plan-context.md"]);
  });
});
