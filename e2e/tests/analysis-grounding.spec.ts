/**
 * E2E — Analysis-page requirement-grounding transparency (Epic #912 / #920).
 *
 * Verifies the citation + requirement-grounding states rendered on
 * `/projects/[id]/analysis` once an analysis completes:
 *   - a grounded finding shows the document **filename** (not a raw
 *     documentId) + a query-anchored excerpt and a "Grounded in REQ-…" badge,
 *   - a requirement-gap finding (severity=info) shows a "Gap for REQ-…" badge
 *     and the distinct empty-context note,
 *   - a finding with no requirement linkage renders a filename citation but
 *     no requirement badge.
 *
 * Determinism note: the offline-stub AI provider returns hash-derived prose,
 * not the structured JSON the requirement-grounded code agent requires, so a
 * live offline run completes with zero findings — none of the #920 states are
 * reachable through a real run in the offline harness. The finished Analysis
 * snapshot is therefore seeded directly into the DB (see
 * `seedGroundedAnalysisViaCli` / `server/scripts/e2e-seed-analysis-grounding.ts`),
 * mirroring the existing `seedDocumentViaCli` pattern. The spec asserts the
 * **UI rendering** of grounding transparency against that deterministic
 * snapshot; the server-side per-requirement retrieval + document-selection
 * filtering from #916 are covered by server unit tests.
 *
 * Acceptance criteria covered (issues #920 / #916):
 *   - A finding's citation shows the document filename + a query-anchored
 *     excerpt (#920).
 *   - A requirement-mapped finding shows the "Grounded in REQ-…" badge (#920).
 *   - A requirement-gap finding shows the "Gap for REQ-…" badge with distinct
 *     styling + the empty-context note (#916, #920).
 *   - A requirement with no grounded evidence surfaces an info/no-evidence
 *     note distinctly (#916, #920).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedGroundedAnalysisViaCli } from "../fixtures/seed-helpers.js";
import { GROUNDING_FIXTURE } from "../fixtures/grounding-fixture.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

test.describe("Analysis page — requirement-grounding transparency (#912 / #920)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let userId: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    userId = primed.userId;

    const slug = `e2e-analysis-grounding-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: { name: `Analysis Grounding ${slug}`, slug, description: "analysis grounding e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await api.dispose();

    // Seed a completed analysis whose findings cover every grounding state.
    seedGroundedAnalysisViaCli({ projectId, startedById: userId, databaseUrl: dbUrl() });

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC (#920): the seeded completed run auto-selects and renders its findings.
  test("the completed run renders its findings", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await expect(analysis.findingsHeading).toBeVisible({ timeout: 30_000 });
    await expect(analysis.findingTitle(GROUNDING_FIXTURE.grounded.title)).toBeVisible();
    await expect(analysis.findingTitle(GROUNDING_FIXTURE.gap.title)).toBeVisible();
    await expect(analysis.findingTitle(GROUNDING_FIXTURE.plain.title)).toBeVisible();
  });

  // AC (#920): a requirement-mapped finding shows the "Grounded in REQ-…"
  // badge and a citation with the document filename + a query-anchored excerpt
  // (not a raw documentId).
  test("a grounded finding shows filename, excerpt and the Grounded badge", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    await expect(analysis.findingsHeading).toBeVisible({ timeout: 30_000 });

    await test.step("the requirement-grounded badge is shown", async () => {
      await expect(analysis.groundingBadge(GROUNDING_FIXTURE.groundedBadge)).toBeVisible();
    });

    await test.step("the citation shows the filename and the excerpt", async () => {
      const citation = analysis.citation(GROUNDING_FIXTURE.grounded.filename);
      await expect(citation).toBeVisible();
      await expect(citation).toContainText(GROUNDING_FIXTURE.grounded.snippet);
    });

    await test.step("the raw seeded documentId is not surfaced", async () => {
      await expect(page.getByText("doc-seeded-grounding")).toHaveCount(0);
    });
  });

  // AC (#916 / #920): a requirement-gap finding (severity=info, no evidence)
  // shows the "Gap for REQ-…" badge and the distinct empty-context note.
  test("a requirement-gap finding shows the Gap badge and the no-evidence note", async ({
    page,
  }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    await expect(analysis.findingsHeading).toBeVisible({ timeout: 30_000 });

    await test.step("the gap badge is shown", async () => {
      await expect(analysis.groundingBadge(GROUNDING_FIXTURE.gapBadge)).toBeVisible();
    });

    await test.step("the empty-context note renders distinctly", async () => {
      await expect(analysis.noEvidenceNote).toBeVisible();
    });
  });

  // AC (#920): a finding with no requirement linkage still surfaces a
  // filename-bearing citation but renders no requirement badge.
  test("a finding without a requirement shows a citation but no requirement badge", async ({
    page,
  }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    await expect(analysis.findingsHeading).toBeVisible({ timeout: 30_000 });

    await test.step("the plain finding's filename citation is shown", async () => {
      await expect(analysis.findingTitle(GROUNDING_FIXTURE.plain.title)).toBeVisible();
      const citation = analysis.citation(GROUNDING_FIXTURE.plain.filename);
      await expect(citation).toBeVisible();
      await expect(citation).toContainText(GROUNDING_FIXTURE.plain.snippet);
    });

    await test.step("no Grounded/Gap badge references the plain finding", async () => {
      // The only requirement badges on the page belong to the grounded + gap
      // findings; the plain finding adds none, so the page has exactly two.
      const badges = page.getByText(/^(Grounded in|Gap for) REQ-/);
      await expect(badges).toHaveCount(2);
    });
  });
});
