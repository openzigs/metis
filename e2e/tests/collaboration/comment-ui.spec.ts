/**
 * Epic #34 — Comment panel + @mention browser flow (AC1).
 *
 * Acceptance criteria covered:
 *   AC1: Given a user has read access, when they post a comment with
 *        `@username`, the mention is resolved (autocomplete) and the comment
 *        is persisted + visible. This spec drives the real browser path:
 *        open the CommentPanel, type a comment, trigger @mention autocomplete,
 *        select the suggestion, post, and assert the comment renders.
 *
 * Mount point: the collaboration components were wired onto the spec-kit page
 * (ui/.../projects/[id]/spec-kit/page.tsx, commit 38265fb). The spec-kit
 * artifact route is the most reliably-rendered comment surface (no analysis
 * run required), so it is used to exercise the shared CommentPanel +
 * MentionInput components end-to-end.
 *
 * The API-layer fan-out / mention-row persistence (AC1 server contract) is
 * covered separately in two-user-comment.spec.ts.
 *
 * Requires a running stack (E2E_SKIP_WEBSERVER unset or stack pre-booted).
 * NOTE: this browser spec is NOT run in CI — it needs a live UI + API stack.
 */
import { test, expect, request } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../../fixtures/seed-user.js";
import { apiBase } from "../../fixtures/api-base.js";
import { createProjectViaApi } from "../../fixtures/project-helpers.js";
import { LoginPage } from "../../pages/login.page.js";
import { SpecKitPage } from "../../pages/SpecKit.page.js";
import { CommentPanelPage } from "../../pages/CommentPanel.page.js";

const API_BASE = apiBase();
const COORDINATOR = { username: "coordinator", password: "password" };

test.describe("Epic #34 — Comment panel + @mention (AC1, browser)", () => {
  let projectId: string;
  /** The coordinator's access token: the second user of the #997 test. */
  let coordinatorToken: string;

  test.beforeAll(async () => {
    const primed = await primeAdminUser(API_BASE);
    // Prime the coordinator row too so the @mention search can resolve it.
    const ctx = await request.newContext({ baseURL: API_BASE });
    const login = await ctx.post("/api/auth/login", {
      data: { username: COORDINATOR.username, password: COORDINATOR.password },
    });
    expect(login.status(), await login.text()).toBe(200);
    coordinatorToken = ((await login.json()) as { data: { accessToken: string } }).data.accessToken;
    await ctx.dispose();

    const project = await createProjectViaApi(API_BASE, primed.accessToken, "e2e-comment-ui");
    projectId = project.id;
  });

  test("AC1: posts a comment on a spec-kit artifact and sees it rendered", async ({ page }) => {
    const login = new LoginPage(page);
    await login.loginAsAdmin();

    const specKit = new SpecKitPage(page);
    await specKit.goto(projectId);
    await specKit.openComments();

    const panel = new CommentPanelPage(page);
    await panel.waitForOpen();
    await expect(panel.emptyState).toBeVisible();

    const body = `Plain comment from ${ADMIN_USER.username}`;
    await panel.postComment(body);

    // The new comment should appear in the thread list.
    await expect(panel.commentBubble(body)).toBeVisible({ timeout: 10_000 });
  });

  test("AC1: @mention autocomplete inserts @coordinator and the comment posts", async ({
    page,
  }) => {
    const login = new LoginPage(page);
    await login.loginAsAdmin();

    const specKit = new SpecKitPage(page);
    await specKit.goto(projectId);
    await specKit.openComments();

    const panel = new CommentPanelPage(page);
    await panel.waitForOpen();

    // Trigger the @mention dropdown and select the coordinator suggestion.
    await panel.mentionUser(COORDINATOR.username);

    // Finish the comment and post it.
    await panel.newBodyInput.pressSequentially("please review this artifact", { delay: 10 });
    await expect(panel.submitButton).toBeEnabled();
    await panel.submitButton.click();
    await expect(panel.newBodyInput).toHaveValue("", { timeout: 10_000 });

    // The posted comment carries the resolved @coordinator mention.
    await expect(panel.commentBubble(`@${COORDINATOR.username}`)).toBeVisible({ timeout: 10_000 });
  });

  // #997 — another user's reply appears in the open panel without a reload.
  // Before the fix the thread kept the first list it was shown, so the
  // coordinator's reply appeared only after a full page reload.
  test("#997: the coordinator's reply appears in the admin's open panel live", async ({ page }) => {
    // The project is the COORDINATOR's, so both users can open it: the
    // coordinator as its creator, the admin through the admin bypass. A
    // project the admin created is not one the coordinator may reach.
    const coordProject = await createProjectViaApi(API_BASE, coordinatorToken, "e2e-997");

    const login = new LoginPage(page);
    await login.loginAsAdmin();

    const specKit = new SpecKitPage(page);
    await specKit.goto(coordProject.id);
    await specKit.openComments();

    const panel = new CommentPanelPage(page);
    await panel.waitForOpen();

    const opening = `Thread opened in the browser ${Date.now()}`;
    const created = page.waitForResponse(
      (res) => res.request().method() === "POST" && /\/comments$/.test(new URL(res.url()).pathname),
    );
    await panel.postComment(opening);
    const thread = (
      (await (await created).json()) as {
        data: { id: string; comments: Array<{ authorId: string }> };
      }
    ).data;
    const threadId = thread.id;
    const adminId = thread.comments[0].authorId;
    await expect(panel.commentBubble(opening)).toBeVisible({ timeout: 10_000 });

    const reply = `Reply from the coordinator ${Date.now()}`;
    const coordinator = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${coordinatorToken}` },
    });
    try {
      const res = await coordinator.post(`/api/comments/${threadId}/replies`, {
        data: { body: reply },
      });
      expect(res.status(), await res.text()).toBe(201);
      // A different user wrote it: the case the issue reported.
      expect(((await res.json()) as { data: { authorId: string } }).data.authorId).not.toBe(
        adminId,
      );
    } finally {
      await coordinator.dispose();
    }

    // No reload: the push re-reads the thread list and the thread adopts it.
    await expect(panel.commentBubble(reply)).toBeVisible({ timeout: 10_000 });
  });

  test("AC1: the comment panel can be opened and closed", async ({ page }) => {
    const login = new LoginPage(page);
    await login.loginAsAdmin();

    const specKit = new SpecKitPage(page);
    await specKit.goto(projectId);

    const panel = new CommentPanelPage(page);
    await specKit.openComments();
    await panel.waitForOpen();
    await panel.close();
  });
});
