/**
 * #405 — Library → Agents is the one home for custom agents (#31 retired
 * `/settings/agents`), so it must offer what that page did: start creating an
 * agent, and delete one. This restores the coverage `custom-agents-settings.spec.ts`
 * held (the list loads from a single-prefixed 200, never `/api/api/`) against
 * the Library page, and drives the delete end to end against the real API —
 * no route stubs, so the server's own workspace-admin check decides.
 *
 * Acceptance criteria:
 *   AC: GET /api/custom-agents?projectId=…&includeBuiltIns=1 returns 200 and no
 *       /api/api/ request is issued.
 *   AC: New agent links to the authoring wizard for the project's workspace.
 *   AC: Delete asks first; Cancel keeps the agent; confirming DELETEs it (204)
 *       and the row leaves the list.
 */
import { test, expect, request } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { CustomAgentsEnablementSection } from "../pages/custom-agents.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

interface Seeded {
  workspaceId: string;
  projectId: string;
  agentId: string;
  agentName: string;
}

/** A fresh workspace (the admin owns it), a project in it, and one custom agent. */
async function seed(token: string): Promise<Seeded> {
  const api = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const ws = await api.post("/api/workspaces", {
      data: { name: `CA405 WS ${stamp}`, slug: `ca405-ws-${stamp}` },
    });
    expect(ws.status()).toBe(201);
    const workspaceId = ((await ws.json()) as { data: { id: string } }).data.id;

    const proj = await api.post("/api/projects", {
      data: { name: `CA405 Project ${stamp}`, slug: `ca405-project-${stamp}`, workspaceId },
    });
    expect([200, 201]).toContain(proj.status());
    const projBody = (await proj.json()) as {
      data?: { id?: string; project?: { id?: string } };
    };
    const projectId = projBody.data?.id ?? projBody.data?.project?.id;
    if (!projectId) throw new Error(`Malformed project response: ${JSON.stringify(projBody)}`);

    const agentName = `CA405 Agent ${stamp}`;
    const agent = await api.post("/api/custom-agents", {
      data: { projectId, name: agentName, systemPrompt: "You review requirements." },
    });
    expect(agent.status(), await agent.text()).toBe(201);
    const agentId = ((await agent.json()) as { data: { id: string } }).data.id;

    return { workspaceId, projectId, agentId, agentName };
  } finally {
    await api.dispose();
  }
}

test.describe("Library → Agents — create and delete custom agents (#405)", () => {
  test.describe.configure({ timeout: 120_000 });

  let seeded: Seeded;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    seeded = await seed(primed.accessToken);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("lists the project's agents from a single-prefixed 200", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const listResponse = page.waitForResponse(
      (res) =>
        /\/api\/custom-agents\?/.test(res.url()) &&
        res.url().includes(`projectId=${seeded.projectId}`) &&
        res.request().method() === "GET",
      { timeout: 30_000 },
    );

    const section = new CustomAgentsEnablementSection(page);
    await section.goto(seeded.projectId);

    const res = await listResponse;
    expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
    expect(res.url()).not.toContain("/api/api/");
    await expect(section.row(seeded.agentId)).toContainText(seeded.agentName);

    guard.assertClean();
  });

  test("New agent opens the authoring wizard for the project's workspace", async ({ page }) => {
    const section = new CustomAgentsEnablementSection(page);
    await section.goto(seeded.projectId);

    await expect(section.newAgentLink).toHaveAttribute(
      "href",
      `/workspaces/${seeded.workspaceId}/agents/new`,
    );
    await section.newAgentLink.click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seeded.workspaceId}/agents/new$`));
    await expect(page.getByTestId("agent-wizard-root")).toBeVisible({ timeout: 15_000 });
  });

  test("Delete asks first, and deletes only on confirm", async ({ page }) => {
    const section = new CustomAgentsEnablementSection(page);
    await section.goto(seeded.projectId);
    await expect(section.row(seeded.agentId)).toBeVisible();

    await test.step("Cancel keeps the agent", async () => {
      await section.deleteButton(seeded.agentId).click();
      await expect(section.confirmDialog).toContainText(`Delete agent ${seeded.agentName}?`);
      await section.confirmDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(section.confirmDialog).toBeHidden();
      await expect(section.row(seeded.agentId)).toBeVisible();
    });

    await test.step("Confirm deletes it and the list refreshes", async () => {
      const deleted = page.waitForResponse(
        (res) =>
          res.url().endsWith(`/api/custom-agents/${seeded.agentId}`) &&
          res.request().method() === "DELETE",
      );
      await section.deleteButton(seeded.agentId).click();
      await section.confirmDialog.getByRole("button", { name: "Delete" }).click();
      expect((await deleted).status()).toBe(204);
      await expect(section.row(seeded.agentId)).toHaveCount(0);
    });
  });
});
