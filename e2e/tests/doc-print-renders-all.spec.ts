/**
 * #1182 — printing a long generated document prints rendered HTML for every
 * section, never a not-yet-rendered section's raw Markdown.
 *
 * The previewer renders a long document a few sections at a time (#190). The
 * browser's print (Ctrl+P, "Save as PDF") switches the page to print media;
 * Chromium's `page.pdf()` does the same, so `emulateMedia({ media: "print" })`
 * is the observable form of that switch.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { seedGeneratedDocViaCli } from "../fixtures/seed-helpers.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { DocumentationPage } from "../pages/documentation.page.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE ?? ""}`;
const TITLE = "Print Long BRD";
const REQUIREMENTS = 40;

/** A BRD long enough that most sections start pending. */
function longBrd(): string {
  const parts = ["# Business Requirements Document", "Prepared for print."];
  for (let i = 1; i <= REQUIREMENTS; i++) {
    parts.push(`### R${i} — Requirement ${i}`);
    parts.push(
      `The system **must** handle case ${i}. ` + "It applies to every record. ".repeat(40),
    );
    parts.push("- [ ] Acceptance criterion one", "- [ ] Acceptance criterion two");
  }
  return parts.join("\n");
}

test.describe("Printing a long document (#1182)", () => {
  let apiCtx: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (!DATABASE_URL || DATABASE_URL === "file:") throw new Error("E2E database URL not set");
    const primed = await primeAdminUser(API_BASE);
    apiCtx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${primed.accessToken}` },
    });
    const slug = `doc-print-${Date.now()}`;
    const created = await apiCtx.post("/api/projects", {
      data: { name: `Doc Print ${slug}`, slug, description: "e2e print" },
    });
    expect(created.status(), await created.text()).toBe(201);
    projectId = ((await created.json()) as { data: { id: string } }).data.id;
    seedGeneratedDocViaCli({
      projectId,
      uploadedById: primed.userId,
      title: TITLE,
      generationStatus: "ready",
      indexState: "indexed",
      databaseUrl: DATABASE_URL,
      content: longBrd(),
    });
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test("print media renders every section; screen stays lazy until then", async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
    const docPage = new DocumentationPage(page);
    await docPage.goto(projectId);
    await docPage.openDocumentFromList(TITLE);

    const content = docPage.markdownContent;
    await expect(content.getByRole("heading", { name: "R1 — Requirement 1" })).toBeVisible();

    await test.step("on screen, later sections are still pending raw text", async () => {
      await expect(content.locator("[data-section-pending]").first()).toBeAttached();
      await expect(content).toContainText("- [ ] Acceptance criterion one");
    });

    await test.step("print media renders every section's HTML", async () => {
      await page.emulateMedia({ media: "print" });
      await expect(content.locator("[data-section-pending]")).toHaveCount(0);
      await expect(content.locator("[data-section-rendered]")).toHaveCount(REQUIREMENTS + 1);
      await expect(content).not.toContainText("- [ ]");
      await expect(content).not.toContainText("**must**");
      await expect(content.locator('input[type="checkbox"]')).toHaveCount(REQUIREMENTS * 2);
    });

    await test.step("the PDF a user would save is produced from the rendered page", async () => {
      const pdf = await page.pdf();
      expect(pdf.byteLength).toBeGreaterThan(0);
    });
  });
});
