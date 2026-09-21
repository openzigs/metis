/**
 * E2E — Analysis-page "Evaluate new requirements" panel (epic #904, #907 / #908).
 *
 * Verifies the collapsible free-text requirements panel and the pre-run summary
 * added inside the "Start a new analysis" Card on `/projects/[id]/analysis`:
 *   - the panel is collapsible (accessible `aria-expanded` toggle),
 *   - a live character counter tracks input against the 4096 cap and the cap
 *     is enforced,
 *   - the one-line run summary reflects the document count and whether
 *     requirements were provided,
 *   - starting an analysis with requirements text creates a run (the value is
 *     sent as `extraInstructions`; server-side persistence is unit-tested).
 *
 * Acceptance criteria covered (issue #908):
 *   AC3: requirements text → start → a run is created and the pre-run summary
 *        reflects that requirements were provided.
 *   AC4: typing toward / beyond the 4096 cap exercises the counter + clamp.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { apiBase } from "../fixtures/api-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = apiBase();
const MAX = 4096;

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Analysis page — evaluate new requirements (#907 / #908)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const slug = `e2e-analysis-reqs-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: { name: `Analysis Reqs ${slug}`, slug, description: "analysis new-requirements e2e" },
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

  // AC: a collapsed "Evaluate new requirements" panel with an accessible toggle.
  test("requirements panel toggles with aria-expanded", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("collapsed by default", async () => {
      await expect(analysis.reqToggle).toHaveAttribute("aria-expanded", "false");
      await expect(analysis.reqTextarea).toBeHidden();
      await expect(analysis.reqPanel).toContainText("Evaluate new requirements (optional)");
    });

    await test.step("expands and collapses on toggle", async () => {
      await analysis.reqToggle.click();
      await expect(analysis.reqToggle).toHaveAttribute("aria-expanded", "true");
      await expect(analysis.reqTextarea).toBeVisible();
      await analysis.reqToggle.click();
      await expect(analysis.reqToggle).toHaveAttribute("aria-expanded", "false");
      await expect(analysis.reqTextarea).toBeHidden();
    });
  });

  // AC4: the char counter tracks input and the 4096 cap is enforced.
  test("character counter tracks input and enforces the 4096 cap", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    await analysis.expandRequirements();

    await test.step("counter starts at zero", async () => {
      await expect(analysis.reqCounter).toHaveText(`0 / ${MAX}`);
    });

    await test.step("counter updates as the user types", async () => {
      await analysis.reqTextarea.fill("Add SSO for enterprise tenants.");
      await expect(analysis.reqCounter).toHaveText(`31 / ${MAX}`);
    });

    await test.step("input is clamped at the 4096 cap", async () => {
      await analysis.reqTextarea.fill("b".repeat(MAX + 904));
      await expect(analysis.reqCounter).toHaveText(`${MAX} / ${MAX}`);
      await expect(analysis.reqTextarea).toHaveJSProperty("value.length", MAX);
    });
  });

  // AC: the run summary reflects the doc count and whether requirements exist.
  test("run summary reflects documents and requirements", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("no docs, no requirements", async () => {
      await expect(analysis.runSummary).toHaveText(
        "This run uses 0 documents + requirements provided: no.",
      );
    });

    await test.step("adding requirements flips the summary to yes", async () => {
      await analysis.expandRequirements();
      await analysis.reqTextarea.fill("Evaluate audit-logging coverage for all mutations.");
      await expect(analysis.runSummary).toContainText("requirements provided: yes");
    });
  });

  // AC3: requirements text + a selected document → the analysis is created.
  test("starting an analysis with requirements creates a run", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    const filename = `reqs-doc-${Date.now()}.md`;

    await test.step("add a document via paste-text (auto-selected)", async () => {
      await analysis.expandAddDocuments();
      await analysis.pasteText(filename, "# Current implementation notes\n\nBaseline content.");
      await expect(analysis.docCheckbox(filename)).toBeChecked({ timeout: 30_000 });
    });

    await test.step("enter new requirements text", async () => {
      await analysis.expandRequirements();
      await analysis.reqTextarea.fill(
        "Support SSO for enterprise tenants; add audit logging to all mutations.",
      );
      await expect(analysis.runSummary).toContainText("1 document");
      await expect(analysis.runSummary).toContainText("requirements provided: yes");
    });

    await test.step("start the analysis and confirm a run is created", async () => {
      await expect(analysis.runButton).toBeEnabled();
      await analysis.runButton.click();
      await expect(page.getByRole("heading", { name: /^Run / })).toBeVisible({ timeout: 60_000 });
    });
  });

  // AC: requirements are optional — starting without them still creates a run.
  test("starting an analysis without requirements still creates a run", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("summary shows no requirements provided", async () => {
      await expect(analysis.runSummary).toContainText("requirements provided: no");
    });

    await test.step("start with default agents and no docs/requirements", async () => {
      await expect(analysis.runButton).toBeEnabled();
      await analysis.runButton.click();
      await expect(page.getByRole("heading", { name: /^Run / })).toBeVisible({ timeout: 60_000 });
    });
  });
});
