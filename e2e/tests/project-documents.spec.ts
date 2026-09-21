/**
 * Coverage — Project Documents management page (N3 #141).
 *
 *   /projects/[id]/documents
 *
 * A fresh project has no documents, so the page renders its three "Add
 * documents" affordances (file uploader dropzone, URL ingest form, paste-text
 * form) and the "No documents yet." empty state. The spec asserts the header,
 * each add-document affordance, and the empty state — driven by a 200 documents
 * list (NOT a masked /api/api/ 404).
 *
 * Acceptance criteria:
 *   AC: the Documents heading + "Add documents" section render.
 *   AC: the upload dropzone, URL-ingest form, and text-ingest form render.
 *   AC: a fresh project shows the "No documents yet." empty state from a 200.
 *   AC: no /api/api/ double-prefixed request is issued.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi, type CreatedProject } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";
import { ProjectDocumentsPage } from "../pages/project-documents.page.js";

const API_BASE = apiBase();

test.describe("Project Documents (#141)", () => {
  test.describe.configure({ timeout: 120_000 });

  let project: CreatedProject;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    project = await createProjectViaApi(API_BASE, accessToken, "e2e-docs");

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("renders add-document affordances + the empty state from a 200", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const docs = new ProjectDocumentsPage(page);

    const docsResponse = page.waitForResponse(
      (res) =>
        new RegExp(`/api/projects/${project.id}/documents(\\?|$)`).test(res.url()) &&
        res.request().method() === "GET",
      { timeout: 30_000 },
    );

    await docs.goto(project.id);

    await test.step("heading + Add documents section render", async () => {
      await docs.expectLoaded();
      await expect(docs.addHeading).toBeVisible();
    });

    await test.step("the three add-document affordances render", async () => {
      await expect(docs.uploadDropzone()).toBeVisible();
      await expect(docs.urlIngestForm()).toBeVisible();
      await expect(docs.textIngestForm()).toBeVisible();
    });

    await test.step("the documents list query returns 200 (not a masked 404)", async () => {
      const res = await docsResponse;
      expect(res.status(), `GET ${res.url()} should not 404`).toBe(200);
      expect(res.url()).not.toContain("/api/api/");
    });

    await test.step("a fresh project shows the empty state", async () => {
      await expect(docs.emptyState()).toBeVisible({ timeout: 20_000 });
      await expect(docs.documentList()).toHaveCount(0);
    });

    guard.assertClean();
  });
});
