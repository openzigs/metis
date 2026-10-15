/**
 * #1134 — which plan.md a derived artifact was generated from, and what a
 * re-planned design changed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  describeStale,
  findStaleArtifacts,
  isPlanDerivedArtifact,
  planSourceStamp,
  readPlanSource,
  stampPlanSource,
  stalenessAgainstPlan,
} from "../src/lib/spec-kit/plan-provenance.js";
import {
  describePlanDesignDiff,
  diffPlanDesign,
  previousPlanSection,
} from "../src/lib/spec-kit/plan-diff.js";

const at = (iso: string) => new Date(iso).toISOString();

describe("plan provenance stamp", () => {
  it("stamps once, replacing any earlier stamp, and reads the last one back", () => {
    const once = stampPlanSource("## Tasks\n- [ ] T01", 1);
    expect(once).toBe(`## Tasks\n- [ ] T01\n\n${planSourceStamp(1)}\n`);
    expect(readPlanSource(once)).toBe(1);
    const twice = stampPlanSource(`${once}\nmore`, 3);
    expect(twice.match(/generated from plan\.md/g)).toHaveLength(1);
    expect(readPlanSource(twice)).toBe(3);
  });

  it("a null plan version strips the stamp and adds none", () => {
    const out = stampPlanSource(stampPlanSource("body", 2), null);
    expect(out).toBe("body\n");
    expect(readPlanSource(out)).toBeNull();
  });

  it("knows which artifacts are generated from the plan", () => {
    expect(isPlanDerivedArtifact("tasks.md")).toBe(true);
    expect(isPlanDerivedArtifact("analysis.md")).toBe(true);
    expect(isPlanDerivedArtifact("checklist-security.md")).toBe(true);
    expect(isPlanDerivedArtifact("plan.md")).toBe(false);
    expect(isPlanDerivedArtifact("data-model.md")).toBe(false);
    expect(isPlanDerivedArtifact("plan-context.md")).toBe(false);
  });
});

describe("staleness against plan.md", () => {
  const plan = {
    key: "plan.md",
    content: "# Plan",
    version: 2,
    updatedAt: at("2026-10-13T10:00:00Z"),
  };

  it("marks a stamped artifact from an earlier plan version, naming that version", () => {
    const tasks = {
      key: "tasks.md",
      content: stampPlanSource("x", 1),
      version: 1,
      // Written AFTER the plan by time: the stamp, not the clock, decides.
      updatedAt: at("2026-10-13T11:00:00Z"),
    };
    expect(findStaleArtifacts([plan, tasks])).toEqual([
      { key: "tasks.md", planVersion: 1, currentPlanVersion: 2 },
    ]);
  });

  it("does not mark an artifact stamped with the current plan version", () => {
    const tasks = {
      key: "tasks.md",
      content: stampPlanSource("x", 2),
      version: 1,
      updatedAt: at("2026-10-13T09:00:00Z"),
    };
    expect(findStaleArtifacts([plan, tasks])).toEqual([]);
  });

  it("falls back to time for an unstamped artifact", () => {
    const older = {
      key: "analysis.md",
      content: "r",
      version: 1,
      updatedAt: at("2026-10-13T09:00:00Z"),
    };
    const newer = {
      key: "checklist-ux.md",
      content: "c",
      version: 1,
      updatedAt: at("2026-10-13T11:00:00Z"),
    };
    expect(findStaleArtifacts([plan, older, newer])).toEqual([
      { key: "analysis.md", planVersion: null, currentPlanVersion: 2 },
    ]);
  });

  it("nothing is stale without a plan, and non-derived artifacts are never stale", () => {
    expect(
      stalenessAgainstPlan(
        "tasks.md",
        { content: stampPlanSource("x", 1), version: 1, updatedAt: at("2026-01-01") },
        null,
      ),
    ).toBeNull();
    const research = { key: "research.md", content: "r", version: 1, updatedAt: at("2020-01-01") };
    expect(findStaleArtifacts([plan, research])).toEqual([]);
  });

  it("treats a stamp newer than plan.md as stale (plan deleted and recreated)", () => {
    const tasks = {
      content: stampPlanSource("x", 3),
      version: 1,
      updatedAt: at("2026-10-13T11:00:00Z"),
    };
    expect(stalenessAgainstPlan("tasks.md", tasks, { ...plan, version: 1 })).toEqual({
      key: "tasks.md",
      planVersion: 3,
      currentPlanVersion: 1,
    });
  });

  it("describes both kinds", () => {
    expect(describeStale({ key: "tasks.md", planVersion: 1, currentPlanVersion: 2 })).toBe(
      "tasks.md was generated from plan.md v1; plan.md is now v2",
    );
    expect(describeStale({ key: "tasks.md", planVersion: null, currentPlanVersion: 2 })).toBe(
      "tasks.md was generated before plan.md v2; plan.md is now v2",
    );
  });
});

// The run 8 pair (#1134): an unchanged spec re-planned onto another endpoint,
// another handler file and without the storage wrapper.
const PLAN_V1 = [
  "## Components",
  "- `PUT /v1/entries/mark-all-as-read` in `internal/api/entry_handlers.go` **Extends**",
  "- new `MarkAllAsReadBeforeDays` wrapper in `internal/storage/entry.go`",
].join("\n");
const PLAN_V2 = [
  "## Components",
  "- `PUT /v1/users/{userID}/mark-all-as-read-older-than-days` in `internal/api/user_handlers.go`",
  "- calls `store.MarkAllAsRead()` directly; column `read_at` and `true` are not functions",
].join("\n");

describe("plan design diff", () => {
  it("reports the endpoint, file and function changes", () => {
    const diff = diffPlanDesign(PLAN_V1, PLAN_V2);
    expect(diff.endpoints).toEqual({
      added: ["PUT /v1/users/{userID}/mark-all-as-read-older-than-days"],
      removed: ["PUT /v1/entries/mark-all-as-read"],
    });
    expect(diff.files).toEqual({
      added: ["internal/api/user_handlers.go"],
      removed: ["internal/api/entry_handlers.go", "internal/storage/entry.go"],
    });
    expect(diff.functions).toEqual({
      added: ["store.MarkAllAsRead"],
      removed: ["MarkAllAsReadBeforeDays"],
    });
    const text = describePlanDesignDiff(1, diff);
    expect(text).toContain("Compared with plan.md v1:");
    expect(text).toContain(
      "endpoints differ (added `PUT /v1/users/{userID}/mark-all-as-read-older-than-days`; removed `PUT /v1/entries/mark-all-as-read`)",
    );
    expect(text).toContain(
      "functions differ (added `store.MarkAllAsRead`; removed `MarkAllAsReadBeforeDays`)",
    );
    expect(text).toContain("out of date");
  });

  it("says when the design is the same", () => {
    expect(describePlanDesignDiff(4, diffPlanDesign(PLAN_V1, `${PLAN_V1}\n\nmore prose`))).toBe(
      " Compared with plan.md v4: the same endpoints, files and functions.",
    );
  });

  it("caps a long list", () => {
    const many = Array.from({ length: 8 }, (_, i) => `- \`doThing${i}()\``).join("\n");
    const text = describePlanDesignDiff(1, diffPlanDesign("", many));
    expect(text).toContain("and 3 more");
  });

  // The real run 8 plans (.playwright-mcp/walkthrough-706-run8/wave-d): v1
  // extends entry_handlers.go, v2 user_handlers.go, but each plan cites both.
  it("reports the handler move between the real run 8 plans, not their grounding citations", () => {
    const fixture = (name: string) =>
      readFileSync(new URL(`./fixtures/plan-diff/${name}`, import.meta.url), "utf8");
    const diff = diffPlanDesign(fixture("run8-plan-v1.md"), fixture("run8-plan-v2.md"));
    expect(diff.files).toEqual({
      added: ["internal/api/user_handlers.go"],
      removed: ["internal/api/entry_handlers.go"],
    });
    expect(diff.functions.removed[0]).toBe("MarkAllAsReadBeforeDays");
    const text = describePlanDesignDiff(1, diff);
    expect(text).toContain(
      "files differ (added `internal/api/user_handlers.go`; removed `internal/api/entry_handlers.go`)",
    );
    expect(text).toContain("removed `MarkAllAsReadBeforeDays`");
  });

  it("does not count a component declared unchanged as a proposed file", () => {
    const plan = (file: string, kept: string) =>
      [
        "## Components",
        `- **Handler** — **Extends** \`${file}\` (\`markThingHandler\`)`,
        `- **Storage** *(reused, unchanged)* — **Extends** \`${kept}\``,
        "## Risks",
        "- cites \`internal/other/file.go\`",
      ].join("\n");
    const diff = diffPlanDesign(
      plan("internal/api/a.go", "internal/storage/x.go"),
      plan("internal/api/b.go", "internal/storage/y.go"),
    );
    expect(diff.files).toEqual({ added: ["internal/api/b.go"], removed: ["internal/api/a.go"] });
  });

  it("hands the previous plan over as the starting point", () => {
    const section = previousPlanSection({ content: PLAN_V1, version: 1 });
    expect(section).toContain("Previous plan.md (v1) — the starting point");
    expect(section).toContain(PLAN_V1);
  });

  it("fences a plan that itself holds fenced blocks with a longer fence", () => {
    const plan = "## Flow\n```mermaid\ngraph TD\n```\nend";
    const section = previousPlanSection({ content: plan, version: 2 });
    expect(section).toContain(`\n\`\`\`\`md\n${plan}\n\`\`\`\`\n`.trimEnd());
    expect(section.endsWith("````")).toBe(true);
  });
});
