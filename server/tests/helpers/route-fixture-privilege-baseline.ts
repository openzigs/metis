/**
 * Issue #1058 (epic #1051) — RATCHET BASELINE for the privileged-fixture check.
 *
 * Entries are test files that stub `requireAuth` and never impersonate a
 * non-admin caller, so they cannot detect an object-level authorization hole.
 * See `helpers/route-fixture-privilege.ts` for what is (and is not) detected.
 *
 * This list may only SHRINK. `route-fixture-privilege.test.ts` fails when a
 * NEW fixture matches, and when a listed fixture has been fixed but not
 * removed. Adding a line needs a reviewer and a real reason — "the test went
 * red" is not one. The fix is usually two lines: authenticate as a `reader` or
 * `developer` for at least one case, and assert the 403/404.
 *
 * Two categories are represented, and they are not equally worrying:
 *   • ADMIN SURFACE — the routes under test are genuinely admin-gated
 *     (`/api/admin/**`, workspace-admin integrations), so an admin caller IS
 *     the realistic one. Low value in changing these.
 *   • PROJECT-SCOPED — the routes serve `/projects/:projectId/**` or resolve a
 *     project from a resource id. These are the ones worth fixing: an admin
 *     caller bypasses `assertProjectAccess` outright, so a cross-tenant bug in
 *     these routes is invisible to their own suite.
 */

/** One baselined fixture: repo-relative path from `server/`, plus a reason. */
export interface FixtureBaselineEntry {
  file: string;
  note: string;
}

export const ROUTE_FIXTURE_BASELINE: readonly FixtureBaselineEntry[] = [
  // ── admin surface: admin is the realistic caller ─────────────────────────
  {
    file: "tests/admin-auth-secret-masking.test.ts",
    note: "admin surface — mounts /api/admin/auth, which is admin-gated by design",
  },
  {
    file: "tests/routes/admin/embeddings.test.ts",
    note: "admin surface — mounts /api/admin/embeddings",
  },
  {
    file: "src/routes/admin/embeddings.test.ts",
    note: "admin surface — mounts /admin/embeddings",
  },
  {
    file: "src/routes/integrations/teams.test.ts",
    note: "admin surface — workspace-admin Teams install/config routes",
  },
  {
    file: "tests/users.test.ts",
    note: "admin surface — user administration routes; no project dimension",
  },
  {
    file: "src/routes/acp.scopes.test.ts",
    note: "not project-scoped — ACP token scope issuance; asserts scopes directly",
  },
  {
    file: "src/routes/ai-sdk.messages.test.ts",
    note: "not project-scoped — AI SDK message shape, no project-owned data",
  },
  {
    file: "src/routes/notification-preferences.test.ts",
    note: "not project-scoped — /users/me/** self-scoped preferences",
  },

  // ── project-scoped: real debt, worth fixing ──────────────────────────────
  {
    file: "tests/change-analysis-routes.test.ts",
    note: "project-scoped: /projects/:projectId/change-analyses; admin-only caller",
  },
  {
    file: "tests/comments-mentions.test.ts",
    note: "project-scoped comments/mentions; admin-only caller",
  },
  {
    file: "tests/import-routes.test.ts",
    note: "project-scoped imports; stubs requireAuth with no role literal at all",
  },
  {
    file: "tests/requirement-history.test.ts",
    note: "project-scoped requirement history; admin-only caller",
  },
  {
    file: "tests/requirements-update-history.test.ts",
    note: "project-scoped requirement updates; admin-only caller",
  },
  {
    file: "tests/run-reviews.test.ts",
    note: "run reviews resolve a project from a run id; no role literal",
  },
  {
    file: "tests/spec-kit-routes.test.ts",
    note: "project-scoped /projects/:projectId/spec-kit; no role literal",
  },
  {
    file: "tests/stakeholders-routes.test.ts",
    note: "project-scoped stakeholders; admin-only caller",
  },
  {
    file: "tests/unit/generated-docs-route.test.ts",
    note: "project-scoped generated docs; admin-only caller",
  },
  {
    file: "tests/routes/test-management.test.ts",
    note: "id-resolved test-management connections; no role literal (cross-tenant cases live in test-management-connection-idor.test.ts)",
  },
  {
    file: "src/routes/data-mappings.test.ts",
    note: "project-scoped /projects/:projectId data mappings; no role literal",
  },
  {
    file: "src/routes/pr-reviews.test.ts",
    note: "project-scoped /projects/:projectId/pr-reviews; no role literal",
  },
  {
    file: "src/routes/rules.test.ts",
    note: "project-scoped /projects/:projectId/rule-sets; no role literal",
  },
  {
    file: "src/routes/scans.test.ts",
    note: "project-scoped /projects/:projectId scans; no role literal",
  },
  {
    file: "src/routes/spec-kit-route.test.ts",
    note: "project-scoped spec-kit; admin-only caller",
  },
  {
    file: "src/routes/triage.test.ts",
    note: "project-scoped /projects/:projectId triage; no role literal",
  },
];
