/**
 * Coverage — Scan-triage detail view (Epic #708 / #719).
 *
 *   /projects/[id]/scans/[scanId]
 *
 * Standing up a real scan requires a connected repo plus an indexed code
 * graph (and would enqueue a live scanner job), which is out of scope for a
 * route-coverage spec. Instead this asserts the route mounts and renders its
 * static shell (header, back link, triage card) and that an unknown scan id is
 * handled GRACEFULLY: the findings query 404s ("Scan not found") and the page
 * renders that as an inline alert inside the triage card — never a blank screen
 * or an unhandled exception — with no /api/api/ double prefix.
 *
 * Acceptance criteria:
 *   AC: the "Scan triage" heading + back link render.
 *   AC: the triage card renders.
 *   AC: an unknown scan id surfaces the 404 ("Scan not found") as an inline
 *       alert rather than crashing the page.
 *   AC: the findings request resolves with a 4xx (not a /api/api/ 404) and no
 *       double-prefixed request is issued.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi, type CreatedProject } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";
import { ScanTriagePage } from "../pages/scan-triage.page.js";

const API_BASE = apiBase();

test.describe("Scan triage detail (#719)", () => {
  test.describe.configure({ timeout: 120_000 });

  let project: CreatedProject;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    project = await createProjectViaApi(API_BASE, accessToken, "e2e-scan");

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders shell + handles an unknown scan id gracefully", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const triage = new ScanTriagePage(page);
    const unknownScanId = "00000000-0000-0000-0000-000000000000";

    // Arm the findings query listener before navigating.
    const findingsResponse = page.waitForResponse(
      (res) =>
        new RegExp(`/api/projects/${project.id}/scans/${unknownScanId}/findings(\\?|$)`).test(
          res.url(),
        ) && res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await triage.goto(project.id, unknownScanId);

    await test.step("header, back link, and triage card render", async () => {
      await triage.expectLoaded();
      await expect(triage.backLink).toBeVisible();
      await expect(triage.card).toBeVisible();
    });

    await test.step("the findings query 404s on the single-prefix path", async () => {
      const res = await findingsResponse;
      expect(res.url()).not.toContain("/api/api/");
      expect(res.status(), `GET ${res.url()} should be a handled 404`).toBe(404);
    });

    await test.step("the 404 is surfaced as an inline alert, not a crash", async () => {
      await expect(triage.errorAlert()).toBeVisible({ timeout: 20_000 });
      await expect(triage.errorAlert()).toContainText(/Scan not found/i);
    });

    guard.assertClean();
  });
});
