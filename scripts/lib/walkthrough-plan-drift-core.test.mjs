import { describe, expect, it } from "vitest";

import {
  classifyMountTarget,
  collectApiRoutes,
  expandAlternatives,
  extractPlanReferences,
  findPlanDrift,
  joinPath,
  pageSegments,
  parseImports,
  parseRouterChunk,
  referenceSegments,
  resolveSpecifier,
  routeSegments,
  segmentsMatch,
  segmentsPrefixMatch,
  splitTopLevel,
} from "./walkthrough-plan-drift-core.mjs";

/** @param {Record<string, string>} files */
const reader = (files) => (/** @type {string} */ file) => files[file] ?? null;

describe("joinPath", () => {
  it("joins with one slash and drops a trailing one", () => {
    expect(joinPath("/api", "/projects/")).toBe("/api/projects");
    expect(joinPath("", "/")).toBe("/");
    expect(joinPath("/api/x", "/")).toBe("/api/x");
  });
});

describe("parseImports", () => {
  it("maps local names, aliases and multi-line imports", () => {
    const imports = parseImports(
      [
        'import { a, b as c } from "./x.js";',
        "import {",
        "  type T,",
        "  d,",
        '} from "../y.js";',
      ].join("\n"),
    );
    expect(imports.get("a")).toEqual({ specifier: "./x.js", imported: "a" });
    expect(imports.get("c")).toEqual({ specifier: "./x.js", imported: "b" });
    expect(imports.get("d")).toEqual({ specifier: "../y.js", imported: "d" });
    expect(imports.get("T")).toEqual({ specifier: "../y.js", imported: "T" });
  });

  it("maps default imports, alone or before named ones", () => {
    const imports = parseImports(
      [
        'import cors from "cors";',
        'import express, { type Application } from "express";',
        'import local from "./local.js";',
      ].join("\n"),
    );
    expect(imports.get("cors")).toEqual({ specifier: "cors", imported: "default" });
    expect(imports.get("express")).toEqual({ specifier: "express", imported: "default" });
    expect(imports.get("Application")).toEqual({ specifier: "express", imported: "Application" });
    expect(imports.get("local")).toEqual({ specifier: "./local.js", imported: "default" });
  });
});

describe("splitTopLevel", () => {
  it("gives each column-0 declaration the text up to the next one", () => {
    const chunks = splitTopLevel(
      [
        "export function one() {",
        '  r.get("/a", h);',
        "}",
        "const two = () => {",
        '  r.get("/b", h);',
        "};",
        "export async function three() {}",
      ].join("\n"),
    );
    expect([...chunks.keys()]).toEqual(["one", "two", "three"]);
    expect(chunks.get("one")).toContain('"/a"');
    expect(chunks.get("one")).not.toContain('"/b"');
  });
});

describe("classifyMountTarget", () => {
  it("tells calls, members, identifiers and the rest apart", () => {
    expect(classifyMountTarget("fooRouter()")).toEqual({ kind: "call", name: "fooRouter" });
    expect(classifyMountTarget("analysis.projectScoped")).toEqual({
      kind: "member",
      object: "analysis",
      property: "projectScoped",
    });
    expect(classifyMountTarget("sub")).toEqual({ kind: "identifier", name: "sub" });
    expect(classifyMountTarget("express.json({ limit })")).toEqual({ kind: "other" });
  });
});

describe("parseRouterChunk", () => {
  it("finds single- and multi-line registrations and the last argument of a mount", () => {
    const { registrations, mounts } = parseRouterChunk(
      [
        'r.get("/a", h);',
        "r.post(",
        '  "/:id/b",',
        "  requireAuth,",
        ");",
        "r.get(`/t/${x}`, h);",
        'r.use("/m", limiter({ a: [1, 2] }, "x,y"), fooRouter({ q: (1) }));',
        'r.use("/:id/:sub", requireAuth, requireProjectAccess("id"));',
        "r.use(`/bad/${x}`, barRouter());",
      ].join("\n"),
    );
    expect(registrations).toEqual([
      { receiver: "r", method: "get", path: "/a" },
      { receiver: "r", method: "post", path: "/:id/b" },
    ]);
    expect(mounts).toEqual([
      { receiver: "r", prefix: "/m", target: { kind: "call", name: "fooRouter" }, waived: false },
      {
        receiver: "r",
        prefix: "/:id/:sub",
        target: { kind: "call", name: "requireProjectAccess" },
        waived: false,
      },
    ]);
  });

  it("marks a mount waived only by `drift-check: skip` on its own `.use(` line", () => {
    const { mounts } = parseRouterChunk(
      [
        'r.use("/a", lostRouter()); // drift-check: skip',
        "// drift-check: skip",
        'r.use("/b", lostRouter());',
      ].join("\n"),
    );
    expect(mounts.map((m) => [m.prefix, m.waived])).toEqual([
      ["/a", true],
      ["/b", false],
    ]);
  });

  it("skips a mount whose argument list never closes", () => {
    expect(parseRouterChunk('r.use("/m", fooRouter(').mounts).toEqual([]);
  });

  it("does not let a quoted bracket or escaped quote end an argument", () => {
    const { mounts } = parseRouterChunk('r.use("/m", f(")", "a\\"("), fooRouter());');
    expect(mounts[0].target).toEqual({ kind: "call", name: "fooRouter" });
  });
});

describe("resolveSpecifier", () => {
  it("maps a relative .js import to its .ts source", () => {
    expect(resolveSpecifier("server/src/app.ts", "./routes/index.js")).toBe(
      "server/src/routes/index.ts",
    );
    expect(resolveSpecifier("server/src/routes/admin/index.ts", "../usage.js")).toBe(
      "server/src/routes/usage.ts",
    );
    expect(resolveSpecifier("server/src/app.ts", "express")).toBeNull();
  });
});

describe("collectApiRoutes", () => {
  const files = {
    "app.ts": [
      'import { apiRouter } from "./routes/index.js";',
      "export function createApp() {",
      '  app.get("/healthz", h);',
      '  app.use("/api", apiRouter());',
      "}",
    ].join("\n"),
    "routes/index.ts": [
      'import { projectsRouter } from "./projects.js";',
      'import { initAnalysisRouter } from "./analysis.js";',
      'import { requireAuth } from "../middleware/auth.js";',
      'import { ghostRouter } from "./ghost.js";',
      "export function apiRouter() {",
      "  const analysis = initAnalysisRouter();",
      "  const $a = initAnalysisRouter();",
      '  r.use("/dollar", $a.topLevel);',
      '  r.use("/projects", requireAuth, projectsRouter());',
      '  r.use("/projects/:projectId/analyses", analysis.projectScoped);',
      '  r.use("/analyses", analysis.topLevel);',
      '  r.use("/gone", ghostRouter());',
      '  r.use("/lost", missing.thing);',
      '  r.use("/things", thingRoutes());',
      '  r.use("/local", localRouter());',
      "  return r;",
      "}",
      "function localRouter() {",
      '  r.delete("/x", h);',
      "}",
    ].join("\n"),
    "routes/projects.ts": [
      "export function projectsRouter() {",
      "  const r = Router();",
      "  const sub = Router();",
      '  r.get("/", h);',
      '  r.patch("/:id/budget", h);',
      '  sub.get("/inner", h);',
      '  r.use("/:id/nested", sub);',
      '  r.use("/:id/:sub", requireAuth);',
      "  return r;",
      "}",
    ].join("\n"),
    "routes/analysis.ts": [
      "export function initAnalysisRouter() {",
      "  const projectScoped = Router();",
      "  const topLevel = Router();",
      '  projectScoped.post("/", h);',
      '  topLevel.get("/:id", h);',
      "  return { projectScoped, topLevel };",
      "}",
    ].join("\n"),
  };

  it("joins mount prefixes to registrations across files, members and local sub-routers", () => {
    const { routes, unresolved } = collectApiRoutes({
      entryFile: "app.ts",
      readSource: reader(files),
    });
    const listed = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(listed).toEqual(
      [
        "delete /api/local/x",
        "get /api/analyses/:id",
        "get /api/dollar/:id",
        "get /api/projects",
        "get /api/projects/:id/nested/inner",
        "get /healthz",
        "patch /api/projects/:id/budget",
        "post /api/projects/:projectId/analyses",
      ].sort(),
    );
    expect(unresolved).toEqual([
      { file: "routes/index.ts", prefix: "/api/gone", target: "ghostRouter" },
      { file: "routes/index.ts", prefix: "/api/lost", target: "missing.thing" },
      // Reported whatever it is called: a lost router need not end in "Router".
      { file: "routes/index.ts", prefix: "/api/things", target: "thingRoutes" },
    ]);
  });

  it("treats a call into a package import as middleware, but still reports a lost relative one", () => {
    const app = {
      "app.ts": [
        'import cors from "cors";',
        'import { rateLimit } from "express-rate-limit";',
        'import { lostRouter } from "./routes/lost.js";',
        "export function createApp() {",
        '  app.get("/healthz", h);',
        '  app.use("/api/public", cors({ origin: "*" }));',
        '  app.use("/api/limited", rateLimit({ max: 5 }));',
        '  app.use("/api/lost", lostRouter());',
        "}",
      ].join("\n"),
    };
    const { routes, unresolved } = collectApiRoutes({
      entryFile: "app.ts",
      readSource: reader(app),
    });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["get /healthz"]);
    expect(unresolved).toEqual([{ file: "app.ts", prefix: "/api/lost", target: "lostRouter" }]);
  });

  it("lets `drift-check: skip` on the mount's line waive an unfollowable mount", () => {
    const app = {
      "app.ts": [
        'import { lostRouter } from "./routes/lost.js";',
        "export function createApp() {",
        "  const lost = lostRouter();",
        '  app.use("/api/lost", lostRouter()); // drift-check: skip',
        '  app.use("/api/member", lost.inner); // drift-check: skip',
        '  app.use("/api/still", lostRouter());',
        "}",
      ].join("\n"),
    };
    const { unresolved } = collectApiRoutes({ entryFile: "app.ts", readSource: reader(app) });
    expect(unresolved).toEqual([{ file: "app.ts", prefix: "/api/still", target: "lostRouter" }]);
  });

  it("returns nothing for a missing entry file", () => {
    expect(collectApiRoutes({ entryFile: "nope.ts", readSource: reader(files) })).toEqual({
      routes: [],
      unresolved: [],
    });
  });

  it("stops on a mount cycle instead of recursing forever", () => {
    const cyclic = {
      "a.ts": [
        "export function loopRouter() {",
        '  r.get("/x", h);',
        '  r.use("/again", loopRouter());',
        "}",
      ].join("\n"),
    };
    const { routes } = collectApiRoutes({ entryFile: "a.ts", readSource: reader(cyclic) });
    expect(routes.length).toBeGreaterThan(1);
    expect(routes.length).toBeLessThan(20);
  });
});

describe("segments", () => {
  it("parses Express placeholders, optional params and splats", () => {
    expect(routeSegments("/a/:id/:opt?/{:o2}/*key")).toEqual([
      { kind: "literal", value: "a" },
      { kind: "param" },
      { kind: "optional" },
      { kind: "optional" },
      { kind: "rest", min: 1 },
    ]);
    expect(routeSegments("/x/{*rest}")[1]).toEqual({ kind: "rest", min: 1 });
  });

  it("parses every placeholder form the plan writes", () => {
    expect(referenceSegments("/a/:id/<token>/{x}/[y]/*key/b")).toEqual([
      { kind: "literal", value: "a" },
      { kind: "param" },
      { kind: "param" },
      { kind: "param" },
      { kind: "param" },
      { kind: "rest", min: 1 },
      { kind: "literal", value: "b" },
    ]);
  });

  it("parses Next.js page files, dropping groups and slots", () => {
    expect(pageSegments("(authed)/projects/[id]/@modal/settings/page.tsx")).toEqual([
      { kind: "literal", value: "projects" },
      { kind: "param" },
      { kind: "literal", value: "settings" },
    ]);
    expect(pageSegments("(authed)/admin/[[...slug]]/page.tsx")[1]).toEqual({
      kind: "rest",
      min: 0,
    });
    expect(pageSegments("docs/[...slug]/page.tsx")[1]).toEqual({ kind: "rest", min: 1 });
    expect(pageSegments("page.tsx")).toEqual([]);
  });
});

describe("segmentsMatch", () => {
  const m = (/** @type {string} */ ref, /** @type {string} */ route) =>
    segmentsMatch(referenceSegments(ref), routeSegments(route));

  it("matches literals exactly and a reference placeholder only to a route placeholder", () => {
    expect(m("/api/projects/:id", "/api/projects/:projectId")).toBe(true);
    expect(m("/api/admin/config/MODEL_PRICES", "/api/admin/config/:key")).toBe(true);
    expect(m("/api/spec-kit/:x", "/api/spec-kit/install")).toBe(false);
    expect(m("/api/projects", "/api/projectz")).toBe(false);
    expect(m("/api/projects/:id", "/api/projects")).toBe(false);
    expect(m("/api/projects", "/api/projects/:id")).toBe(false);
  });

  it("handles optional params and splats", () => {
    expect(m("/a", "/a/:opt?")).toBe(true);
    expect(m("/a/b", "/a/:opt?")).toBe(true);
    expect(m("/a/b/c", "/a/:opt?")).toBe(false);
    expect(m("/a/*key", "/a/:opt?")).toBe(false);
    expect(m("/f/x/artifacts/*key", "/f/:slug/artifacts/*key")).toBe(true);
    expect(m("/f/x/artifacts/a/b", "/f/:slug/artifacts/*key")).toBe(true);
    expect(m("/f/x/artifacts", "/f/:slug/artifacts/*key")).toBe(false);
    expect(m("/f/*key", "/f/:id")).toBe(false);
    expect(
      segmentsMatch(referenceSegments("/admin"), pageSegments("admin/[[...slug]]/page.tsx")),
    ).toBe(true);
  });

  it("matches a prefix only through segmentsPrefixMatch", () => {
    expect(segmentsPrefixMatch(referenceSegments("/api/x"), routeSegments("/api/x/:id/y"))).toBe(
      true,
    );
    expect(segmentsPrefixMatch(referenceSegments("/api/z"), routeSegments("/api/x/:id/y"))).toBe(
      false,
    );
  });
});

describe("expandAlternatives", () => {
  it("expands pipe-separated segment alternatives", () => {
    expect(expandAlternatives("/api/s/:id/resume|fork")).toEqual([
      "/api/s/:id/resume",
      "/api/s/:id/fork",
    ]);
    expect(expandAlternatives("/")).toEqual(["/"]);
  });
});

describe("extractPlanReferences", () => {
  it("reads an ellipsis path as a suffix reference, and prose ellipses as nothing", () => {
    const refs = extractPlanReferences(
      [
        "Then `POST …/documents/url` and `…/drift/count` and `GET/POST .../clarify?x=1`.",
        "Header `Link: <…/commands/speckit.specify>; rel=x` and `PUT …/enabled {enabled:true}`.",
        "Not `fetch('/api/...')`, `server/src/routes/…`, `/api/…` or `Cannot /implement: missing …`.",
      ].join("\n"),
    );
    expect(refs.map((r) => [r.line, r.kind, r.methods.join("/"), r.path, r.suffix])).toEqual([
      [1, "api", "post", "/documents/url", true],
      [1, "api", "", "/drift/count", true],
      [1, "api", "get/post", "/clarify", true],
      [2, "api", "", "/commands/speckit.specify", true],
      [2, "api", "put", "/enabled", true],
    ]);
  });

  it("reads API and page spans, skipping fences, URLs, ellipses, files and marked lines", () => {
    const refs = extractPlanReferences(
      [
        "Open `/projects/:id/settings?tab=x`, then `POST /api/projects/:id/analyses {a}`.",
        "Also `GET/PUT /api/x/:id` and `/api/ai/sessions/:id/resume|fork`.",
        "Skip `fetch('/api/...')`, `http://localhost:3000/dashboard`.",
        "Skip `internal/api/entry_handlers.go`, `/features*` and `speckit.plan`.",
        "Dead on purpose: `/old/page` <!-- drift-check: skip -->",
        "```bash",
        "curl `/api/never/checked` and `/never/a/page`",
        "```",
        "Mounted at `/api/projects/:projectId/spec-kit`.",
      ].join("\n"),
    );
    expect(refs.map((r) => [r.line, r.kind, r.methods.join("/"), r.path])).toEqual([
      [1, "page", "", "/projects/:id/settings"],
      [1, "api", "post", "/api/projects/:id/analyses"],
      [2, "api", "get/put", "/api/x/:id"],
      [2, "api", "", "/api/ai/sessions/:id/resume"],
      [2, "api", "", "/api/ai/sessions/:id/fork"],
      [9, "api", "", "/api/projects/:projectId/spec-kit"],
    ]);
  });
});

describe("findPlanDrift", () => {
  const apiRoutes = [
    { method: "get", path: "/api/projects/:projectId/overview" },
    { method: "patch", path: "/api/projects/:id/budget" },
    { method: "all", path: "/api/hook" },
  ];
  const pageFiles = ["(authed)/projects/[id]/page.tsx", "(authed)/dashboard/page.tsx"];
  const drift = (/** @type {string} */ md) =>
    findPlanDrift({ refs: extractPlanReferences(md), apiRoutes, pageFiles });

  it("passes references the tree serves", () => {
    expect(
      drift(
        "`GET /api/projects/:id/overview` `PATCH /api/projects/:id/budget` `POST /api/hook` `/api/projects` `/dashboard` `/projects/:id`",
      ),
    ).toEqual([]);
  });

  it("flags a wrong method, a dead route and a dead page with their line", () => {
    expect(
      drift(
        "ok\n`PUT /api/projects/:id/budget`\n`/api/test-management/connections` `/projects/:id/test-coverage`",
      ),
    ).toEqual([
      {
        line: 2,
        kind: "api",
        reference: "PUT /api/projects/:id/budget",
        span: "PUT /api/projects/:id/budget",
      },
      {
        line: 3,
        kind: "api",
        reference: "/api/test-management/connections",
        span: "/api/test-management/connections",
      },
      {
        line: 3,
        kind: "page",
        reference: "/projects/:id/test-coverage",
        span: "/projects/:id/test-coverage",
      },
    ]);
  });

  it("requires every method of a multi-method reference", () => {
    expect(drift("`GET/PATCH /api/projects/:id/budget`")).toHaveLength(1);
  });
});

describe("findPlanDrift — ellipsis (suffix) references", () => {
  const apiRoutes = [
    { method: "get", path: "/api/projects/:projectId/requirements/:requirementId/traceability" },
    { method: "post", path: "/api/projects/:projectId/documents/url" },
    { method: "get", path: "/api/ai/sessions/:id" },
    { method: "put", path: "/api/projects/:projectId/spec-kit/features/:slug/artifacts/*key" },
    { method: "post", path: "/api/projects/:projectId/spec-kit/commands/:cmd" },
    { method: "post", path: "/api/integrations/slack/workspaces/:workspaceId/install" },
    { method: "post", path: "/api/x/:a/:b" },
  ];
  const drift = (/** @type {string} */ md, routes = apiRoutes) =>
    findPlanDrift({ refs: extractPlanReferences(md), apiRoutes: routes, pageFiles: [] }).map(
      (p) => p.reference,
    );

  it("passes a suffix some route ends with, placeholders fitting placeholders", () => {
    expect(
      drift(
        [
          "`GET …/requirements/:reqId/traceability`",
          "`POST …/documents/url` `…/documents/url`",
          "`PUT …/features/:slug/artifacts/*key`",
          "`POST …/commands/speckit.specify`",
          "`Link: <…/commands/speckit.specify>`",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("flags #948's motivating form once the route is gone", () => {
    const withoutTraceability = apiRoutes.slice(1);
    expect(drift("`GET …/requirements/:reqId/traceability`", withoutTraceability)).toEqual([
      "GET …/requirements/:reqId/traceability",
    ]);
  });

  it("flags a suffix with the wrong method", () => {
    expect(drift("`GET …/documents/url`")).toEqual(["GET …/documents/url"]);
  });

  it("requires every method of a multi-method suffix", () => {
    expect(drift("`GET/POST …/documents/url`")).toEqual(["GET/POST …/documents/url"]);
  });

  it("does not let a placeholder or splat absorb every literal of the suffix", () => {
    // `/:id` would take `test`; `*key` would take `drift/count`; `/:a/:b`
    // would take `:n/re-review`.
    expect(drift("`…/test` `…/drift/count` `POST …/:n/re-review`")).toEqual([
      "…/test",
      "…/drift/count",
      "POST …/:n/re-review",
    ]);
  });

  it("anchors the segment after the ellipsis to a literal of the route", () => {
    // `:workspaceId` must not stand in for `spec-kit`.
    expect(drift("`POST …/spec-kit/install`")).toEqual(["POST …/spec-kit/install"]);
  });

  it("never matches the whole route: the ellipsis stands for at least one segment", () => {
    expect(drift("`…/api/ai/sessions/:id`")).toEqual(["…/api/ai/sessions/:id"]);
  });
});
