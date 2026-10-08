import { describe, expect, it } from "vitest";

import {
  TEST_PLAN_PATH,
  WAIVER_LABEL,
  evaluateWalkthroughPlanGate,
  isDocsPath,
  isPagePath,
  isRouteSourcePath,
  parseNameStatus,
  routeLineChanges,
} from "./walkthrough-plan-gate-core.mjs";

describe("path classes", () => {
  it("recognises pages, route sources and docs", () => {
    expect(isPagePath("ui/src/app/(authed)/projects/[id]/page.tsx")).toBe(true);
    expect(isPagePath("ui/src/app/page.tsx")).toBe(true);
    expect(isPagePath("ui/src/app/(authed)/projects/[id]/layout.tsx")).toBe(false);
    expect(isPagePath("ui/src/components/page.tsx")).toBe(false);
    expect(isRouteSourcePath("server/src/routes/admin/index.ts")).toBe(true);
    expect(isRouteSourcePath("server/src/routes/hooks.test.ts")).toBe(false);
    expect(isRouteSourcePath("server/src/lib/x.ts")).toBe(false);
    expect(isDocsPath("docs/x.txt")).toBe(true);
    expect(isDocsPath(".changes/unreleased/1-x.md")).toBe(true);
    expect(isDocsPath("README.MD")).toBe(true);
    expect(isDocsPath("ui/src/app/page.tsx")).toBe(false);
  });
});

describe("parseNameStatus", () => {
  it("reads plain and rename lines", () => {
    expect(parseNameStatus("A\tui/src/app/x/page.tsx\nR087\told.ts\tnew.ts\n\nM\ta.md\n")).toEqual([
      { status: "A", path: "ui/src/app/x/page.tsx" },
      { status: "R", path: "new.ts", from: "old.ts" },
      { status: "M", path: "a.md" },
    ]);
  });
});

describe("routeLineChanges", () => {
  const diff = [
    "diff --git a/server/src/routes/projects.ts b/server/src/routes/projects.ts",
    "--- a/server/src/routes/projects.ts",
    "+++ b/server/src/routes/projects.ts",
    "@@ -10 +10 @@",
    '-  r.get("/:id/old", h);',
    '+  r.get("/:id/new", h);',
    "+  r.post(",
    '+    "/:id/multi",',
    "+  const x = compute();",
    '+  r.use("/sub", subRouter());',
    "diff --git a/server/src/routes/gone.ts b/server/src/routes/gone.ts",
    "--- a/server/src/routes/gone.ts",
    "+++ /dev/null",
    '-  r.delete("/x", h);',
    "diff --git a/server/src/routes/a.test.ts b/server/src/routes/a.test.ts",
    "--- a/server/src/routes/a.test.ts",
    "+++ b/server/src/routes/a.test.ts",
    '+  await request(app).get("/api/x");',
  ].join("\n");

  it("lists added and removed registrations, mounts and multi-line paths, not tests", () => {
    expect(routeLineChanges(diff)).toEqual([
      { file: "server/src/routes/projects.ts", sign: "-", line: 'r.get("/:id/old", h);' },
      { file: "server/src/routes/projects.ts", sign: "+", line: 'r.get("/:id/new", h);' },
      { file: "server/src/routes/projects.ts", sign: "+", line: '"/:id/multi",' },
      { file: "server/src/routes/projects.ts", sign: "+", line: 'r.use("/sub", subRouter());' },
      { file: "server/src/routes/gone.ts", sign: "-", line: 'r.delete("/x", h);' },
    ]);
  });

  it("ignores lines before any file header", () => {
    expect(routeLineChanges('+  r.get("/x", h);')).toEqual([]);
  });
});

describe("evaluateWalkthroughPlanGate", () => {
  const route = [
    { file: "server/src/routes/x.ts", sign: /** @type {"+"} */ ("+"), line: 'r.get("/y")' },
  ];
  const base = {
    changes: [{ status: "M", path: "server/src/routes/x.ts" }],
    routeChanges: route,
    labels: [],
    author: "someone",
  };

  it("fails a route change with no plan update and no label", () => {
    const result = evaluateWalkthroughPlanGate(base);
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe("missing");
    expect(result.triggers).toEqual(['route added in server/src/routes/x.ts: r.get("/y")']);
  });

  it("passes when the plan changed", () => {
    const result = evaluateWalkthroughPlanGate({
      ...base,
      changes: [...base.changes, { status: "M", path: TEST_PLAN_PATH }],
    });
    expect(result).toMatchObject({ ok: true, verdict: "plan-updated" });
  });

  it("passes with the waiver label, and only that label", () => {
    expect(evaluateWalkthroughPlanGate({ ...base, labels: [WAIVER_LABEL] })).toMatchObject({
      ok: true,
      verdict: "label",
    });
    expect(evaluateWalkthroughPlanGate({ ...base, labels: ["documentation"] }).ok).toBe(false);
  });

  it("exempts dependabot", () => {
    expect(evaluateWalkthroughPlanGate({ ...base, author: "dependabot[bot]" })).toMatchObject({
      ok: true,
      verdict: "exempt-author",
    });
  });

  it("exempts a docs-only change", () => {
    expect(
      evaluateWalkthroughPlanGate({
        changes: [{ status: "A", path: "docs/a.md" }],
        routeChanges: [],
        labels: [],
        author: null,
      }),
    ).toMatchObject({ ok: true, verdict: "exempt-docs" });
  });

  it("triggers on a page added, removed or moved, but not edited", () => {
    const run = (/** @type {{ status: string, path: string, from?: string }} */ change) =>
      evaluateWalkthroughPlanGate({
        changes: [change],
        routeChanges: [],
        labels: [],
        author: null,
      });
    expect(run({ status: "A", path: "ui/src/app/a/page.tsx" }).triggers).toEqual([
      "page added: ui/src/app/a/page.tsx",
    ]);
    expect(run({ status: "D", path: "ui/src/app/a/page.tsx" }).triggers).toEqual([
      "page removed: ui/src/app/a/page.tsx",
    ]);
    expect(
      run({ status: "R", path: "ui/src/app/b/page.tsx", from: "ui/src/app/a/page.tsx" }).ok,
    ).toBe(false);
    expect(
      run({ status: "R", path: "ui/src/app/b/view.tsx", from: "ui/src/app/a/page.tsx" }).ok,
    ).toBe(false);
    expect(run({ status: "M", path: "ui/src/app/a/page.tsx" })).toMatchObject({
      ok: true,
      verdict: "not-required",
    });
  });

  it("is not required when nothing triggers", () => {
    expect(
      evaluateWalkthroughPlanGate({ changes: [], routeChanges: [], labels: [], author: null }),
    ).toMatchObject({ ok: true, verdict: "not-required", triggers: [] });
  });
});
