/**
 * Configurable Issue Templates — Epic #595.
 *
 * End-to-end tests covering the template editor UI (#614),
 * template CRUD operations (#611), and default templates (#612).
 *
 * Acceptance criteria tested (mapped by AC reference):
 *
 * | # | Criterion (source issue)                                      | Test                                         |
 * |---|---------------------------------------------------------------|----------------------------------------------|
 * | 1 | Template editor page at /projects/:id/settings/templates #614 | should navigate to template settings page    |
 * | 2 | List view shows templates with type, platform, default #614   | should display default templates in list     |
 * | 3 | Create form with section config (label, type, required) #614  | should create a new template with sections   |
 * | 4 | Live preview panel with sample data #614                      | should show live preview while creating      |
 * | 5 | Preview toggle between GitHub and Jira #614                   | should toggle preview between GitHub/Jira    |
 * | 6 | Clone template button #614                                    | should clone an existing template             |
 * | 7 | Delete template non-default with confirmation #614            | should delete non-default with confirmation  |
 * | 8 | Default templates cannot be deleted #612                      | should not show delete for default templates |
 * | 9 | Default templates shown (GH Epic, GH Feature, Jira Story/Bug) #612 | should seed 4 default templates         |
 * |10 | Templates listed per project #611                             | should list templates via API                |
 * |11 | Create new template via API #611                              | should create template via API               |
 * |12 | Edit existing template #611/#614                              | should edit an existing template             |
 * |13 | Delete non-default template via API #611                      | should delete template via API               |
 * |14 | Accessible / keyboard navigable #614                          | should be keyboard navigable                 |
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { TemplateSettingsPage } from "../pages/template-settings.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Issue Templates — Epic #595", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    // Prime admin user and create an isolated project for each test
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const slug = `e2e-templates-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: {
        name: `Templates Test ${slug}`,
        slug,
        description: "e2e template tests",
      },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { project: { id: string } } };
    projectId = body.data.project.id;
    await api.dispose();

    // Log in through the browser
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // ── AC #1: Template editor page at /projects/:id/settings/templates (#614) ──

  test("should navigate to template settings page", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);

    await test.step("Navigate to template settings", async () => {
      await templatePage.goto(projectId);
    });

    await test.step("Verify page heading is visible", async () => {
      await expect(templatePage.heading).toBeVisible();
      await expect(templatePage.heading).toHaveText("Issue Templates");
    });

    await test.step("Verify New Template button is present", async () => {
      await expect(templatePage.newTemplateButton).toBeVisible();
    });
  });

  // ── AC #9 / #2: Default templates seeded and displayed (#612, #614) ──

  test("should seed and display 4 default templates with type, platform, and default badge", async ({
    page,
  }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);

    await test.step("Wait for templates to load", async () => {
      await templatePage.waitForTemplatesLoaded();
    });

    await test.step("Verify GitHub Epic default template", async () => {
      const card = templatePage.templateCard("GitHub Epic");
      await expect(card).toBeVisible();
      await expect(templatePage.defaultBadge("GitHub Epic")).toBeVisible();
      await expect(templatePage.platformText("GitHub Epic")).toContainText("github");
      await expect(templatePage.typeText("GitHub Epic")).toContainText("epic");
    });

    await test.step("Verify GitHub Feature default template", async () => {
      const card = templatePage.templateCard("GitHub Feature");
      await expect(card).toBeVisible();
      await expect(templatePage.defaultBadge("GitHub Feature")).toBeVisible();
    });

    await test.step("Verify Jira Story default template", async () => {
      const card = templatePage.templateCard("Jira Story");
      await expect(card).toBeVisible();
      await expect(templatePage.defaultBadge("Jira Story")).toBeVisible();
    });

    await test.step("Verify Jira Bug default template", async () => {
      const card = templatePage.templateCard("Jira Bug");
      await expect(card).toBeVisible();
      await expect(templatePage.defaultBadge("Jira Bug")).toBeVisible();
    });

    await test.step("Verify 4 default templates total", async () => {
      const count = await templatePage.templateCards.count();
      expect(count).toBe(4);
    });
  });

  // ── AC #8: Default templates cannot be deleted (#612) ──

  test("should not show delete button for default templates", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    await test.step("Default templates have no Delete button", async () => {
      for (const name of ["GitHub Epic", "GitHub Feature", "Jira Story", "Jira Bug"]) {
        await expect(templatePage.deleteButton(name)).not.toBeVisible();
      }
    });
  });

  // ── AC #3: Create form with section configuration (#614) ──

  test("should create a new template with sections", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    await test.step("Open create form", async () => {
      await templatePage.openCreateForm();
    });

    await test.step("Fill template meta fields", async () => {
      await templatePage.fillTemplateMeta({
        name: "Custom Bug Report",
        platform: "github",
        templateType: "bug",
      });
    });

    await test.step("Configure sections — verify defaults exist", async () => {
      // Form starts with Title + Description sections
      const labelInputs = page.getByLabel("Section label");
      await expect(labelInputs).toHaveCount(2);
    });

    await test.step("Add a new section", async () => {
      await templatePage.addSectionButton.click();
      const labelInputs = page.getByLabel("Section label");
      await expect(labelInputs).toHaveCount(3);
    });

    await test.step("Configure new section fields", async () => {
      // Edit the third section (index 2)
      await templatePage.sectionLabelInput(2).fill("Steps to Reproduce");
      await templatePage.sectionTypeSelect(2).selectOption("checklist");
      await templatePage.sectionPlaceholderInput(2).fill("1. Open the app…");
    });

    await test.step("Save template", async () => {
      await templatePage.save();
      // Should return to list view with the new template
      await expect(templatePage.heading).toBeVisible({ timeout: 15_000 });
      await expect(templatePage.templateCard("Custom Bug Report")).toBeVisible();
    });
  });

  // ── AC #4 / #5: Live preview panel + GitHub/Jira toggle (#614) ──

  test("should show live preview and toggle between GitHub and Jira", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    await test.step("Open create form", async () => {
      await templatePage.openCreateForm();
      await templatePage.fillTemplateMeta({ name: "Preview Test" });
    });

    await test.step("Verify GitHub preview is shown by default", async () => {
      await expect(templatePage.githubPreviewLabel).toBeVisible();
    });

    await test.step("Toggle to Jira preview", async () => {
      await templatePage.jiraToggle.click();
      await expect(templatePage.jiraPreviewLabel).toBeVisible();
      await expect(templatePage.githubPreviewLabel).not.toBeVisible();
    });

    await test.step("Toggle back to GitHub preview", async () => {
      await templatePage.githubToggle.click();
      await expect(templatePage.githubPreviewLabel).toBeVisible();
      await expect(templatePage.jiraPreviewLabel).not.toBeVisible();
    });

    await test.step("Preview updates when sections change", async () => {
      await templatePage.addSectionButton.click();
      await templatePage.sectionLabelInput(2).fill("Evidence");
      // The preview should now contain the new section label
      await expect(page.getByText("## Evidence")).toBeVisible();
    });

    await templatePage.cancelForm();
  });

  // ── AC #6: Clone template button (#614) ──

  test("should clone an existing template", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    const initialCount = await templatePage.templateCards.count();

    await test.step("Clone GitHub Epic template", async () => {
      await templatePage.cloneTemplate("GitHub Epic");
    });

    await test.step("Verify cloned template appears in list", async () => {
      await expect(templatePage.templateCard("GitHub Epic (copy)")).toBeVisible({
        timeout: 15_000,
      });
      const newCount = await templatePage.templateCards.count();
      expect(newCount).toBe(initialCount + 1);
    });

    await test.step("Cloned template is not marked as default", async () => {
      await expect(templatePage.defaultBadge("GitHub Epic (copy)")).not.toBeVisible();
    });
  });

  // ── AC #7: Delete non-default template with confirmation (#614) ──

  test("should delete a non-default template with confirmation dialog", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    // First create a template we can delete
    await test.step("Create a deletable template via API", async () => {
      const api = await authedApi(accessToken);
      await api.post(`/api/projects/${projectId}/templates`, {
        data: {
          name: "Temp Template",
          platform: "github",
          templateType: "task",
          schema: {
            name: "Temp Template",
            platform: "github",
            templateType: "task",
            sections: [{ key: "title", label: "Title", type: "text", required: true }],
          },
        },
      });
      await api.dispose();
      // Reload to see the new template
      await templatePage.goto(projectId);
      await templatePage.waitForTemplatesLoaded();
    });

    await test.step("Verify Delete button is visible for non-default template", async () => {
      await expect(templatePage.deleteButton("Temp Template")).toBeVisible();
    });

    await test.step("Click Delete — confirmation appears", async () => {
      await templatePage.clickDeleteTemplate("Temp Template");
      await expect(templatePage.confirmDeleteButton).toBeVisible();
      await expect(
        templatePage.templateCard("Temp Template").getByRole("button", { name: "Cancel" }),
      ).toBeVisible();
    });

    await test.step("Confirm deletion — template removed from list", async () => {
      await templatePage.confirmDelete();
      await expect(templatePage.templateCard("Temp Template")).not.toBeVisible({
        timeout: 15_000,
      });
    });
  });

  // ── AC #7 (cancel path): Delete confirmation can be cancelled ──

  test("should cancel deletion when Cancel is clicked in confirmation", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    // Create a deletable template via API
    const api = await authedApi(accessToken);
    await api.post(`/api/projects/${projectId}/templates`, {
      data: {
        name: "Keep Me",
        platform: "jira",
        templateType: "story",
        schema: {
          name: "Keep Me",
          platform: "jira",
          templateType: "story",
          sections: [{ key: "title", label: "Title", type: "text", required: true }],
        },
      },
    });
    await api.dispose();
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    await test.step("Click Delete then Cancel", async () => {
      await templatePage.clickDeleteTemplate("Keep Me");
      await expect(templatePage.confirmDeleteButton).toBeVisible();
      await templatePage.cancelDelete();
    });

    await test.step("Template still visible after cancelling", async () => {
      await expect(templatePage.templateCard("Keep Me")).toBeVisible();
    });
  });

  // ── AC #12: Edit existing template (#611/#614) ──

  test("should edit an existing template", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    await test.step("Click Edit on GitHub Epic", async () => {
      await templatePage.editTemplate("GitHub Epic");
      await expect(page.getByRole("heading", { name: /Edit Template/ })).toBeVisible();
    });

    await test.step("Modify template name and save", async () => {
      await templatePage.templateNameInput.fill("GitHub Epic (Modified)");
      await templatePage.save();
    });

    await test.step("Verify changes persisted in list", async () => {
      await expect(templatePage.heading).toBeVisible({ timeout: 15_000 });
      await expect(templatePage.templateCard("GitHub Epic (Modified)")).toBeVisible();
    });
  });

  // ── AC #10 / #11 / #13: Template CRUD via API (#611) ──

  test("should list, create, and delete templates via API", async () => {
    const api = await authedApi(accessToken);

    await test.step("List templates — should have 4 defaults", async () => {
      const res = await api.get(`/api/projects/${projectId}/templates`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Array<{ isDefault: boolean }> };
      expect(body.success).toBe(true);
      expect(body.data.length).toBe(4);
      expect(body.data.every((t) => t.isDefault)).toBe(true);
    });

    let newTemplateId: string;

    await test.step("Create template via API", async () => {
      const res = await api.post(`/api/projects/${projectId}/templates`, {
        data: {
          name: "API Created Template",
          platform: "universal",
          templateType: "task",
          schema: {
            name: "API Created Template",
            platform: "universal",
            templateType: "task",
            sections: [
              { key: "title", label: "Title", type: "text", required: true },
              { key: "body", label: "Body", type: "markdown", required: false },
            ],
          },
        },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as {
        success: boolean;
        data: { id: string; name: string; isDefault: boolean };
      };
      expect(body.data.name).toBe("API Created Template");
      expect(body.data.isDefault).toBe(false);
      newTemplateId = body.data.id;
    });

    await test.step("List templates — now 5 total", async () => {
      const res = await api.get(`/api/projects/${projectId}/templates`);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data.length).toBe(5);
    });

    await test.step("Delete non-default template via API", async () => {
      const res = await api.delete(`/api/projects/${projectId}/templates/${newTemplateId}`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { data: { deleted: boolean } };
      expect(body.data.deleted).toBe(true);
    });

    await test.step("Cannot delete default template via API", async () => {
      // Get a default template id
      const listRes = await api.get(`/api/projects/${projectId}/templates`);
      const list = (await listRes.json()) as {
        data: Array<{ id: string; isDefault: boolean }>;
      };
      const defaultTemplate = list.data.find((t) => t.isDefault);
      expect(defaultTemplate).toBeTruthy();
      const res = await api.delete(`/api/projects/${projectId}/templates/${defaultTemplate!.id}`);
      // Should be rejected (400 or 403)
      expect(res.status()).toBeGreaterThanOrEqual(400);
    });

    await test.step("List templates — back to 4", async () => {
      const res = await api.get(`/api/projects/${projectId}/templates`);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data.length).toBe(4);
    });

    await api.dispose();
  });

  // ── AC #14: Accessible / keyboard navigable (#614) ──

  test("should be keyboard navigable", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();

    await test.step("Tab to New Template button and activate with Enter", async () => {
      // Focus the page body and tab through
      await page.keyboard.press("Tab");
      // Keep tabbing until we reach the New Template button
      for (let i = 0; i < 20; i++) {
        const focused = page.locator(":focus");
        const text = await focused.textContent().catch(() => "");
        if (text?.includes("New Template")) break;
        await page.keyboard.press("Tab");
      }
      await page.keyboard.press("Enter");
      await expect(templatePage.formHeadingCreate).toBeVisible();
    });

    await test.step("Tab through form fields", async () => {
      // Verify we can tab to the template name input
      await templatePage.templateNameInput.focus();
      await expect(templatePage.templateNameInput).toBeFocused();

      // Tab to platform select
      await page.keyboard.press("Tab");
      await expect(templatePage.platformSelect).toBeFocused();

      // Tab to template type select
      await page.keyboard.press("Tab");
      await expect(templatePage.templateTypeSelect).toBeFocused();
    });

    await test.step("Cancel button is keyboard-accessible", async () => {
      await templatePage.cancelButton.focus();
      await expect(templatePage.cancelButton).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(templatePage.heading).toBeVisible();
    });
  });

  // ── AC #3 (section types): Section type select has all 6 types (#614) ──

  test("should offer all 6 section types in the section editor", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();
    await templatePage.openCreateForm();

    await test.step("Verify section type dropdown contains all types", async () => {
      const typeSelect = templatePage.sectionTypeSelect(0);
      const options = typeSelect.locator("option");
      await expect(options).toHaveCount(6);
      for (const type of ["text", "markdown", "checklist", "number", "select", "tags"]) {
        await expect(typeSelect.locator("option", { hasText: type })).toBeVisible();
      }
    });

    await templatePage.cancelForm();
  });

  // ── AC #3 (required toggle): Section required toggle works (#614) ──

  test("should toggle section required checkbox", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();
    await templatePage.openCreateForm();

    await test.step("First section (Title) is required by default", async () => {
      await expect(templatePage.sectionRequiredCheckbox(0)).toBeChecked();
    });

    await test.step("Uncheck required on first section", async () => {
      await templatePage.sectionRequiredCheckbox(0).uncheck();
      await expect(templatePage.sectionRequiredCheckbox(0)).not.toBeChecked();
    });

    await test.step("Re-check required", async () => {
      await templatePage.sectionRequiredCheckbox(0).check();
      await expect(templatePage.sectionRequiredCheckbox(0)).toBeChecked();
    });

    await templatePage.cancelForm();
  });

  // ── AC #3 (placeholder): Section placeholder input works (#614) ──

  test("should accept placeholder text in section editor", async ({ page }) => {
    const templatePage = new TemplateSettingsPage(page);
    await templatePage.goto(projectId);
    await templatePage.waitForTemplatesLoaded();
    await templatePage.openCreateForm();

    await test.step("Fill placeholder and verify value", async () => {
      await templatePage.sectionPlaceholderInput(0).fill("Enter a title…");
      await expect(templatePage.sectionPlaceholderInput(0)).toHaveValue("Enter a title…");
    });

    await templatePage.cancelForm();
  });
});
