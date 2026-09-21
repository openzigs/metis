/**
 * Issue #1058 (epic #1051) — the project-scope guard is now ENFORCED, not just
 * conventional.
 *
 * Epic #1051 fixed the handful of `requireProjectAccess()` omissions a security
 * scan happened to rank highly. Seven routers got it right and five got it
 * wrong; that ratio says the convention is understood but unenforced, so the
 * sixth omission is a matter of time. This test closes the *category*:
 *
 *   1. It ENUMERATES the real mount table in `server/src/routes/index.ts` — it
 *      never hardcodes a router list — so router number 32 is covered the day
 *      it is added.
 *   2. Every `:projectId`-mounted router must apply `requireProjectAccess()`
 *      before any of its route handlers.
 *   3. Routers that do not yet comply live in an explicit, reviewed baseline
 *      (`helpers/project-access-baseline.ts`). The list may only SHRINK: a new
 *      omission fails the test, and so does a baselined router that has since
 *      been fixed but not removed from the list.
 *
 * Reference pattern: `server/src/routes/connectors.ts:269`.
 *
 * SCOPE. This is a STRUCTURAL check — "does this router carry its own guard".
 * The complementary BEHAVIOURAL check — "can a cross-tenant request actually
 * reach a handler" — lives in `project-access-effective.test.ts`, which drives
 * real requests through the assembled router tree. Both matter, and neither
 * subsumes the other: the baseline below is currently protected by upstream
 * catch-alls, so the behavioural test is green while this one is not. See the
 * baseline file's header for the measurement.
 *
 * Routers that resolve a project INDIRECTLY from a resource id (`jira`,
 * `test-management`, `background-runs`) are not `:projectId`-mounted and so are
 * invisible to this test by construction. They are covered behaviourally by
 * `jira-connection-idor.test.ts`, `test-management-connection-idor.test.ts` and
 * `background-runs-authz.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isProjectScopedPath,
  parseMountTable,
  readMountTable,
  type MountedHandler,
} from "./helpers/mount-table.js";
import { PROJECT_ACCESS_BASELINE, baselineKey } from "./helpers/project-access-baseline.js";

const INDEX_PATH = fileURLToPath(new URL("../src/routes/index.ts", import.meta.url));

/** Name Express gives the middleware returned by `requireProjectAccess()`. */
const GUARD_FN_NAME = "requireProjectAccessMiddleware";

const REFERENCE = "server/src/routes/connectors.ts:269";

/** Minimal structural view of an Express 5 layer. */
interface Layer {
  handle: unknown;
  route?: unknown;
  match?: (path: string) => boolean;
  params?: Record<string, string>;
}
type RouterLike = ((...args: unknown[]) => unknown) & { stack: Layer[] };

function asRouter(handle: unknown): RouterLike | null {
  return typeof handle === "function" && Array.isArray((handle as RouterLike).stack)
    ? (handle as RouterLike)
    : null;
}

/**
 * Verify the router applies the guard before anything that can serve a request.
 *
 * "Anything that can serve a request" is the first layer that is either a route
 * (`.get`/`.post`/…) or a nested sub-router — a guard mounted after one of
 * those does not protect it.
 */
function guardPrecedesHandlers(router: RouterLike): boolean {
  const guardAt = router.stack.findIndex(
    (l) => typeof l.handle === "function" && (l.handle as { name?: string }).name === GUARD_FN_NAME,
  );
  if (guardAt === -1) return false;
  const firstHandlerAt = router.stack.findIndex(
    (l) => l.route !== undefined || asRouter(l.handle) !== null,
  );
  return firstHandlerAt === -1 || guardAt < firstHandlerAt;
}

/** The guard may also be supplied at the mount site, alongside the router. */
function mountSiteGuards(entry: MountedHandler): boolean {
  return entry.siblings.some((s) => s.startsWith("requireProjectAccess("));
}

const table = readMountTable(INDEX_PATH);
const { apiRouter } = await import("../src/routes/index.js");
const runtimeStack = (apiRouter() as unknown as RouterLike).stack;

describe("mount-table reader", () => {
  it("zips 1:1 with the assembled Express router stack", () => {
    // Each handler argument of each `r.use(...)` becomes exactly one layer. If
    // this drifts, the parser has stopped understanding index.ts and every
    // conclusion below would be drawn against the wrong router.
    expect(table.length).toBe(runtimeStack.length);
  });

  it("aligns each parsed path with the layer it claims to describe", () => {
    // Replay the parsed path through the layer's OWN matcher. A positional
    // mis-zip cannot survive this: layer N would not match mount path N.
    const mismatched: string[] = [];
    table.forEach((entry, i) => {
      if (entry.path === null) return;
      const layer = runtimeStack[i];
      const probe = entry.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => `probe-${name}`);
      if (!layer?.match?.(probe)) mismatched.push(`${i}: ${entry.path} (${entry.expression})`);
    });
    expect(mismatched).toEqual([]);
  });

  it("finds the project-scoped subtree it is meant to police", () => {
    // A guard test that silently enumerates nothing is worse than no test.
    const scoped = table.filter((e) => isProjectScopedPath(e.path));
    expect(scoped.length).toBeGreaterThanOrEqual(30);
  });

  it("parses paths, expressions and sibling handlers out of a `r.use` call", () => {
    const parsed = parseMountTable(
      [
        "export function apiRouter(): Router {",
        '  r.use("/projects/:projectId/x", requireProjectAccess(), xRouter());',
        "  r.use(bare);",
        '  r.use("/y", yRouter({ a: 1, b: "," }));',
        "  return r;",
        "}",
      ].join("\n"),
    );
    expect(parsed.map((p) => [p.path, p.expression])).toEqual([
      ["/projects/:projectId/x", "requireProjectAccess()"],
      ["/projects/:projectId/x", "xRouter()"],
      [null, "bare"],
      ["/y", 'yRouter({ a: 1, b: "," })'],
    ]);
    expect(parsed[0].siblings).toEqual(["requireProjectAccess()", "xRouter()"]);
  });

  it("recognises `:projectId` only as a whole path segment", () => {
    expect(isProjectScopedPath("/projects/:projectId")).toBe(true);
    expect(isProjectScopedPath("/projects/:projectId/docs")).toBe(true);
    expect(isProjectScopedPath("/workspaces/:workspaceId")).toBe(false);
    expect(isProjectScopedPath("/projects/:projectIdish")).toBe(false);
    expect(isProjectScopedPath(null)).toBe(false);
  });
});

describe("every :projectId-mounted router applies requireProjectAccess()", () => {
  const scoped = table
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isProjectScopedPath(entry.path));

  const results = scoped.map(({ entry, index }) => {
    const router = asRouter(runtimeStack[index]?.handle);
    return {
      key: baselineKey({ path: entry.path as string, expression: entry.expression }),
      line: entry.line,
      // A non-router handler mounted on a `:projectId` path is plain middleware
      // (a rate limiter, say) and carries no handlers of its own to protect.
      guarded: router === null || mountSiteGuards(entry) || guardPrecedesHandlers(router),
      isRouter: router !== null,
    };
  });

  const baselineKeys = new Set(PROJECT_ACCESS_BASELINE.map(baselineKey));

  it("has no unguarded router outside the reviewed baseline", () => {
    const offenders = results
      .filter((r) => !r.guarded && !baselineKeys.has(r.key))
      .map(
        (r) =>
          `  ${r.key}\n` +
          `    mounted at server/src/routes/index.ts:${r.line}\n` +
          `    → this router serves /projects/:projectId/** but never applies ` +
          `requireProjectAccess(), so a caller who is not a member of the target ` +
          `project's workspace reaches its handlers on role alone (OWASP A01 / BOLA).\n` +
          `    → fix: add \`r.use(requireAuth, requireProjectAccess());\` above the ` +
          `first route. Reference pattern: ${REFERENCE}.`,
      );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `\n${offenders.length} project-scoped router(s) are missing the object-level ` +
            `project-scope guard:\n\n${offenders.join("\n\n")}\n\n` +
            `Do NOT silence this by appending to tests/helpers/project-access-baseline.ts — ` +
            `that list is a shrinking record of pre-existing debt, not an opt-out.\n`,
    ).toEqual([]);
  });

  it("has no baseline entry that is already fixed (the list may only shrink)", () => {
    const guardedKeys = new Set(results.filter((r) => r.guarded).map((r) => r.key));
    const stale = [...baselineKeys].filter((k) => guardedKeys.has(k));
    expect(
      stale,
      stale.length === 0
        ? ""
        : `\nThese routers now apply requireProjectAccess() but are still listed in ` +
            `tests/helpers/project-access-baseline.ts. Delete their entries so the ` +
            `baseline keeps telling the truth:\n  ${stale.join("\n  ")}\n`,
    ).toEqual([]);
  });

  it("has no baseline entry for a mount that no longer exists", () => {
    const liveKeys = new Set(results.map((r) => r.key));
    const orphans = [...baselineKeys].filter((k) => !liveKeys.has(k));
    expect(
      orphans,
      orphans.length === 0
        ? ""
        : `\nThese baseline entries match no mount in index.ts — the router was renamed, ` +
            `re-mounted or deleted. Update tests/helpers/project-access-baseline.ts:\n  ` +
            `${orphans.join("\n  ")}\n`,
    ).toEqual([]);
  });

  it("still recognises the reference implementations as guarded", () => {
    // Anchors the detector itself: if `guardPrecedesHandlers` ever stops seeing
    // a guard it should see, these known-good routers go red first and the
    // headline assertion's silence is not mistaken for safety.
    const guarded = new Set(results.filter((r) => r.guarded).map((r) => r.key));
    for (const key of [
      "/projects/:projectId/connectors → connectorsRouter()",
      "/projects/:projectId/imports → importsRouter()",
      "/projects/:projectId/hooks → hooksRouter()",
      "/projects/:projectId/suggested-connectors → suggestedConnectorsRouter()",
    ]) {
      expect(guarded, `${key} should be detected as guarded`).toContain(key);
    }
  });

  it("gives every baseline entry a written reason", () => {
    for (const entry of PROJECT_ACCESS_BASELINE) {
      expect(entry.note.trim().length, `${baselineKey(entry)} needs a reason`).toBeGreaterThan(20);
    }
  });
});

/**
 * Routers exempt from the static check because they resolve the owning project
 * from a RESOURCE ID rather than from `:projectId`. Inspecting their middleware
 * stack proves nothing — the project is not known until a row is read — so each
 * is covered behaviourally instead, and each exemption is justified here.
 */
const ID_RESOLVED_EXEMPTIONS = [
  {
    mount: "/jira",
    expression: "jiraRouter()",
    why: "connections are addressed by primary key; the owning project comes from the row via authorizeJiraConnection (lib/connectors/connection-authz.ts)",
    crossTenantTest: "tests/jira-connection-idor.test.ts",
  },
  {
    mount: "/test-management",
    expression: "testManagementRouter()",
    why: "same shape as jira — authorizeTestManagementConnection resolves the project from the connection row",
    crossTenantTest: "tests/test-management-connection-idor.test.ts",
  },
  {
    mount: "/runs",
    expression: "backgroundRunsRouter()",
    why: "runs and run groups are addressed by primary key; authorizeBackgroundRun / authorizeRunGroup / runProjectScope (lib/async/run-authz.ts) resolve and scope the project",
    crossTenantTest: "tests/background-runs-authz.test.ts",
  },
  {
    mount: "/requirements",
    expression: "requirementsCollaborationRouter()",
    why: "requirements are addressed by primary key; requireRequirementAccess (lib/requirements/requirement-authz.ts) resolves the owning project from the row and scopes every handler query with it (#1118)",
    crossTenantTest: "tests/requirements-tenant-scope.test.ts",
  },
] as const;

describe("id-resolved routers are exempt from the static check, and say why", () => {
  it("are genuinely not :projectId-mounted (otherwise the exemption is a loophole)", () => {
    for (const exempt of ID_RESOLVED_EXEMPTIONS) {
      const mounts = table.filter((e) => e.expression === exempt.expression);
      expect(mounts.length, `${exempt.expression} should be mounted exactly once`).toBe(1);
      expect(
        isProjectScopedPath(mounts[0].path),
        `${exempt.expression} is now mounted at ${mounts[0].path} — it is project-scoped, so ` +
          `delete its exemption and let the static check cover it.`,
      ).toBe(false);
    }
  });

  it("each keeps a cross-tenant 404 test alongside the exemption", () => {
    // The exemption is only defensible while the behavioural test exists. If
    // someone deletes the IDOR suite, this is what notices.
    for (const exempt of ID_RESOLVED_EXEMPTIONS) {
      const file = fileURLToPath(new URL(`../${exempt.crossTenantTest}`, import.meta.url));
      expect(existsSync(file), `${exempt.crossTenantTest} is missing`).toBe(true);
      const source = readFileSync(file, "utf8");
      expect(source, `${exempt.crossTenantTest} must assert a cross-tenant 404`).toMatch(
        /toBe\(404\)/,
      );
    }
  });

  it("states a justification for each exemption", () => {
    for (const exempt of ID_RESOLVED_EXEMPTIONS) {
      expect(exempt.why.length, `${exempt.expression} needs a justification`).toBeGreaterThan(40);
    }
  });
});

describe("guard detector", () => {
  const stub = (name: string) => Object.defineProperty(() => {}, "name", { value: name });
  const mk = (layers: Layer[]) => Object.assign(() => {}, { stack: layers }) as RouterLike;

  it("accepts a guard mounted ahead of the first route", () => {
    expect(
      guardPrecedesHandlers(
        mk([
          { handle: stub("requireAuthMiddleware") },
          { handle: stub(GUARD_FN_NAME) },
          { handle: stub("bound dispatch"), route: {} },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects a router with no guard at all", () => {
    expect(guardPrecedesHandlers(mk([{ handle: stub("bound dispatch"), route: {} }]))).toBe(false);
  });

  it("rejects a guard mounted AFTER a route it was meant to protect", () => {
    expect(
      guardPrecedesHandlers(
        mk([{ handle: stub("bound dispatch"), route: {} }, { handle: stub(GUARD_FN_NAME) }]),
      ),
    ).toBe(false);
  });

  it("rejects a guard mounted after a nested sub-router", () => {
    expect(guardPrecedesHandlers(mk([{ handle: mk([]) }, { handle: stub(GUARD_FN_NAME) }]))).toBe(
      false,
    );
  });

  it("accepts a guard on a router that has no handlers yet", () => {
    expect(guardPrecedesHandlers(mk([{ handle: stub(GUARD_FN_NAME) }]))).toBe(true);
  });

  it("accepts a guard supplied at the mount site instead of inside the router", () => {
    expect(
      mountSiteGuards({
        path: "/projects/:projectId/x",
        expression: "xRouter()",
        siblings: ["requireProjectAccess()", "xRouter()"],
        line: 1,
      }),
    ).toBe(true);
  });
});
