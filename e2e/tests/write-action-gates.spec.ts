/**
 * #2368 — a role is offered a write action only when `/api/auth/me` grants the
 * permission its route checks; otherwise it sees nothing, or a one-line reason.
 *
 * Acceptance criteria covered:
 *   AC1: a `developer` (no `project.create`) sees no New project button on
 *        /projects, and is told to ask an admin.
 *   AC2: a `developer` (no `connector.write`) sees neither connector add form
 *        on a project's Connections page, and is told to ask an admin.
 *   AC3: a `coordinator` (no `project.delete`) is offered no project actions
 *        menu, whose only item is Delete.
 *   Control: an `admin` is offered all three, so the absent-locator checks
 *        above cannot pass on a locator that matches nothing.
 *
 * The server's 403s are unchanged and covered by the server suite; what is
 * under test is what each role is offered in the browser.
 */
import {
  test,
  expect,
  request,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectsPage } from "../pages/project.page.js";
import { ConnectionsPage } from "../pages/connections.page.js";

/** Non-admin mock-auth users (`server/src/lib/auth/mock-provider.ts`). */
const DEVELOPER = { username: "developer", password: "password" };
const COORDINATOR = { username: "coordinator", password: "password" };

async function signedIn(
  browser: Browser,
  who: { username: string; password: string },
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const login = new LoginPage(page);
  await login.goto();
  await login.login(who.username, who.password);
  return { page, close: () => context.close() };
}

test.describe("Write actions follow the caller's permissions (#2368)", () => {
  const stamp = Date.now().toString(36);
  let projectId: string;
  let admin: APIRequestContext | undefined;

  test.beforeAll(async () => {
    const login = await request.newContext({ baseURL: apiBase() });
    const res = await login.post("/api/auth/login", {
      data: { username: ADMIN_USER.username, password: ADMIN_USER.password },
    });
    expect(res.status(), await res.text()).toBe(200);
    const { accessToken } = (await res.json()).data as { accessToken: string };
    await login.dispose();
    admin = await request.newContext({
      baseURL: apiBase(),
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    // No workspace, so every role can read it without an invitation.
    const created = await admin.post("/api/projects", {
      data: { name: `write-gates-${stamp}`, slug: `write-gates-${stamp}` },
    });
    expect(created.status(), await created.text()).toBe(201);
    projectId = (await created.json()).data.id as string;
  });

  test.afterAll(async () => {
    if (admin && projectId) {
      const res = await admin.delete(`/api/projects/${projectId}`);
      expect([200, 204, 404], await res.text()).toContain(res.status());
    }
    await admin?.dispose();
  });

  test("a developer is offered no New project and no connector add forms", async ({ browser }) => {
    const { page, close } = await signedIn(browser, DEVELOPER);
    try {
      const projects = new ProjectsPage(page);
      await projects.goto();
      await expect(projects.list).toBeVisible();
      await expect(projects.createForbidden).toBeVisible();
      await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);

      const connections = new ConnectionsPage(page);
      await connections.goto(projectId);
      await expect(connections.repoForbidden).toBeVisible();
      await expect(connections.dbForbidden).toBeVisible();
      await expect(connections.addRepoButton).toHaveCount(0);
      await expect(connections.addDbButton).toHaveCount(0);
      await expect(connections.repoSecretInput).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test("a coordinator is offered New project but no project Delete", async ({ browser }) => {
    const { page, close } = await signedIn(browser, COORDINATOR);
    try {
      const projects = new ProjectsPage(page);
      await projects.goto();
      await expect(projects.list).toBeVisible();
      await expect(projects.newProjectButton).toBeEnabled();
      await expect(projects.projectActions).toHaveCount(0);
    } finally {
      await close();
    }
  });

  test("an admin is offered all three", async ({ browser }) => {
    const { page, close } = await signedIn(browser, ADMIN_USER);
    try {
      const projects = new ProjectsPage(page);
      await projects.goto();
      await expect(projects.list).toBeVisible();
      await expect(projects.newProjectButton).toBeEnabled();
      await expect(projects.projectActions.first()).toBeVisible();
      await expect(projects.createForbidden).toHaveCount(0);

      const connections = new ConnectionsPage(page);
      await connections.goto(projectId);
      await expect(connections.addRepoButton).toBeVisible();
      await expect(connections.addDbButton).toBeVisible();
      await expect(connections.repoForbidden).toHaveCount(0);
    } finally {
      await close();
    }
  });
});
