/**
 * E2E — the way into a workspace's own pages (#2339, Epic #2328).
 *
 * Covers:
 *   - from a project, the workspace switcher's "Open workspace" lands on the
 *     project's workspace, from which Traceability and Governing documents
 *     are each one click away — no URL typed;
 *   - both pages name the workspace and lead back to the project.
 *
 * Governing documents are on by default (#1878), as on the e2e stack. The
 * analysis panel's link to the same page is covered in
 * `analysis-governing-findings.spec.ts`, which seeds findings.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { WorkspaceSwitcherPage } from "../pages/workspace-switcher.page.js";
import { WorkspaceNavPage } from "../pages/workspace-nav.page.js";

const API_BASE = apiBase();

async function created<T>(res: Awaited<ReturnType<APIRequestContext["post"]>>, what: string) {
  expect(res.status(), `${what}: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { data?: T };
  if (!body.data) throw new Error(`${what}: no data in the response`);
  return body.data;
}

test.describe("Workspace pages have a way in (#2339)", () => {
  let api: APIRequestContext;
  let workspaceId = "";
  let workspaceName: string;
  let projectId: string;
  let projectName: string;

  test.beforeEach(async ({ page }) => {
    workspaceId = "";
    const primed = await primeAdminUser(API_BASE);
    api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${primed.accessToken}` },
    });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    workspaceName = `Way in ${stamp}`;
    const workspace = await created<{ id: string }>(
      await api.post("/api/workspaces", {
        data: { name: workspaceName, slug: `e2e-way-in-${stamp}` },
      }),
      "create the workspace",
    );
    workspaceId = workspace.id;
    projectName = `Way in project ${stamp}`;
    const project = await created<{ id?: string; project?: { id?: string } }>(
      await api.post("/api/projects", {
        data: {
          name: projectName,
          slug: `e2e-way-in-${stamp}`,
          description: "workspace way-in e2e (#2339)",
          workspaceId,
        },
      }),
      "create the project",
    );
    projectId = (project.project?.id ?? project.id) as string;
    expect(projectId).toBeTruthy();

    await new LoginPage(page).loginAsAdmin();
  });

  // Best-effort, as workspaces.spec.ts: a failed delete is annotated, not a failure.
  test.afterEach(async ({}, testInfo) => {
    if (!api) return;
    if (workspaceId) {
      const res = await api.delete(`/api/workspaces/${workspaceId}`).catch(() => null);
      if (!res?.ok()) {
        testInfo.annotations.push({
          type: "cleanup",
          description: `workspace ${workspaceId} not deleted (${res ? `HTTP ${res.status()}` : "request failed"})`,
        });
      }
    }
    await api.dispose();
  });

  test("from a project, Open workspace leads to Governing documents and Traceability, and back", async ({
    page,
  }) => {
    const switcher = new WorkspaceSwitcherPage(page);
    const workspace = new WorkspaceNavPage(page);

    await test.step("open the project", async () => {
      await page.goto(`/projects/${projectId}`);
      await expect(
        page.getByRole("button", { name: `Active project: ${projectName}` }),
      ).toBeVisible({ timeout: 30_000 });
      await switcher.expectActiveWorkspace(workspaceName);
    });

    await test.step("Open workspace lands on the project's workspace", async () => {
      await switcher.openWorkspace();
      await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}$`));
      await expect(
        page.getByRole("heading", { level: 1, name: "Overview", exact: true }),
      ).toBeVisible();
      await workspace.expectWorkspace(workspaceName);
    });

    await test.step("Governing documents is one click away", async () => {
      await workspace.openSection("Governing documents");
      await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/governing$`));
      await workspace.expectWorkspace(workspaceName);
    });

    await test.step("so is Traceability", async () => {
      await workspace.openSection("Traceability");
      await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/traceability$`));
      await workspace.expectWorkspace(workspaceName);
    });

    await test.step("and the way back leads to the project", async () => {
      await workspace.backTo(projectName).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(?:[/?#]|$)`));
    });
  });
});
