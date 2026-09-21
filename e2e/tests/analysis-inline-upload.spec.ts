/**
 * E2E — Analysis-page inline "Add documents" panel (epic #904, issues #906 / #908).
 *
 * Verifies the inline upload capability surfaced inside the "Start a new
 * analysis" Card on `/projects/[id]/analysis`:
 *   - the panel is collapsible (accessible `aria-expanded` toggle),
 *   - paste-text and file ingest add a document that auto-selects once ready,
 *   - the URL field is wired to the ingest API and surfaces errors,
 *   - an in-flight (processing) document surfaces its status and is not
 *     selectable until ready.
 *
 * Acceptance criteria covered (issue #908):
 *   AC1: upload (file/paste/URL) → document appears, auto-selected once ready.
 *   AC2: a still-processing document surfaces its ingest status before it is
 *        selectable/ready.
 *
 * Harness note: the suite boots with `INGEST_QUEUE=off`, so real ingest is
 * synchronous and documents land `ready` immediately. The processing-status
 * case is therefore seeded directly into the DB (see `seedDocumentViaCli`).
 * A successful remote-URL ingest is not deterministically reproducible in the
 * offline, no-outbound-network harness (loopback/private IPs are always
 * SSRF-blocked), so the URL field is exercised via its wired error path.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedDocumentViaCli } from "../fixtures/seed-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures");

const API_BASE = apiBase();

function dbUrl(): string {
  return `file:${
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db")
  }`;
}

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Analysis page — inline Add documents panel (#906 / #908)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let userId: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    userId = primed.userId;

    const slug = `e2e-analysis-upload-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: { name: `Analysis Upload ${slug}`, slug, description: "analysis inline upload e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await api.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC: a collapsed "Add documents" panel is present with an accessible toggle.
  test("Add documents panel toggles with aria-expanded", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("collapsed by default", async () => {
      await expect(analysis.addDocsToggle).toHaveAttribute("aria-expanded", "false");
      await expect(analysis.addDocsToggle).toHaveText("Add documents");
      await expect(analysis.addDocsControls).toBeHidden();
    });

    await test.step("expands on click", async () => {
      await analysis.addDocsToggle.click();
      await expect(analysis.addDocsToggle).toHaveAttribute("aria-expanded", "true");
      await expect(analysis.addDocsToggle).toHaveText("Done");
      await expect(analysis.addDocsControls).toBeVisible();
    });

    await test.step("collapses again on click", async () => {
      await analysis.addDocsToggle.click();
      await expect(analysis.addDocsToggle).toHaveAttribute("aria-expanded", "false");
      await expect(analysis.addDocsControls).toBeHidden();
    });
  });

  // AC1: paste text → document appears in the list and auto-selects once ready.
  test("paste-text ingest adds a document that auto-selects when ready", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    const filename = `pasted-${Date.now()}.md`;

    await test.step("expand panel and paste text", async () => {
      await analysis.expandAddDocuments();
      await analysis.pasteText(filename, "# E2E pasted requirement\n\nInline analysis ingest.");
    });

    await test.step("new document appears and is auto-selected (checked)", async () => {
      const checkbox = analysis.docCheckbox(filename);
      await expect(analysis.docRow(filename)).toBeVisible({ timeout: 30_000 });
      await expect(checkbox).toBeChecked();
      // Synchronous ingest → ready, so the row carries no in-flight status badge.
      await expect(checkbox).toBeEnabled();
    });

    await test.step("run summary reflects the selected document", async () => {
      await expect(analysis.runSummary).toContainText("1 document");
    });
  });

  // AC1: file upload via the inline dropzone → document appears, auto-selected.
  test("file upload adds a document that auto-selects when ready", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("expand panel and upload sample.md", async () => {
      await analysis.expandAddDocuments();
      await analysis.fileInput.setInputFiles(path.join(FIXTURES_DIR, "sample.md"));
      await expect(analysis.uploadStatusDone).toBeVisible({ timeout: 30_000 });
    });

    await test.step("uploaded document appears and is auto-selected", async () => {
      const checkbox = analysis.docCheckbox("sample.md");
      await expect(analysis.docRow("sample.md")).toBeVisible({ timeout: 30_000 });
      await expect(checkbox).toBeChecked();
    });
  });

  // AC: the URL field is wired to documentsApi.createFromUrl and surfaces
  // ingest errors. A successful remote fetch needs outbound network the
  // deterministic offline harness intentionally forbids, so we assert the
  // wired error path (a blocked loopback host is rejected by the SSRF guard).
  test("URL field surfaces an ingest error for a disallowed host", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await analysis.expandAddDocuments();
    await analysis.urlInput.fill("http://127.0.0.1/spec.md");
    await expect(analysis.urlSubmit).toBeEnabled();
    await analysis.urlSubmit.click();

    await expect(analysis.urlError).toBeVisible({ timeout: 30_000 });
  });

  // AC2: a still-processing document surfaces its ingest status and cannot be
  // selected until it is ready (the checkbox is disabled).
  test("a processing document surfaces its status and is not selectable", async ({ page }) => {
    const filename = `processing-${Date.now()}.md`;
    const docId = seedDocumentViaCli({
      projectId,
      uploadedById: userId,
      filename,
      status: "processing",
      databaseUrl: dbUrl(),
    });

    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("status badge is surfaced for the in-flight document", async () => {
      const row = analysis.docRow(filename);
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Target the status badge by its stable testid — the filename span also
      // contains the word "processing", so a plain text match is ambiguous.
      const statusBadge = page.getByTestId(`add-documents-status-${docId}`);
      await expect(statusBadge).toBeVisible();
      await expect(statusBadge).toHaveText("processing");
    });

    await test.step("the document cannot be selected until ready", async () => {
      await expect(analysis.docCheckbox(filename)).toBeDisabled();
    });

    await test.step("Run analysis stays enabled (no pending doc is selected)", async () => {
      await expect(analysis.runButton).toBeEnabled();
      await expect(analysis.pendingWarning).toBeHidden();
    });
  });
});
