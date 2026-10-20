/**
 * #1279 — printing a long document never puts "Rendering diagram…" on paper.
 *
 * Printing renders every section (#1182), but Mermaid draws asynchronously:
 * it loads on demand (#272) and the browser lays out the print copy as soon as
 * the `beforeprint` listeners return. A diagram in a section that was off
 * screen is therefore still undrawn when the print copy is made, and print CSS
 * must show a plain note there instead of the on-screen spinner.
 *
 * To catch that moment deterministically, every script requested after the
 * document opens is held: the Mermaid chunk cannot arrive until released.
 */
import { test, expect, request, type APIRequestContext, type Route } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { seedGeneratedDocViaCli } from "../fixtures/seed-helpers.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { DocumentationPage } from "../pages/documentation.page.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE ?? ""}`;
const TITLE = "Print Diagram BRD";
const REQUIREMENTS = 30;

/** A long BRD whose only diagram sits in its last, off-screen section. */
function longBrdWithDiagram(): string {
  const parts = ["# Business Requirements Document", "Prepared for print."];
  for (let i = 1; i <= REQUIREMENTS; i++) {
    parts.push(`### R${i} — Requirement ${i}`);
    parts.push(`The system must handle case ${i}. ` + "It applies to every record. ".repeat(40));
  }
  parts.push("### Order flow", "```mermaid", "graph TD", "  Order-->Invoice", "```");
  return parts.join("\n");
}

test.describe("Printing a document with an off-screen diagram (#1279)", () => {
  let apiCtx: APIRequestContext;
  let projectId: string;

  test.beforeAll(async () => {
    if (!DATABASE_URL || DATABASE_URL === "file:") throw new Error("E2E database URL not set");
    const primed = await primeAdminUser(API_BASE);
    apiCtx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${primed.accessToken}` },
    });
    const slug = `doc-print-diagram-${Date.now()}`;
    const created = await apiCtx.post("/api/projects", {
      data: { name: `Doc Print Diagram ${slug}`, slug, description: "e2e print diagram" },
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
      content: longBrdWithDiagram(),
    });
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test("prints a plain note for an undrawn diagram, then the diagram once drawn", async ({
    page,
  }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
    const docPage = new DocumentationPage(page);
    await docPage.goto(projectId);
    await docPage.openDocumentFromList(TITLE);
    const content = docPage.markdownContent;
    await expect(
      content.getByRole("heading", { name: "R1 — Requirement 1", exact: true }),
    ).toBeVisible();

    // Hold every script requested from here on: the Mermaid chunk among them.
    // The route stays registered and is disarmed by a flag, never unrouted:
    // removing the last route can strand a request (#327).
    const held: Route[] = [];
    let holding = true;
    await page.route(
      (url) => /\.m?js$/.test(url.pathname),
      (route) => (holding ? void held.push(route) : route.fallback()),
    );
    const note = content.getByText(/still being drawn when printing started/);

    await test.step("opening the document leaves the off-screen diagram undrawn (#190)", async () => {
      await expect(content.locator("[data-section-pending]").first()).toBeAttached();
      await expect(content.locator("code.language-mermaid")).toHaveCount(0);
      await expect(content.locator("svg[id^='mermaid-']")).toHaveCount(0);
    });

    await test.step("print media shows a plain note, never the spinner", async () => {
      await page.emulateMedia({ media: "print" });
      // Printing rendered the diagram's section; Mermaid is held, so it is undrawn.
      await expect(content.locator("code.language-mermaid")).toHaveCount(1);
      await expect(content.getByText("Rendering diagram…")).toBeHidden();
      await expect(note).toBeVisible();
    });

    await test.step("once Mermaid arrives, the next print includes the diagram", async () => {
      holding = false;
      for (const route of held.splice(0)) await route.fallback();
      await expect(content.locator("svg[id^='mermaid-']")).toBeVisible({ timeout: 30_000 });
      await expect(note).toHaveCount(0);
    });
  });
});
