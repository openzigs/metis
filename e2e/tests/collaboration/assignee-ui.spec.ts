/**
 * Epic #34 — Assignee picker + SLA badge browser flow (AC4).
 *
 * Acceptance criteria covered:
 *   AC4 (UI portion): Given an admin views a requirement, the AssigneePicker
 *        and SLABadge are mounted on the analysis page requirement card
 *        (commit 38265fb). An admin can open the picker, search for a user, and
 *        assign them; the assignee chip then renders. The SLA badge reflects
 *        the soonest unresolved deadline.
 *
 * The SLA-expiry notification fan-out (the back-half of AC4) is a server-side
 * scheduled job and is covered by server unit/integration tests; the
 * assignment + SLA persistence contract is covered at the API level in
 * two-user-comment.spec.ts.
 *
 * Requires a running stack. NOTE: NOT run in CI — needs a live UI + API stack.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER } from "../../fixtures/seed-user.js";
import { apiBase } from "../../fixtures/api-base.js";
import { LoginPage } from "../../pages/login.page.js";
import { AnalysisPage } from "../../pages/analysis-inline.page.js";
import { RequirementCollabPage } from "../../pages/RequirementCollab.page.js";

const API_BASE = apiBase();
const COORDINATOR = { username: "coordinator", password: "password" };

async function loginAs(
  username: string,
  password: string,
): Promise<{ userId: string; accessToken: string; api: APIRequestContext }> {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login failed for ${username}: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { data: { user: { id: string }; accessToken: string } };
  await ctx.dispose();
  const api = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${body.data.accessToken}` },
  });
  return { userId: body.data.user.id, accessToken: body.data.accessToken, api };
}

async function runSeedScript(scriptName: string, args: string[]): Promise<{ id: string }> {
  const { spawnSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const repoRoot = resolve(new URL(import.meta.url).pathname, "../../../../..");
  const dbFile = process.env.E2E_DB_FILE;
  if (!dbFile) throw new Error("E2E_DB_FILE not set");
  const scriptPath = resolve(repoRoot, "server", "scripts", scriptName);
  const result = spawnSync(
    "pnpm",
    ["--filter", "@metis/server", "exec", "tsx", scriptPath, ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: `file:${dbFile}`, DATABASE_PROVIDER: "sqlite" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`Seed (${scriptName}) failed:\n${result.stderr}\n${result.stdout}`);
  }
  return JSON.parse(result.stdout) as { id: string };
}

test.describe("Epic #34 — Assignee picker + SLA badge (AC4, browser)", () => {
  let adminApi: APIRequestContext;
  let adminUserId: string;
  let coordinatorUserId: string;
  let projectId: string;
  let reqId: string;

  test.beforeAll(async () => {
    const [admin, coord] = await Promise.all([
      loginAs(ADMIN_USER.username, ADMIN_USER.password),
      loginAs(COORDINATOR.username, COORDINATOR.password),
    ]);
    adminApi = admin.api;
    adminUserId = admin.userId;
    coordinatorUserId = coord.userId;

    const res = await adminApi.post("/api/projects", {
      data: { name: `collab-assignee-${Date.now()}`, description: "E2E #34 AC4" },
    });
    expect(res.status()).toBe(201);
    projectId = (await res.json()).data.id as string;

    const analysisId = (
      await runSeedScript("e2e-seed-analysis-grounding.ts", [projectId, adminUserId])
    ).id;
    reqId = (await runSeedScript("e2e-seed-requirement.ts", [projectId, analysisId])).id;
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
  });

  test("AC4: admin assigns the coordinator through the AssigneePicker UI", async ({ page }) => {
    const login = new LoginPage(page);
    await login.loginAsAdmin();

    const analysisPage = new AnalysisPage(page);
    await analysisPage.goto(projectId);

    const collab = new RequirementCollabPage(page, reqId);
    await collab.waitForVisible();

    // Open the picker, search, and select the coordinator.
    await collab.addAssigneeButton().click();
    await collab.assigneeSearchInput().fill(COORDINATOR.username);
    const option = page.getByRole("option").filter({ hasText: `@${COORDINATOR.username}` });
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();

    // The assignee chip appears in the collab row.
    await expect(collab.assigneeChip(COORDINATOR.username)).toBeVisible({ timeout: 10_000 });
  });

  test("AC4: an SLA deadline assigned via API renders an SLA badge on the card", async ({
    page,
  }) => {
    // Assign with a 2-day SLA through the API (the picker UI itself does not
    // set deadlines), then confirm the badge surfaces it.
    const deadline = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const assign = await adminApi.post(`/api/requirements/${reqId}/assignments`, {
      data: { assigneeId: coordinatorUserId, slaDeadline: deadline },
    });
    expect([200, 201]).toContain(assign.status());

    const login = new LoginPage(page);
    await login.loginAsAdmin();

    const analysisPage = new AnalysisPage(page);
    await analysisPage.goto(projectId);

    const collab = new RequirementCollabPage(page, reqId);
    await collab.waitForVisible();

    // The badge shows a "Due in …" label (warning/ok) rather than "No SLA".
    await expect(collab.slaBadge()).toBeVisible({ timeout: 10_000 });
    await expect(collab.slaBadge()).toContainText(/Due in/i);
  });
});
