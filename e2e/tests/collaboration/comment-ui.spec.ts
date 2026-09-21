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

  test.beforeAll(async () => {
    const primed = await primeAdminUser(API_BASE);
    // Prime the coordinator row too so the @mention search can resolve it.
    const ctx = await request.newContext({ baseURL: API_BASE });
    await ctx.post("/api/auth/login", {
      data: { username: COORDINATOR.username, password: COORDINATOR.password },
    });
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
