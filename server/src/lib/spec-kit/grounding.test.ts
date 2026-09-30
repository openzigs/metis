/**
 * #20 — deterministic grounding helpers for `/specify`, `/plan` and `/tasks`.
 */
import { describe, expect, it, vi } from "vitest";
import {
  describeGrounding,
  extractReferencedPaths,
  extractRequirementText,
  findTestsAfterImplementation,
  verifyPlanPaths,
  type PlanPathLookup,
} from "./grounding.js";

describe("extractRequirementText", () => {
  const spec = [
    "# Spec",
    "Recover malformed tool-call markup in the analysis agent loop.",
    "",
    "## Stakeholders",
    "- Platform engineers",
    "",
    "## In scope",
    "- Repair unbalanced JSON arguments",
    "",
    "## Out of scope",
    "- Rewriting the provider layer",
    "",
    "## Acceptance criteria",
    "- **AC-1**: repaired call",
    "  - **Given** a truncated tool call",
    "",
    "## Non-functional requirements",
    "- p95 under 5 ms",
  ].join("\n");

  it("keeps the summary, in-scope items and acceptance criteria", () => {
    const q = extractRequirementText(spec);
    expect(q).toContain("Recover malformed tool-call markup");
    expect(q).toContain("Repair unbalanced JSON arguments");
    expect(q).toContain("AC-1");
    expect(q).toContain("a truncated tool call");
  });

  it("drops headings, stakeholders, exclusions and NFRs so they cannot steer retrieval", () => {
    const q = extractRequirementText(spec);
    expect(q).not.toContain("## ");
    expect(q).not.toContain("Platform engineers");
    expect(q).not.toContain("Rewriting the provider layer");
    expect(q).not.toContain("p95 under 5 ms");
  });

  it("strips Markdown emphasis markers", () => {
    expect(extractRequirementText(spec)).not.toContain("**");
  });

  it("recognises closed ATX headings", () => {
    expect(extractRequirementText("## Out of scope ##\n- no\n## In scope\n- yes")).toBe("- yes");
  });

  it("falls back to the trimmed input when nothing survives the filter", () => {
    expect(extractRequirementText("## Stakeholders\n- ops\n")).toBe("## Stakeholders\n- ops");
  });
});

describe("extractReferencedPaths", () => {
  it("returns backticked repo paths, stripping line and symbol suffixes", () => {
    const md = [
      "Extend `server/src/lib/analysis/agent-loop.ts:1030-1088` rather than adding a class.",
      "The effect lives in `ui/src/app/(authed)/workbench/page.tsx`.",
      "See `server/src/lib/x.ts::parseToolCall` and `./docs/ARCHITECTURE.md`.",
    ].join("\n");
    expect(extractReferencedPaths(md)).toEqual([
      "server/src/lib/analysis/agent-loop.ts",
      "ui/src/app/(authed)/workbench/page.tsx",
      "server/src/lib/x.ts",
      "docs/ARCHITECTURE.md",
    ]);
  });

  it("ignores identifiers, bare filenames, URLs and code with spaces", () => {
    const md =
      "`parseToolCall` `plan.md` `a/b` `https://x.io/a.ts` `const a = b/c.d` `AC-1` `x/y.ts`";
    expect(extractReferencedPaths(md)).toEqual(["x/y.ts"]);
  });

  it("skips spans longer than a path can be", () => {
    const long = `${"a/".repeat(150)}x.ts`;
    expect(extractReferencedPaths(`\`${long}\` and \`ok/y.ts\``)).toEqual(["ok/y.ts"]);
  });

  it("stops at 50 paths", () => {
    const md = Array.from({ length: 60 }, (_, i) => `\`d/f${i}.ts\``).join(" ");
    expect(extractReferencedPaths(md)).toHaveLength(50);
  });

  it("deduplicates repeated references", () => {
    expect(extractReferencedPaths("`a/b.ts` then `a/b.ts:4` again")).toEqual(["a/b.ts"]);
  });
});

function lookup(opts: { graph: boolean; stored: string[] }): PlanPathLookup & {
  findExisting: ReturnType<typeof vi.fn>;
} {
  return {
    hasCodeGraph: vi.fn().mockResolvedValue(opts.graph),
    findExisting: vi.fn().mockResolvedValue(opts.stored),
  };
}

describe("verifyPlanPaths", () => {
  it("flags backticked paths the code graph does not contain", async () => {
    const lk = lookup({ graph: true, stored: ["server/src/lib/analysis/agent-loop.ts"] });
    const r = await verifyPlanPaths(
      "p1",
      "Extend `server/src/lib/analysis/agent-loop.ts` and add `server/src/lib/new/Normalizer.ts`.",
      lk,
    );
    expect(r.checked).toBe(true);
    expect(r.referenced).toHaveLength(2);
    expect(r.unverified).toEqual(["server/src/lib/new/Normalizer.ts"]);
    expect(lk.findExisting).toHaveBeenCalledWith("p1", [
      "server/src/lib/analysis/agent-loop.ts",
      "server/src/lib/new/Normalizer.ts",
    ]);
  });

  it("accepts a path that matches a stored path by suffix in either direction", async () => {
    const lk = lookup({
      graph: true,
      stored: ["/repo/server/src/a/b.ts", "src/c/d.ts"],
    });
    const r = await verifyPlanPaths("p1", "`server/src/a/b.ts` and `server/src/c/d.ts`", lk);
    expect(r.unverified).toEqual([]);
  });

  it("does not accept a partial-segment suffix match", async () => {
    const lk = lookup({ graph: true, stored: ["server/xsrc/b.ts"] });
    const r = await verifyPlanPaths("p1", "`src/b.ts`", lk);
    expect(r.unverified).toEqual(["src/b.ts"]);
  });

  it("skips the check when the project has no code graph", async () => {
    const lk = lookup({ graph: false, stored: [] });
    const r = await verifyPlanPaths("p1", "`a/b.ts`", lk);
    expect(r).toEqual({ checked: false, referenced: ["a/b.ts"], unverified: [] });
    expect(lk.findExisting).not.toHaveBeenCalled();
  });

  // PR #419 review — naming no path is the #20 failure, so it is still checked.
  it("checks a plan that names no paths against the code graph, without a path query", async () => {
    const lk = lookup({ graph: true, stored: [] });
    const r = await verifyPlanPaths("p1", "no paths here", lk);
    expect(r).toEqual({ checked: true, referenced: [], unverified: [] });
    expect(lk.findExisting).not.toHaveBeenCalled();
  });

  it("leaves a no-path plan unchecked when the project has no code graph", async () => {
    const lk = lookup({ graph: false, stored: [] });
    const r = await verifyPlanPaths("p1", "no paths here", lk);
    expect(r.checked).toBe(false);
  });

  it("never throws when the lookup fails", async () => {
    const lk: PlanPathLookup = {
      hasCodeGraph: vi.fn().mockRejectedValue(new Error("db down")),
      findExisting: vi.fn(),
    };
    const r = await verifyPlanPaths("p1", "`a/b.ts`", lk);
    expect(r).toEqual({ checked: false, referenced: ["a/b.ts"], unverified: [] });
  });
});

describe("findTestsAfterImplementation", () => {
  it("flags a test task that follows the implementation task covering the same AC", () => {
    const md = [
      "## Tasks",
      "- [ ] T01 — Add JSON repair to parseToolCalls (satisfies: AC-1) depends-on: none",
      "- [ ] T02 — Add known-tools gate (satisfies: AC-2) depends-on: T01",
      "- [ ] T03 — Write unit tests for JSON repair (satisfies: AC-1) depends-on: T01",
    ].join("\n");
    expect(findTestsAfterImplementation(md)).toEqual(["T03"]);
  });

  it("accepts tests written first or alongside the implementation", () => {
    const md = [
      "- [ ] T01 — Write failing tests for JSON repair (satisfies: AC-1)",
      "- [ ] T02 — Implement JSON repair (satisfies: AC-1) depends-on: T01",
      "- [ ] T03 — Add known-tools gate with unit tests (satisfies: AC-2)",
      "- [ ] T04 — Add e2e tests for the gate (satisfies: AC-2) depends-on: T03",
    ].join("\n");
    expect(findTestsAfterImplementation(md)).toEqual([]);
  });

  it("ignores a late test task whose ACs no earlier implementation covered", () => {
    const md = [
      "- [ ] T01 — Implement repair (satisfies: AC-1)",
      "- [ ] T02 — Write regression tests (satisfies: AC-3)",
    ].join("\n");
    expect(findTestsAfterImplementation(md)).toEqual([]);
  });

  it("falls back to the checklist position when a task carries no T-id", () => {
    const md = ["- [ ] Implement repair (satisfies: AC-1)", "- [ ] Test repair (AC-1)"].join("\n");
    expect(findTestsAfterImplementation(md)).toEqual(["task 2"]);
  });
});

describe("describeGrounding", () => {
  it("reports document chunks and code symbols separately", () => {
    expect(describeGrounding({ usedChunks: 3, usedSymbols: 5 })).toBe(
      "grounded on 3 retrieved chunks and 5 code symbols",
    );
  });

  it("uses singular forms", () => {
    expect(describeGrounding({ usedChunks: 1, usedSymbols: 1 })).toBe(
      "grounded on 1 retrieved chunk and 1 code symbol",
    );
  });

  it("keeps the documents-only wording when no symbols were used", () => {
    expect(describeGrounding({ usedChunks: 8, usedSymbols: 0 })).toBe(
      "grounded on 8 retrieved chunks",
    );
  });

  it("reports code-only grounding", () => {
    expect(describeGrounding({ usedChunks: 0, usedSymbols: 2 })).toBe("grounded on 2 code symbols");
  });

  it("reports ungrounded when neither index contributed", () => {
    expect(describeGrounding({ usedChunks: 0, usedSymbols: 0 })).toBe(
      "ungrounded (no project knowledge retrieved)",
    );
  });
});
