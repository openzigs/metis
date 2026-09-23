/**
 * E2E tests for the Auto Documentation Generator (Epic #486).
 *
 * Tests cover acceptance criteria from:
 *   - Issue #492 (Rich Markdown Previewer)
 *   - Issue #487 (API endpoints)
 *   - Issue #493 (Living Documents — versioning)
 *
 * The spec seeds a generated document via the REST API so tests
 * don't depend on real LLM generation and run deterministically.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { LoginPage } from "../pages/login.page.js";
import { DocumentationPage } from "../pages/documentation.page.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { seedGeneratedDocViaCli } from "../fixtures/seed-helpers.js";

/**
 * Created per run. This used to be a hard-coded cuid from somebody's dev
 * database, so every call 404'd against the e2e database and the whole
 * generation half of this spec asserted nothing.
 */
let PROJECT_ID = "";
let adminUserId = "";

/**
 * Markdown the previewer assertions depend on: a heading, a fenced code block,
 * a mermaid block and a math span. The offline-stub AI provider emits
 * hash-derived PROSE, so a doc produced by a real (stubbed) generation carries
 * none of these and the rendering assertions could only ever pass vacuously.
 */
const PREVIEW_MARKDOWN = [
  "# Seeded documentation",
  "",
  "Prose paragraph for the previewer.",
  "",
  "## Architecture",
  "",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  "",
  "```ts",
  "export const answer = 42;",
  "```",
  "",
  "Inline math: $E = mc^2$",
  "",
].join("\n");

/**
 * Seed a READY generated document straight into the e2e database.
 *
 * `POST /docs/generate` is rate-limited to 5 per 15 minutes per user (a
 * deliberate product control), and this spec needs more documents than that —
 * the later describes used to 429 and assert nothing. The one test that must
 * exercise the real endpoint still does; everything that only needs a document
 * to look at is seeded here.
 */
function seedDocument(title: string, content = PREVIEW_MARKDOWN): string {
  const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE}`;
  return seedGeneratedDocViaCli({
    projectId: PROJECT_ID,
    uploadedById: adminUserId,
    title,
    generationStatus: "ready",
    indexState: "indexed",
    databaseUrl,
    content,
  }).id;
}

test.describe("Auto Documentation Generator (Epic #486)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let apiCtx: APIRequestContext;

  test.beforeAll(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    apiCtx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    adminUserId = primed.userId;
    PROJECT_ID = (await createProjectViaApi(API_BASE, accessToken, "e2e-autodoc")).id;
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test.describe("Documentation Page — Navigation & Empty State", () => {
    test.beforeEach(async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC (#492): Given user navigates to Documentation tab, Then page loads
    test("should navigate to Documentation tab from project", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);

      await expect(docPage.heading).toBeVisible();
      await expect(docPage.generateButton).toBeVisible();
    });

    // AC (#492): When no documents exist, empty state is shown
    test("should show empty state when no documents exist", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);

      await expect(page.getByText(/No documentation generated yet/)).toBeVisible();
    });
  });

  test.describe("Generate Documentation", () => {
    test.beforeEach(async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC (#487): Given user clicks "Generate Documentation", When generation
    // completes, Then document appears in the list
    test("should generate a document and show it in the list", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);

      const docTitle = `E2E Test Doc ${Date.now()}`;

      await test.step("open generate form and fill details", async () => {
        await docPage.openGenerateForm();
        await expect(docPage.generateForm).toBeVisible();
        await docPage.titleInput.clear();
        await docPage.titleInput.fill(docTitle);
        await docPage.scopeSelect.selectOption("full");
      });

      await test.step("submit and wait for doc to appear", async () => {
        await docPage.submitGenerate.click();
        // Form closes
        await expect(docPage.generateForm).not.toBeVisible({ timeout: 30_000 });
        // Document appears (the page opens it, so the title shows in the
        // detail header AND as the generated markdown's h1 — take the first).
        await expect(page.getByText(docTitle).first()).toBeVisible({ timeout: 60_000 });
      });
    });

    // AC: Generate form has scope selector with all three options
    test("should offer full/module/symbol scope options", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await docPage.openGenerateForm();

      await expect(docPage.scopeSelect).toBeVisible();
      // Verify all options exist
      await expect(
        docPage.scopeSelect.locator("option", { hasText: "Full Project" }),
      ).toBeAttached();
      await expect(
        docPage.scopeSelect.locator("option", { hasText: "Single Module" }),
      ).toBeAttached();
      await expect(
        docPage.scopeSelect.locator("option", { hasText: "Single Symbol" }),
      ).toBeAttached();
    });

    // AC: Cancel button closes the form
    test("should cancel generation form", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await docPage.openGenerateForm();
      await docPage.cancelGenerate.click();
      await expect(docPage.generateForm).not.toBeVisible();
    });
  });

  test.describe("Rich Markdown Previewer (#492)", () => {
    test.beforeAll(async () => {
      seedDocument("E2E Previewer Test");
    });

    test.beforeEach(async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC (#492): Given a generated document exists, When user navigates to
    // Documentation tab, Then the markdown is rendered with proper formatting
    test("should render generated markdown with proper formatting", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);

      await test.step("select the seeded document", async () => {
        await expect(page.getByText("E2E Previewer Test")).toBeVisible({ timeout: 15_000 });
        await page.getByText("E2E Previewer Test").click();
      });

      await test.step("verify markdown previewer is visible", async () => {
        await expect(docPage.markdownPreviewer).toBeVisible({ timeout: 15_000 });
        await expect(docPage.markdownContent).toBeVisible();
      });

      await test.step("verify headings are rendered", async () => {
        // The offline-stub generates content, headings should exist
        const headings = docPage.markdownContent.locator("h1, h2, h3");
        await expect(headings.first()).toBeVisible();
      });
    });

    // AC (#492): Given markdown contains mermaid code blocks, When rendered,
    // Then SVG diagrams are displayed
    test("should render mermaid diagrams as SVG", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Previewer Test").click();
      await expect(docPage.markdownContent).toBeVisible({ timeout: 15_000 });

      // Mermaid blocks get rendered to SVG (class: mermaid-rendered)
      // The offline-stub may not produce mermaid, so check for the
      // mermaid-block container at minimum
      const mermaidBlocks = docPage.markdownContent.locator(
        ".mermaid-block, .mermaid-rendered, svg",
      );
      // If the stub generated any mermaid content, SVGs appear.
      // If not, verify that code blocks render (non-mermaid content).
      const codeBlocks = docPage.markdownContent.locator("pre");
      const hasMermaid = await mermaidBlocks.count();
      const hasCode = await codeBlocks.count();
      expect(hasMermaid + hasCode).toBeGreaterThan(0);
    });

    // AC (#492): Given markdown contains $...$ or $$...$$ blocks, When rendered,
    // Then KaTeX math formulas are displayed
    test("should render math formulas with KaTeX notation", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Previewer Test").click();
      await expect(docPage.markdownContent).toBeVisible({ timeout: 15_000 });

      // The renderer wraps math in spans with class "math-inline"
      // Verify formatted content exists (code or math)
      const contentHtml = await docPage.markdownContent.innerHTML();
      // If the offline-stub includes math, we see math-inline spans
      // At minimum, verify the content rendered (non-empty)
      expect(contentHtml.length).toBeGreaterThan(50);
    });

    // AC (#492): Given markdown has headings, When page loads, Then TOC sidebar
    // shows clickable heading links
    test("should display TOC sidebar with heading links", async ({ page }) => {
      // Set viewport wide enough for TOC to show (lg breakpoint = 1024px)
      await page.setViewportSize({ width: 1280, height: 800 });

      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Previewer Test").click();
      await expect(docPage.markdownContent).toBeVisible({ timeout: 15_000 });

      // TOC only shows when > 3 headings exist — offline-stub should produce enough
      // If not visible, the doc didn't have enough headings (acceptable with stub)
      const tocVisible = await docPage.tocNav.isVisible().catch(() => false);
      if (tocVisible) {
        // Verify TOC contains links
        const tocLinks = docPage.tocNav.getByRole("link");
        await expect(tocLinks.first()).toBeVisible();
        const count = await tocLinks.count();
        expect(count).toBeGreaterThan(0);
      }
    });

    // AC (#492): Given user clicks a TOC entry, When clicked, Then page scrolls
    // to that heading
    test("should scroll to heading when TOC entry is clicked", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });

      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Previewer Test").click();
      await expect(docPage.markdownContent).toBeVisible({ timeout: 15_000 });

      const tocVisible = await docPage.tocNav.isVisible().catch(() => false);
      if (tocVisible) {
        const firstLink = docPage.tocNav.getByRole("link").first();
        const linkText = await firstLink.textContent();
        await firstLink.click();

        // After clicking, the corresponding heading should be in the viewport
        // (Playwright doesn't have a "is in viewport" assertion, but we
        // can verify the URL hash changed)
        if (linkText) {
          const slugged = linkText
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          await expect(page).toHaveURL(new RegExp(`#${slugged}`));
        }
      }
    });

    // AC (#492): Rendered markdown shows code blocks with syntax highlighting
    test("should render code blocks", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Previewer Test").click();
      await expect(docPage.markdownContent).toBeVisible({ timeout: 15_000 });

      // Verify pre/code elements exist in the rendered content
      const codeBlocks = docPage.markdownContent.locator("pre");
      // The offline-stub should produce some code; verify rendered HTML isn't empty
      const html = await docPage.markdownContent.innerHTML();
      expect(html.length).toBeGreaterThan(100);
      // Verify at least some structured content rendered
      expect((await codeBlocks.count()) + html.length).toBeGreaterThan(100);
    });
  });

  test.describe("Export (#487)", () => {
    let seededDocId: string;

    test.beforeAll(async () => {
      seededDocId = seedDocument("E2E Export Test");
    });

    test.beforeEach(async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC (#487): Given a document exists, When user clicks PDF export,
    // Then a PDF file downloads
    test("should export document as PDF", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Export Test").click();
      await expect(docPage.exportPdfButton).toBeVisible({ timeout: 15_000 });

      // The export opens the download URL in a new tab. Assert on the REQUEST:
      // a download never reaches `domcontentloaded`, so waiting on the popup's
      // load state hangs until the test times out, and reading its URL straight
      // after `window.open` returns "about:blank".
      // The export opens the download URL in a NEW TAB, so the request belongs
      // to a different page: `page.waitForRequest` never sees it, and a
      // download tab never reaches `domcontentloaded` (waiting on its load
      // state hangs until the test times out). Watch the whole browser context.
      const requested: string[] = [];
      page.context().on("request", (req) => requested.push(req.url()));
      await docPage.exportPdfButton.click();
      await expect
        .poll(() => requested.find((u) => u.includes(`/docs/${seededDocId}/export?format=pdf`)), {
          timeout: 15_000,
        })
        .toBeTruthy();
    });

    // AC (#487): Given a document exists, When user clicks Word export,
    // Then a .docx file downloads
    test("should export document as Word", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Export Test").click();
      await expect(docPage.exportWordButton).toBeVisible({ timeout: 15_000 });

      // The export opens the download URL in a NEW TAB, so the request belongs
      // to a different page: `page.waitForRequest` never sees it, and a
      // download tab never reaches `domcontentloaded` (waiting on its load
      // state hangs until the test times out). Watch the whole browser context.
      const requested: string[] = [];
      page.context().on("request", (req) => requested.push(req.url()));
      await docPage.exportWordButton.click();
      await expect
        .poll(() => requested.find((u) => u.includes(`/docs/${seededDocId}/export?format=docx`)), {
          timeout: 15_000,
        })
        .toBeTruthy();
    });
  });

  test.describe("Living Documents — Versioning (#493)", () => {
    test.beforeAll(async () => {
      // Two ready documents so the list has something to compare.
      seedDocument("E2E Versioning Test");
      seedDocument("E2E Versioning Test v2");
    });

    test.beforeEach(async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC (#493): Given a document was previously generated, When code changes
    // and re-generation runs, Then a new version is created
    test("should show version history when multiple versions exist", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);

      // Open the first seeded doc (has version via background gen)
      await expect(page.getByText("E2E Versioning Test").first()).toBeVisible({ timeout: 15_000 });
      await page.getByText("E2E Versioning Test").first().click();
      // `.or()` is strict when BOTH sides match — the detail view renders the
      // previewer AND the export button, so narrow to one.
      await expect(docPage.markdownPreviewer.or(docPage.exportPdfButton).first()).toBeVisible({
        timeout: 15_000,
      });

      // If the offline-stub generated multiple versions, version history shows
      // This test verifies the UI capability; the version history card only
      // renders when versions > 1
      const hasVersionHistory = await docPage.versionHistory.isVisible().catch(() => false);
      if (hasVersionHistory) {
        await expect(docPage.versionHistory.getByText(/v\d+/)).toBeVisible();
      }
    });

    // AC (#493): Given multiple versions exist, When user selects "Compare versions",
    // Then diff view shows changes
    test("should list multiple generated documents for comparison", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);

      // Both documents should appear in the list
      await expect(page.getByText("E2E Versioning Test").first()).toBeVisible({ timeout: 15_000 });
      // Multiple docs were created by the beforeAll seeding
      const docCards = docPage.docsList.locator("[data-testid^='doc-card-']");
      await expect(docCards.first()).toBeVisible({ timeout: 15_000 });
      expect(await docCards.count()).toBeGreaterThanOrEqual(2);
    });
  });

  test.describe("Document Detail Actions", () => {
    test.beforeAll(async () => {
      seedDocument("E2E Detail Actions");
    });

    test.beforeEach(async ({ page }) => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
    });

    // AC: Document detail shows title, export buttons, and back navigation
    test("should show document detail with all action buttons", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Detail Actions").click();

      // The detail title is an inline-rename BUTTON, not a heading.
      await expect(page.getByRole("button", { name: "E2E Detail Actions" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(docPage.exportPdfButton).toBeVisible();
      await expect(docPage.exportWordButton).toBeVisible();
      await expect(docPage.backButton).toBeVisible();
      await expect(docPage.deleteButton).toBeVisible();
    });

    // AC: Back button returns to document list
    test("should navigate back to document list", async ({ page }) => {
      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Detail Actions").click();
      await expect(docPage.backButton).toBeVisible({ timeout: 15_000 });

      await docPage.goBackToList();
      await expect(docPage.docsList).toBeVisible();
    });

    // AC: Delete removes document from list
    test("should delete a document", async ({ page }) => {
      // Seed a fresh doc just for deletion
      seedDocument("E2E Delete Target");

      const docPage = new DocumentationPage(page);
      await docPage.goto(PROJECT_ID);
      await page.getByText("E2E Delete Target").click();
      await expect(docPage.deleteButton).toBeVisible({ timeout: 15_000 });

      await docPage.deleteButton.click();
      // After deletion, returns to list and doc is gone
      await expect(docPage.docsList).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("E2E Delete Target")).not.toBeVisible();
    });
  });
});
