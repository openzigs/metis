/**
 * Coverage — Bug-scanner rule-sets editor (Epic #708 / #718).
 *
 *   /projects/[id]/rule-sets
 *
 * A fresh project has no rule sets, so the page renders its "No rule sets yet"
 * empty state from a 200 list query. The create-set card is the primary
 * affordance: typing a name enables Create, and submitting issues
 * `POST /api/projects/:id/rule-sets` (201) after which the new set's card
 * renders. The list query must never 404 or double-prefix.
 *
 * Acceptance criteria:
 *   AC: the rule-sets heading + create-set card render.
 *   AC: a fresh project shows the "No rule sets yet" empty state from a 200.
 *   AC: the Create button is disabled until a name is entered.
 *   AC: creating a rule set POSTs successfully and the new set card renders.
 *   AC: no /api/api/ double-prefixed request is issued.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi, type CreatedProject } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";
import { ScannerRuleSetsPage } from "../pages/scanner-rule-sets.page.js";

const API_BASE = apiBase();

test.describe("Scanner rule sets (#718)", () => {
  test.describe.configure({ timeout: 120_000 });

  let project: CreatedProject;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    project = await createProjectViaApi(API_BASE, accessToken, "e2e-rulesets");

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders editor, empty state, and creates a rule set", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const rs = new ScannerRuleSetsPage(page);

    const listResponse = page.waitForResponse(
      (res) =>
        new RegExp(`/api/projects/${project.id}/rule-sets(\\?|$)`).test(res.url()) &&
        res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await rs.goto(project.id);

    await test.step("heading + create-set card render", async () => {
      await rs.expectLoaded();
      await expect(rs.createCard).toBeVisible();
      await expect(rs.newSetName).toBeVisible();
    });

    await test.step("the list query returns 200 (not a masked 404)", async () => {
      const res = await listResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("a fresh project shows the empty state", async () => {
      await expect(rs.noSets).toBeVisible({ timeout: 20_000 });
    });

    await test.step("Create is disabled until a name is entered", async () => {
      await expect(rs.newSetSubmit).toBeDisabled();
      await rs.newSetName.fill("Injection rules");
      await expect(rs.newSetSubmit).toBeEnabled();
    });

    await test.step("creating a rule set POSTs 201 and renders its card", async () => {
      const createResponse = page.waitForResponse(
        (res) =>
          new RegExp(`/api/projects/${project.id}/rule-sets(\\?|$)`).test(res.url()) &&
          res.request().method() === "POST",
        { timeout: 30_000 },
      );
      await rs.newSetSubmit.click();
      const res = await createResponse;
      expect(res.status(), `POST ${res.url()} should create the set`).toBe(201);
      const body = (await res.json()) as { success: boolean; data: { id: string; name: string } };
      expect(body.success).toBe(true);
      expect(body.data.name).toBe("Injection rules");
      await expect(rs.setCard(body.data.id)).toBeVisible({ timeout: 20_000 });
      await expect(rs.setCard(body.data.id)).toContainText("Injection rules");
    });

    guard.assertClean();
  });
});
