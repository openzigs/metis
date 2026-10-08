import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TEST_PLAN_PATH,
  WAIVER_LABEL,
  evaluateWalkthroughPlanGate,
  isDocsPath,
  isPagePath,
  isRouteSourcePath,
  netRouteChanges,
  parseNameStatus,
  routeKey,
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
    "@@ -1 +0,0 @@",
    '-  r.delete("/x", h);',
    "diff --git a/server/src/routes/a.test.ts b/server/src/routes/a.test.ts",
    "--- a/server/src/routes/a.test.ts",
    "+++ b/server/src/routes/a.test.ts",
    "@@ -1 +1 @@",
    '+  await request(app).get("/api/x");',
  ].join("\n");

  it("lists added and removed registrations, mounts and multi-line paths, not tests", () => {
    const P = "server/src/routes/projects.ts";
    expect(routeLineChanges(diff)).toEqual([
      { file: P, sign: "-", line: 'r.get("/:id/old", h);', key: "GET /:id/old" },
      { file: P, sign: "+", line: 'r.get("/:id/new", h);', key: "GET /:id/new" },
      { file: P, sign: "+", line: '"/:id/multi",', key: "POST /:id/multi" },
      { file: P, sign: "+", line: 'r.use("/sub", subRouter());', key: "USE /sub → subRouter" },
      {
        file: "server/src/routes/gone.ts",
        sign: "-",
        line: 'r.delete("/x", h);',
        key: "DELETE /x",
      },
    ]);
  });

  it("ignores lines before any file header", () => {
    expect(routeLineChanges('+  r.get("/x", h);')).toEqual([]);
  });

  it("reads file names only from the header block after `diff --git`", () => {
    // With -U0 a removed content line `-- x` arrives as `--- x`, and an added
    // `++ x` as `+++ x`. Neither may switch the current file.
    const tricky = [
      "diff --git a/server/src/routes/x.ts b/server/src/routes/x.ts",
      "index 1111111..2222222 100644",
      "--- a/server/src/routes/x.ts",
      "+++ b/server/src/routes/x.ts",
      "@@ -3,2 +3,2 @@",
      "--- docs/elsewhere.md",
      "+++ docs/elsewhere.md",
      '-  r.get("/old", h);',
      '+  r.get("/new", h);',
    ].join("\n");
    expect(routeLineChanges(tricky).map((c) => [c.file, c.key])).toEqual([
      ["server/src/routes/x.ts", "GET /old"],
      ["server/src/routes/x.ts", "GET /new"],
    ]);
  });

  it("names a removed file from its old side", () => {
    const removed = [
      "diff --git a/server/src/routes/gone.ts b/server/src/routes/gone.ts",
      "deleted file mode 100644",
      "--- a/server/src/routes/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      '-  r.get("/x", h);',
    ].join("\n");
    expect(routeLineChanges(removed)).toEqual([
      { file: "server/src/routes/gone.ts", sign: "-", line: 'r.get("/x", h);', key: "GET /x" },
    ]);
  });
});

describe("routeKey", () => {
  it("keys registrations by method and path, mounts by prefix and target", () => {
    expect(routeKey('r.get("/x", auth, h);', null)).toBe("GET /x");
    expect(routeKey('r.use("/x", auth, fooRouter());', null)).toBe("USE /x → fooRouter");
    expect(routeKey('r.use("/x", sub);', null)).toBe("USE /x → sub");
    expect(routeKey('r.use("/x",', null)).toBe("USE /x → ?");
    expect(routeKey('  "/x",', "PUT")).toBe("PUT /x");
    expect(routeKey("const a = 1;", null)).toBeNull();
  });

  it("counts a bare path line only after an open registration call", () => {
    expect(routeKey('  "/x",', null)).toBeNull();
    expect(routeKey('  "/:id/members/:memberId",', "PATCH")).toBe("PATCH /:id/members/:memberId");
  });

  it("does not read prose as a path, even after an open call", () => {
    expect(routeKey('  "/spec-kit/install is disabled until later",', "POST")).toBeNull();
  });

  it("ignores comment lines, including ones that quote a registration", () => {
    expect(routeKey('    // `r.use("/:id/:sub", …)` workspace-scope chokepoint', null)).toBeNull();
    expect(routeKey('   * r.get("/x", h);', null)).toBeNull();
    expect(routeKey('  /* r.post("/y", h) */', null)).toBeNull();
    expect(routeKey('  // "/x",', "POST")).toBeNull();
  });
});

describe("routeLineChanges on real diffs", () => {
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

  it("does not trigger on a one-word edit to a slash-leading error message (git diff -U0)", () => {
    const diff = fs.readFileSync(
      path.join(fixtures, "walkthrough-gate-error-message-edit.U0.diff"),
      "utf8",
    );
    // The fixture is the real thing: a changed string literal that starts with `/`.
    expect(diff).toMatch(/^-\s+"\/spec-kit\/install is disabled/m);
    expect(diff).toMatch(/^\+\s+"\/spec-kit\/install is unavailable/m);
    const changes = routeLineChanges(diff);
    expect(changes).toEqual([]);
    expect(
      evaluateWalkthroughPlanGate({
        changes: [{ status: "M", path: "server/src/routes/spec-kit.ts" }],
        routeChanges: changes,
        labels: [],
        author: "someone",
      }),
    ).toMatchObject({ ok: true, verdict: "not-required" });
  });

  it("does not trigger on an edited comment that quotes a registration", () => {
    const diff = [
      "diff --git a/server/src/routes/projects.ts b/server/src/routes/projects.ts",
      "--- a/server/src/routes/projects.ts",
      "+++ b/server/src/routes/projects.ts",
      "@@ -301 +301 @@",
      '-    // `r.use("/:id/:sub", …)` workspace-scope chokepoint above (which runs',
      '+    // `r.use("/:id/:sub", …)` workspace scope chokepoint above (which runs',
      '-    // r.get("/:id/old", h) used to live here',
    ].join("\n");
    expect(routeLineChanges(diff)).toEqual([]);
  });

  it("takes a changed path line's method from the open call on the context line before it (-U1)", () => {
    const diff = [
      "diff --git a/server/src/routes/workspaces.ts b/server/src/routes/workspaces.ts",
      "--- a/server/src/routes/workspaces.ts",
      "+++ b/server/src/routes/workspaces.ts",
      "@@ -211,2 +211,2 @@",
      "   r.post(",
      '-    "/:id/transfer",',
      '+    "/:id/handover",',
      "     requireAuth,",
    ].join("\n");
    expect(routeLineChanges(diff).map((c) => [c.sign, c.key])).toEqual([
      ["-", "POST /:id/transfer"],
      ["+", "POST /:id/handover"],
    ]);
  });

  it("does not take a method from a context line that is not an open call", () => {
    const diff = [
      "diff --git a/server/src/routes/x.ts b/server/src/routes/x.ts",
      "--- a/server/src/routes/x.ts",
      "+++ b/server/src/routes/x.ts",
      "@@ -10,2 +10,2 @@",
      "     throw new AppError(",
      '-      "/x",',
      '+      "/y",',
      "   // r.post(",
      '+    "/z",',
    ].join("\n");
    expect(routeLineChanges(diff)).toEqual([]);
  });
});

describe("netRouteChanges", () => {
  const F = "server/src/routes/x.ts";
  const c = (/** @type {"+" | "-"} */ sign, /** @type {string} */ key, line = key) => ({
    file: F,
    sign,
    line,
    key,
  });

  it("drops a registration edited in place: same method and path on both sides", () => {
    expect(
      netRouteChanges([
        c("-", "GET /x", 'r.get("/x", h)'),
        c("+", "GET /x", 'r.get("/x", auth, handler2)'),
        c("-", "USE /s → sub", 'r.use("/s", sub)'),
        c("+", "USE /s → sub", 'r.use("/s", limit, sub)'),
      ]),
    ).toEqual([]);
  });

  it("keeps a rename, a method change and a re-targeted mount", () => {
    const changes = [
      c("-", "GET /old"),
      c("+", "GET /new"),
      c("-", "GET /m"),
      c("+", "POST /m"),
      c("-", "USE /s → aRouter"),
      c("+", "USE /s → bRouter"),
    ];
    expect(netRouteChanges(changes)).toEqual(changes);
  });

  it("counts duplicates: removing one of two identical registrations still triggers", () => {
    expect(netRouteChanges([c("-", "GET /x"), c("-", "GET /x"), c("+", "GET /x")])).toEqual([
      c("-", "GET /x"),
    ]);
  });

  it("compares per file: a route moved between files triggers", () => {
    const moved = [
      { file: "server/src/routes/a.ts", sign: /** @type {"-"} */ ("-"), line: "x", key: "GET /x" },
      { file: "server/src/routes/b.ts", sign: /** @type {"+"} */ ("+"), line: "x", key: "GET /x" },
    ];
    expect(netRouteChanges(moved)).toEqual(moved);
  });
});

describe("evaluateWalkthroughPlanGate with an in-place edit", () => {
  it("does not trigger when only middleware or the handler changed", () => {
    const diff = [
      "diff --git a/server/src/routes/x.ts b/server/src/routes/x.ts",
      "--- a/server/src/routes/x.ts",
      "+++ b/server/src/routes/x.ts",
      "@@ -3 +3 @@",
      '-  r.get("/y", h);',
      '+  r.get("/y", requireAuth, renamedHandler);',
    ].join("\n");
    expect(
      evaluateWalkthroughPlanGate({
        changes: [{ status: "M", path: "server/src/routes/x.ts" }],
        routeChanges: routeLineChanges(diff),
        labels: [],
        author: "someone",
      }),
    ).toMatchObject({ ok: true, verdict: "not-required", triggers: [] });
  });
});

describe("evaluateWalkthroughPlanGate", () => {
  const route = [
    {
      file: "server/src/routes/x.ts",
      sign: /** @type {"+"} */ ("+"),
      line: 'r.get("/y")',
      key: "GET /y",
    },
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

  it("does not count another markdown file as the plan update", () => {
    const result = evaluateWalkthroughPlanGate({
      ...base,
      changes: [
        ...base.changes,
        { status: "A", path: ".changes/unreleased/x.md" },
        { status: "M", path: "docs/walkthroughs/RESULTS_TEMPLATE.md" },
        { status: "M", path: "docs/TEST_PLAN.md" },
      ],
    });
    expect(result).toMatchObject({ ok: false, verdict: "missing" });
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
