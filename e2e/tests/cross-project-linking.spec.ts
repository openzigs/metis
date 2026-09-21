/**
 * Cross-project requirement linking + workspace traceability — Epic #610 (#627).
 *
 * End-to-end coverage for the feature landed across #623 (RequirementLink model),
 * #624 (link CRUD + workspace-scoped search API), #625 (requirement-detail links
 * panel + add-link dialog), and #626 (workspace traceability rollup API + UI).
 *
 * Acceptance criteria mapped:
 *   AC1 — Link a requirement in project A to one in project B (same workspace)
 *         through the UI; the link is visible from BOTH requirement detail pages
 *         with a cross-project badge naming the counterpart project.
 *   AC2 — A cross-workspace link is rejected: the workspace-scoped picker never
 *         surfaces a requirement outside the project's workspace, and the create
 *         API rejects it with a stable `CROSS_WORKSPACE_LINK` error.
 *   AC3 — The workspace traceability rollup shows the cross-project link (coverage
 *         table + link map), and the requirement chain with `includeLinked=true`
 *         returns the linked counterpart's chain.
 *
 * Determinism notes (carried from the existing suite):
 *   - The offline-stub AI provider can't emit structured requirements, so each
 *     Requirement is seeded directly into the e2e SQLite DB via
 *     `seedRequirementViaCli` after a real (empty) analysis completes, then given
 *     a run-unique title through a REAL `PUT /api/requirements/:id` so the
 *     workspace search matches exactly one row (the DB accretes across specs).
 *   - Mock logins upsert only the `User` row and drive permissions from the JWT
 *     role; the `admin` requester carries `project.read` + `project.update`.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  primeUser,
  authedApi,
  seedCompletedAnalysis,
  updateRequirementTitle,
  e2eDatabaseUrl,
  REQUESTER,
} from "../fixtures/review-helpers.js";
import { seedRequirementViaCli } from "../fixtures/seed-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { RequirementLinksPage } from "../pages/requirement-links.page.js";
import { WorkspaceTraceabilityPage } from "../pages/workspace-traceability.page.js";

/** A run-unique token so titles/slugs never collide with prior spec data. */
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

interface WorkspaceRef {
  id: string;
  name: string;
}

interface SeededRequirement {
  projectId: string;
  projectName: string;
  requirementId: string;
  title: string;
}

/** Create a workspace; returns its id + name. */
async function createWorkspace(api: APIRequestContext, label: string): Promise<WorkspaceRef> {
  const name = `Link WS ${label} ${RUN}`;
  const res = await api.post("/api/workspaces", {
    data: { name, slug: `link-ws-${label}-${RUN}`.toLowerCase() },
  });
  expect(res.status(), `create workspace: ${await res.text()}`).toBe(201);
  const id = ((await res.json()) as { data: { id: string } }).data.id;
  expect(id, "workspace id present").toBeTruthy();
  return { id, name };
}

/** Create a project inside a workspace; returns its id + name. */
async function createProjectInWorkspace(
  api: APIRequestContext,
  workspaceId: string,
  label: string,
): Promise<{ id: string; name: string }> {
  const name = `Link Proj ${label} ${RUN}`;
  const res = await api.post("/api/projects", {
    data: {
      name,
      slug: `link-proj-${label}-${RUN}`.toLowerCase(),
      description: "epic-610 #627 e2e",
      workspaceId,
    },
  });
  expect(res.status(), `create project: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { data?: { id?: string; project?: { id?: string } } };
  const id = body.data?.id ?? body.data?.project?.id;
  expect(id, "project id present").toBeTruthy();
  return { id: id as string, name };
}

/**
 * Seed one requirement into `projectId` with a run-unique, searchable title.
 * Returns the requirement id + the title it was given.
 */
async function seedRequirement(
  api: APIRequestContext,
  token: string,
  project: { id: string; name: string },
  titleToken: string,
): Promise<SeededRequirement> {
  const analysisId = await seedCompletedAnalysis(api, project.id);
  const requirementId = seedRequirementViaCli({
    projectId: project.id,
    analysisId,
    databaseUrl: e2eDatabaseUrl(),
  });
  expect(requirementId, "seeded requirement id present").toBeTruthy();
  const title = `${titleToken} ${RUN}`;
  await updateRequirementTitle(api, requirementId, title);
  return { projectId: project.id, projectName: project.name, requirementId, title };
}

/** Create a link between two requirements; tolerate a pre-existing duplicate. */
async function ensureLink(
  api: APIRequestContext,
  sourceRequirementId: string,
  targetRequirementId: string,
  type = "relates_to",
): Promise<void> {
  const res = await api.post(`/api/requirements/${sourceRequirementId}/links`, {
    data: { targetRequirementId, type },
  });
  const status = res.status();
  if (status === 201) return;
  // A prior run (or the AC1 UI flow) may already have created this exact link.
  if (status === 409) {
    const code = ((await res.json()) as { error?: { code?: string } }).error?.code;
    expect(code, `unexpected 409: ${JSON.stringify(code)}`).toBe("DUPLICATE_LINK");
    return;
  }
  throw new Error(`ensureLink failed (${status}): ${await res.text()}`);
}

test.describe("Epic #610 — cross-project requirement linking", () => {
  let token: string;
  let api: APIRequestContext;

  // Same-workspace pair driven through the UI (AC1) + reused for the rollup (AC3).
  let workspace: WorkspaceRef;
  let reqA: SeededRequirement;
  let reqB: SeededRequirement;

  // A requirement in a DIFFERENT workspace, for the cross-workspace rejection (AC2).
  let otherWorkspace: WorkspaceRef;
  let reqC: SeededRequirement;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const primed = await primeUser(REQUESTER);
    token = primed.accessToken;
    api = await authedApi(token);

    workspace = await createWorkspace(api, "alpha");
    const projectA = await createProjectInWorkspace(api, workspace.id, "a");
    const projectB = await createProjectInWorkspace(api, workspace.id, "b");
    reqA = await seedRequirement(api, token, projectA, "REQ-SOURCE");
    reqB = await seedRequirement(api, token, projectB, "REQ-TARGET");

    otherWorkspace = await createWorkspace(api, "beta");
    const projectC = await createProjectInWorkspace(api, otherWorkspace.id, "c");
    reqC = await seedRequirement(api, token, projectC, "REQ-OTHERWS");
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await new LoginPage(page).loginAsAdmin();
  });

  // AC1 — link A→B via the UI; assert it is visible with a project badge on both
  // requirement detail pages.
  test("links a requirement across projects and shows it on both sides with badges", async ({
    page,
  }) => {
    const links = new RequirementLinksPage(page);

    await test.step("project A: link the requirement to project B's requirement", async () => {
      await links.goto(reqA.projectId);
      await links.openAddDialog();
      await links.linkTo(reqB.title);
    });

    await test.step("project A shows an outgoing link with project B's badge", async () => {
      await expect(links.crossProjectRow(reqB.projectName)).toHaveCount(1);
      await expect(links.crossProjectBadge).toContainText(reqB.projectName);
    });

    await test.step("project B shows the reciprocal incoming link with project A's badge", async () => {
      const linksB = new RequirementLinksPage(page);
      await linksB.goto(reqB.projectId);
      await expect(linksB.crossProjectRow(reqA.projectName)).toHaveCount(1);
      await expect(linksB.crossProjectBadge).toContainText(reqA.projectName);
    });
  });

  // AC2 — a cross-workspace link is rejected: the picker never surfaces the
  // out-of-workspace requirement, and the create API rejects it explicitly.
  test("rejects a cross-workspace link at the picker and the API", async ({ page }) => {
    await test.step("the workspace-scoped picker does not surface a requirement in another workspace", async () => {
      const links = new RequirementLinksPage(page);
      await links.goto(reqA.projectId);
      await links.openAddDialog();
      await links.search(reqC.title);
      // reqC lives in a different workspace, so the workspace-scoped search must
      // return no match — and never offer a "Link to" affordance for it.
      await expect(links.noResults).toBeVisible();
      await expect(links.resultLinkButton(reqC.title)).toHaveCount(0);
    });

    await test.step("the create API rejects a cross-workspace target with CROSS_WORKSPACE_LINK", async () => {
      const res = await api.post(`/api/requirements/${reqA.requirementId}/links`, {
        data: { targetRequirementId: reqC.requirementId, type: "relates_to" },
      });
      expect(res.status()).toBe(409);
      const code = ((await res.json()) as { error?: { code?: string } }).error?.code;
      expect(code).toBe("CROSS_WORKSPACE_LINK");
    });
  });

  // AC3 — the workspace rollup surfaces the cross-project link, and the
  // requirement chain with includeLinked returns the linked counterpart.
  test("surfaces the cross-project link in the workspace rollup and linked chain", async ({
    page,
  }) => {
    // Ensure the A→B link exists regardless of AC1's UI outcome / run order.
    await ensureLink(api, reqA.requirementId, reqB.requirementId);

    await test.step("the workspace traceability rollup lists both projects and a link map", async () => {
      const rollup = new WorkspaceTraceabilityPage(page);
      await rollup.goto(workspace.id);
      await expect(rollup.summaryTable).toBeVisible();
      await expect(rollup.projectRow(reqA.projectName)).toHaveCount(1);
      await expect(rollup.projectRow(reqB.projectName)).toHaveCount(1);
      await rollup.expectLinkMapRendered();
    });

    await test.step("GET traceability?includeLinked=true returns the linked counterpart's chain", async () => {
      const res = await api.get(
        `/api/projects/${reqA.projectId}/requirements/${reqA.requirementId}/traceability?includeLinked=true&depth=1`,
      );
      expect(res.ok(), `linked chain: ${await res.text()}`).toBeTruthy();
      const data = (
        (await res.json()) as {
          data: {
            linkedChains: Array<{ link: { requirement: { id: string; projectId: string } } }>;
          };
        }
      ).data;
      const linkedIds = data.linkedChains.map((c) => c.link.requirement.id);
      expect(linkedIds).toContain(reqB.requirementId);
    });
  });
});
