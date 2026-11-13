/**
 * E2E — Issue #2350 (epic #2328): chat entry points, history and Advanced,
 * driven by the non-admin analyst the definition of done names (the mock
 * `developer` role).
 *
 * | Acceptance criterion (#2350)                                          | Test                                   |
 * |-----------------------------------------------------------------------|----------------------------------------|
 * | "Ask about this" on a change request opens chat scoped to it          | Ask about this from a change request   |
 * | the scope is visible and can be changed                               | Ask about this from a change request   |
 * | developer controls behind an "Advanced" toggle, off by default        | Ask about this from a change request   |
 * | with Advanced off, chat says which assistant answers in plain words   | Ask about this from a change request   |
 * | an item the user cannot read is refused by the server                 | an item the analyst cannot read        |
 * | `/chat` lists past conversations with title, scope and date; resumes | the history list and /sessions          |
 * | `/sessions` redirects to the list                                     | the history list and /sessions          |
 *
 * The change request and its requirement are seeded through the CLI seam the
 * review suite uses; the analyst names the run through the real rename route.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { apiBase } from "../fixtures/api-base.js";
import { e2eDatabaseUrl, primeUser } from "../fixtures/review-helpers.js";
import { seedGroundedAnalysisViaCli } from "../fixtures/seed-helpers.js";

const API_BASE = apiBase();
/** The non-admin analyst (`server/src/lib/auth/mock-provider.ts`). */
const ANALYST = { username: "developer", password: "password" } as const;

async function apiAs(creds: { username: string; password: string }): Promise<{
  api: APIRequestContext;
  userId: string;
}> {
  const { accessToken, userId } = await primeUser(creds);
  const api = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
  return { api, userId };
}

test.describe("Chat entry points, history and Advanced, as an analyst (#2350)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;
  let projectName: string;

  test.beforeEach(async ({ page }) => {
    // The admin creates the project with no workspace, so it is open to the
    // analyst too; everything after this is the analyst's.
    const { api: admin } = await apiAs({
      username: ADMIN_USER.username,
      password: ADMIN_USER.password,
    });
    const slug = `e2e-chat-entry-${Date.now()}`;
    projectName = `Chat entry ${slug}`;
    const res = await admin.post("/api/projects", {
      data: { name: projectName, slug, description: "chat entry points e2e" },
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await admin.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ANALYST.username, ANALYST.password);
  });

  test("Ask about this from a change request lands in a chat scoped to it", async ({ page }) => {
    // Base 36: a 13-digit stamp can read as a card number to the chat guardrail (#1446).
    const title = `Refund window ${Date.now().toString(36)}`;
    const { api, userId } = await apiAs(ANALYST);
    const analysisId = seedGroundedAnalysisViaCli({
      projectId,
      startedById: userId,
      databaseUrl: e2eDatabaseUrl(),
    });
    const renamed = await api.patch(`/api/projects/${projectId}/analyses/${analysisId}`, {
      data: { title },
    });
    expect(renamed.status(), await renamed.text()).toBe(200);
    await api.dispose();

    await test.step("the change request offers Ask about this", async () => {
      await page.goto(`/projects/${projectId}/analysis?analysisId=${analysisId}`, {
        waitUntil: "load",
      });
      await expect(page.getByTestId("change-request-title")).toHaveText(title, {
        timeout: 30_000,
      });
      await page.getByRole("link", { name: "Ask about this change request in chat" }).click();
    });

    await test.step("chat opens about it, scoped to its project", async () => {
      await expect(page).toHaveURL(/\/chat\?about=change-request%3A/);
      const subject = page.getByTestId("chat-subject");
      await expect(subject).toContainText(`the change request “${title}”`, { timeout: 30_000 });
      await expect(subject).toContainText(`This chat searches ${projectName}`);
      // The scope is on screen, in the selector that changes it.
      await expect(page.getByTestId("project-scope-selector")).toBeEnabled();
      await expect(page.getByLabel("Message")).toHaveValue(
        `What does the change request “${title}” ask for, and what would it affect?`,
      );
    });

    await test.step("the developer controls wait behind Advanced, off by default", async () => {
      const advanced = page.getByRole("switch", { name: "Advanced" });
      await expect(advanced).not.toBeChecked();
      await expect(page.getByTestId("agent-picker")).toHaveCount(0);
      await expect(page.getByRole("complementary", { name: "Session skills" })).toHaveCount(0);
      await expect(page.getByTestId("chat-assistant")).toHaveText(
        "Answering: the METIS assistant, with this project’s settings.",
      );

      await advanced.check();
      await expect(page.getByTestId("agent-picker")).toBeVisible();
      // Remembered for this analyst across a reload.
      await page.reload({ waitUntil: "load" });
      await expect(page.getByRole("switch", { name: "Advanced" })).toBeChecked();
      await page.getByRole("switch", { name: "Advanced" }).uncheck();
      await expect(page.getByTestId("agent-picker")).toHaveCount(0);
    });
  });

  test("an item the analyst cannot read is refused, and scopes nothing", async ({ page }) => {
    await page.goto("/chat?about=change-request%3Ae2e-no-such-change-request", {
      waitUntil: "load",
    });
    await expect(page.getByTestId("chat-subject-refused")).toContainText(
      "You can’t ask about that item",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("chat-subject")).toHaveCount(0);
    await expect(page.getByLabel("Message")).toBeEnabled();
  });

  test("the history list and /sessions", async ({ page }) => {
    const { api } = await apiAs(ANALYST);
    const created = await api.post("/api/ai/sessions", {
      data: { projectId, title: `History ${Date.now().toString(36)}` },
    });
    expect(created.status(), await created.text()).toBe(201);
    const session = (await created.json()).data.session as { id: string; title: string };
    await api.dispose();

    await test.step("/sessions redirects to chat's history", async () => {
      await page.goto("/sessions", { waitUntil: "load" });
      await expect(page).toHaveURL(/\/chat$/);
      await expect(page.getByRole("navigation", { name: "Your conversations" })).toBeVisible();
    });

    await test.step("a row has title, scope and date, and opens the chat", async () => {
      const row = page.getByTestId(`chat-history-${session.id}`);
      await expect(row).toContainText(session.title, { timeout: 30_000 });
      await expect(row).toContainText(projectName);
      await expect(row.locator("time")).toHaveAttribute("datetime", /\d{4}-\d{2}-\d{2}T/);
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/chat\\?sessionId=${session.id}$`));
      await expect(page.getByTestId(`chat-history-${session.id}`)).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  });
});
