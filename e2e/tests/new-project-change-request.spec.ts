/**
 * #2349 — one project-creation flow that ends at "New change request".
 *
 * | Criterion (#2349)                                                          | Test |
 * |-----------------------------------------------------------------------------|------|
 * | "New project" opens the same wizard … whether it is the first or the tenth   | a later project is made through the wizard from the Projects list |
 * | The last step offers "New change request" … skipping lands on the Overview  | New change request opens the run page's start form; Skip opens the Overview |
 * | An analyst with only documents completes it without being asked for more    | the documents-only path fills in nothing but a name |
 *
 * A project is created over the API first, so the one made in the browser is
 * never the user's first: the case the old Projects-list form used to handle.
 */
import { test, expect } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectsPage } from "../pages/project.page.js";

const API_BASE = apiBase();

test.describe("New project → New change request (#2349)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    await createProjectViaApi(API_BASE, accessToken, "e2e-first");
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("a later project, documents only, starts its first change request", async ({ page }) => {
    const slug = `e2e-cr-${Date.now()}`;
    const projects = new ProjectsPage(page);

    await test.step("the Projects list opens the wizard, not a separate form", async () => {
      await projects.goto();
      await projects.startProject(`Change Request ${slug}`, slug);
      await expect(projects.wizard.getByLabel("Documents only")).toBeChecked();
      await expect(projects.repoOwnerInput).toBeHidden();
    });

    await test.step("documents only: nothing else is asked for", async () => {
      await projects.nextButton.click();
      await expect(page.getByTestId("wizard-summary")).toContainText("Documents only");
      await projects.createButton.click();
      await expect(page.getByTestId("wizard-next-step")).toContainText(
        `Change Request ${slug} is created.`,
        { timeout: 15_000 },
      );
    });

    await test.step("New change request opens where the documents are uploaded", async () => {
      await projects.newChangeRequestButton.click();
      await expect(page).toHaveURL(/\/projects\/[^/]+\/analysis$/, { timeout: 15_000 });
      await expect(projects.wizard).toBeHidden();
      // A project with no runs opens on the start form, with its document upload.
      await expect(
        page.getByRole("heading", { name: "New change request", exact: true }),
      ).toBeVisible({ timeout: 20_000 });
    });
  });

  test("skipping the last step lands on the new project's Overview", async ({ page }) => {
    const slug = `e2e-skip-${Date.now()}`;
    const projects = new ProjectsPage(page);
    await projects.goto();
    await projects.createProject(`Skip ${slug}`, slug);
    await expect(page.getByTestId("project-checklist")).toBeVisible({ timeout: 20_000 });
  });
});
