/**
 * Document upload — new format support (DOCX, XLSX, PPTX).
 *
 * Verifies that the upload pipeline on `/projects/[id]` accepts and
 * processes the new file formats added in epic #239:
 *   - #243: DOCX → Markdown
 *   - #245: XLSX → Markdown
 *   - #246: PPTX → Markdown
 *
 * Each test uploads a minimal valid fixture file through the real
 * DocumentUploader component and verifies the upload queue reports
 * success and the document appears in the document list.
 *
 * Acceptance criteria tested:
 *   AC: DOCX files can be uploaded and processed to Markdown
 *   AC: XLSX files can be uploaded and processed to Markdown
 *   AC: PPTX files can be uploaded and processed to Markdown
 *   AC: PDF upload still works (regression check)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectDetailPage } from "../pages/project.page.js";
import { apiBase } from "../fixtures/api-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures");

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Document upload — new formats (#239)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const slug = `e2e-upload-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: { name: `Upload Test ${slug}`, slug, description: "upload e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { success: boolean; data: { id: string } };
    projectId = body.data.id;
    await api.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC: PDF upload still works (regression check, #244)
  test("should upload PDF and show in document list", async ({ page }) => {
    const detail = new ProjectDetailPage(page);
    await detail.gotoDocuments(projectId);

    await test.step("Upload sample.pdf", async () => {
      await detail.uploadFiles([path.join(FIXTURES_DIR, "sample.pdf")]);
    });

    await test.step("Verify upload completed", async () => {
      await expect(page.getByTestId("upload-status-done")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Verify document appears in list", async () => {
      await detail.expectDocumentNames(["sample.pdf"]);
    });
  });

  // AC: DOCX files can be uploaded and processed to Markdown (#243)
  test("should upload DOCX and show in document list", async ({ page }) => {
    const detail = new ProjectDetailPage(page);
    await detail.gotoDocuments(projectId);

    await test.step("Upload sample.docx", async () => {
      await detail.uploadFiles([path.join(FIXTURES_DIR, "sample.docx")]);
    });

    await test.step("Verify upload completed", async () => {
      await expect(page.getByTestId("upload-status-done")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Verify document appears in list", async () => {
      await detail.expectDocumentNames(["sample.docx"]);
    });
  });

  // AC: XLSX files can be uploaded and processed to Markdown (#245)
  test("should upload XLSX and show in document list", async ({ page }) => {
    const detail = new ProjectDetailPage(page);
    await detail.gotoDocuments(projectId);

    await test.step("Upload sample.xlsx", async () => {
      await detail.uploadFiles([path.join(FIXTURES_DIR, "sample.xlsx")]);
    });

    await test.step("Verify upload completed", async () => {
      await expect(page.getByTestId("upload-status-done")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Verify document appears in list", async () => {
      await detail.expectDocumentNames(["sample.xlsx"]);
    });
  });

  // AC: PPTX files can be uploaded and processed to Markdown (#246)
  test("should upload PPTX and show in document list", async ({ page }) => {
    const detail = new ProjectDetailPage(page);
    await detail.gotoDocuments(projectId);

    await test.step("Upload sample.pptx", async () => {
      await detail.uploadFiles([path.join(FIXTURES_DIR, "sample.pptx")]);
    });

    await test.step("Verify upload completed", async () => {
      await expect(page.getByTestId("upload-status-done")).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Verify document appears in list", async () => {
      await detail.expectDocumentNames(["sample.pptx"]);
    });
  });
});
