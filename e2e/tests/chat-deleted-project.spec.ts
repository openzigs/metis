/**
 * #1412 — a chat in a project an administrator deletes.
 *
 * Owner decision (2026-10-23): a chat session in a soft-deleted project is
 * closed to non-admins on every path, with the same "not found" as a chat that
 * does not exist; an administrator keeps full access.
 *
 * Acceptance criteria covered:
 *   AC1: a non-admin who had a chat in a project can open it; once an admin
 *        deletes the project, opening that chat's link shows "Chat not found"
 *        and none of its messages.
 *   AC2: an admin's own chat in the same deleted project still opens, with its
 *        messages.
 *
 * Setup goes through the API (the project, each user's chat and one turn in
 * it): what is under test is what each user sees in the browser afterwards.
 * The project has no workspace, so the developer can reach it while it is live
 * without a workspace invitation; the server suite covers workspace projects
 * (`server/tests/chat-session-deleted-project-1412.sqlite.test.ts`).
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ChatSessionPage } from "../pages/chat-session.page.js";

const API_BASE = apiBase();
/** A non-admin mock-auth user (`server/src/lib/auth/mock-provider.ts`). */
const DEVELOPER = { username: "developer", password: "password" };

async function apiAs(username: string, password: string): Promise<APIRequestContext> {
  const login = await request.newContext({ baseURL: API_BASE });
  const res = await login.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login ${username}: ${await res.text()}`).toBe(200);
  const { accessToken } = (await res.json()).data as { accessToken: string };
  await login.dispose();
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

/** A chat in `projectId` with one answered turn; returns its session id. */
async function chatWithOneTurn(
  api: APIRequestContext,
  projectId: string,
  message: string,
): Promise<string> {
  const created = await api.post("/api/ai/sessions", { data: { projectId } });
  expect(created.status(), await created.text()).toBe(201);
  const session = (await created.json()).data.session as { id: string; projectId: string };
  expect(session.projectId).toBe(projectId);
  const turn = await api.post("/api/ai/chat", { data: { sessionId: session.id, message } });
  expect(turn.status(), await turn.text()).toBe(200);
  return session.id;
}

test.describe("Chat in a deleted project (#1412)", () => {
  const stamp = Date.now();
  const devMessage = `Developer question before the delete ${stamp}`;
  const adminMessage = `Admin question before the delete ${stamp}`;
  let adminApi: APIRequestContext;
  let devApi: APIRequestContext;
  let projectId: string;
  let devSession: string;
  let adminSession: string;

  test.beforeAll(async () => {
    adminApi = await apiAs(ADMIN_USER.username, ADMIN_USER.password);
    devApi = await apiAs(DEVELOPER.username, DEVELOPER.password);
    const res = await adminApi.post("/api/projects", {
      data: { name: `chat-deleted-${stamp}`, slug: `chat-deleted-${stamp}` },
    });
    expect(res.status(), await res.text()).toBe(201);
    projectId = (await res.json()).data.id as string;
    devSession = await chatWithOneTurn(devApi, projectId, devMessage);
    adminSession = await chatWithOneTurn(adminApi, projectId, adminMessage);
  });

  test.afterAll(async () => {
    await adminApi?.dispose();
    await devApi?.dispose();
  });

  test("a non-admin's chat opens until the project is deleted, then reads 'Chat not found'; the admin's still opens", async ({
    page,
    browser,
  }) => {
    const login = new LoginPage(page);
    const chat = new ChatSessionPage(page);

    await test.step("the developer opens their chat while the project is live", async () => {
      await login.goto();
      await login.login(DEVELOPER.username, DEVELOPER.password);
      await chat.open(devSession);
      await expect(chat.message(devMessage)).toBeVisible();
      await expect(chat.notFound).toHaveCount(0);
    });

    await test.step("an admin deletes the project", async () => {
      const res = await adminApi.delete(`/api/projects/${projectId}`);
      expect(res.status(), await res.text()).toBe(204);
    });

    await test.step("the developer's link to that chat now reads 'Chat not found'", async () => {
      await chat.open(devSession);
      await expect(chat.notFound).toBeVisible();
      await expect(chat.message(devMessage)).toHaveCount(0);
    });

    await test.step("the admin still opens their own chat in the deleted project", async () => {
      const adminContext = await browser.newContext();
      try {
        const adminPage = await adminContext.newPage();
        const adminLogin = new LoginPage(adminPage);
        await adminLogin.goto();
        await adminLogin.login(ADMIN_USER.username, ADMIN_USER.password);
        const adminChat = new ChatSessionPage(adminPage);
        await adminChat.open(adminSession);
        await expect(adminChat.message(adminMessage)).toBeVisible();
        await expect(adminChat.notFound).toHaveCount(0);
      } finally {
        await adminContext.close();
      }
    });
  });
});
