/**
 * #1318 — a live comment @mention notification says who mentioned you and
 * where, quotes the comment, and opens the requirement's comment thread.
 *
 * It used to read "You were mentioned in comment <id>" and link to
 * `/comments/<id>`, which has no page.
 *
 * The coordinator owns the project (a non-admin can open only projects they
 * created), is signed in in the browser, and the admin posts the mention over
 * the API. The coordinator's socket is confirmed authenticated before the post,
 * so the item the drawer shows is the live event, not the history re-read.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  REQUESTER,
  REVIEWER,
  authedApi,
  createProject,
  e2eDatabaseUrl,
  primeUser,
  seedCompletedAnalysis,
} from "../../fixtures/review-helpers.js";
import { seedRequirementViaCli } from "../../fixtures/seed-helpers.js";
import { LoginPage } from "../../pages/login.page.js";
import { NotificationsDrawerPage } from "../../pages/notifications-drawer.page.js";
import { CommentPanelPage } from "../../pages/CommentPanel.page.js";

/** The title `e2e-seed-requirement.ts` gives the seeded requirement. */
const REQUIREMENT_TITLE = "E2E seeded — full-flow drafts can be generated";

test.describe("#1318 — live comment mention notification", () => {
  let adminApi: APIRequestContext;
  let coordinatorApi: APIRequestContext;
  let projectId: string;
  let requirementId: string;

  test.beforeAll(async () => {
    const [admin, coordinator] = await Promise.all([primeUser(REQUESTER), primeUser(REVIEWER)]);
    adminApi = await authedApi(admin.accessToken);
    coordinatorApi = await authedApi(coordinator.accessToken);
    projectId = await createProject(coordinatorApi, "mention-1318");
    const analysisId = await seedCompletedAnalysis(coordinatorApi, projectId);
    requirementId = seedRequirementViaCli({
      projectId,
      analysisId,
      databaseUrl: e2eDatabaseUrl(),
    });
  });

  test.afterAll(async () => {
    await Promise.all([adminApi?.dispose(), coordinatorApi?.dispose()]);
  });

  test("names the author and requirement, quotes the comment, and opens its thread", async ({
    page,
  }) => {
    const body = `@${REVIEWER.username} can you check the lockout threshold ${Date.now()}?`;

    await test.step("the coordinator signs in and their socket is authenticated", async () => {
      // Registered before sign-in: the socket connects as the app shell mounts.
      const socketReady = page
        .waitForEvent("websocket", (ws) => ws.url().includes("/socket.io"))
        .then((ws) =>
          ws.waitForEvent("framereceived", {
            predicate: (f) => String(f.payload).includes("auth:ok"),
            timeout: 30_000,
          }),
        );
      const login = new LoginPage(page);
      await login.goto();
      await login.login(REVIEWER.username, REVIEWER.password);
      await socketReady;
    });

    const drawer = new NotificationsDrawerPage(page);
    // Opened before the mention is posted, so the item can only arrive live.
    await drawer.open();

    await test.step("the admin mentions the coordinator on the requirement", async () => {
      const res = await adminApi.post(`/api/requirements/${requirementId}/comments`, {
        data: { body, title: "Lockout question" },
      });
      expect(res.status(), await res.text()).toBe(201);
    });

    // The coordinator is shared with other specs, so find this item by its
    // unique excerpt rather than by position or unread count.
    const item = drawer.item(`“${body}”`);

    await test.step("the drawer shows who, where and an excerpt — once", async () => {
      await expect(item).toHaveCount(1, { timeout: 15_000 });
      await expect(item).toContainText(`System Admin mentioned you on "${REQUIREMENT_TITLE}"`);
      await expect(item).not.toContainText("mentioned in comment");
      await expect(drawer.openLink(item)).toHaveAttribute(
        "href",
        new RegExp(
          `^/projects/${projectId}/analysis\\?analysisId=[^&]+&requirementId=${requirementId}&comments=1$`,
        ),
      );
    });

    await test.step("Open → lands on the requirement with its comment thread open", async () => {
      await drawer.openLink(item).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/analysis\\?`));
      const panel = new CommentPanelPage(page);
      await panel.waitForOpen();
      await expect(panel.panel).toContainText(body);
    });
  });
});
