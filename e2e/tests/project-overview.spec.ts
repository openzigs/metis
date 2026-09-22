/**
 * Coverage — Project Overview viewer at `/projects/[id]/overview` (Epic #298/#313).
 *
 * Renders the cached `project_overview.md`. A freshly created project has never
 * had its overview generated, so `GET /api/projects/:id/overview` legitimately
 * returns 404 and the page shows its "No overview yet" empty state with a
 * working Regenerate control. (404 here is the documented never-generated
 * signal, NOT the double-prefix bug — so this spec asserts the empty state and
 * the controls, plus that no /api/api/ request is ever issued.)
 *
 * Acceptance criteria:
 *   AC: the overview header renders with the project name.
 *   AC: the Regenerate / Copy / Download controls render.
 *   AC: a never-generated project shows the empty state.
 *   AC: no /api/api/ double-prefixed request is issued.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi, type CreatedProject } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

test.describe("Project Overview viewer (#313)", () => {
  test.describe.configure({ timeout: 120_000 });

  let project: CreatedProject;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    project = await createProjectViaApi(API_BASE, accessToken, "e2e-overview");

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders header, controls and the never-generated empty state", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);

    await page.goto(`/projects/${project.id}/overview`, { waitUntil: "load" });

    await test.step("header renders with the project name", async () => {
      await expect(page.getByTestId("project-overview-page")).toBeVisible();
      await expect(
        // #29 — the code summary is "Code Overview"; "Overview" alone names the landing page.
        page.getByRole("heading", {
          level: 1,
          name: new RegExp(`Code Overview — ${project.name}`),
        }),
      ).toBeVisible({ timeout: 20_000 });
    });

    await test.step("Copy / Download / Regenerate controls render", async () => {
      await expect(page.getByTestId("overview-copy")).toBeVisible();
      await expect(page.getByTestId("overview-download")).toBeVisible();
      await expect(page.getByTestId("overview-regenerate")).toBeVisible();
      await expect(page.getByRole("button", { name: "Regenerate" })).toBeEnabled();
    });

    await test.step("a never-generated project shows the empty state", async () => {
      await expect(page.getByTestId("overview-empty-state")).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "No overview yet" })).toBeVisible();
    });

    guard.assertClean();
  });
});
