/**
 * E2E — per-requirement coverage badges + filter on the analysis results
 * (Issue #736, Epic #726).
 *
 * Each synthesized requirement carries a deterministic coverage classification
 * (`grounded_in_code` | `grounded_in_docs_only` | `no_evidence`) computed at
 * synthesis time. The results page renders a colour-coded badge per requirement
 * and a filter control that narrows the list to a single coverage state.
 *
 * Determinism: the offline-stub AI provider cannot produce a real graded run, so
 * the analysis snapshot (with per-requirement `coverage`) is stubbed at the route
 * level — the same approach the findings/affected-code suites use. The server-side
 * classification is covered by unit + persistence tests.
 *
 * Acceptance criteria covered
 *   #736 — every requirement row shows a coverage badge; the filter narrows the
 *          list to the selected coverage state.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisFindingsPage } from "../pages/analysis-findings.page.js";

const API_BASE = apiBase();
const ANALYSIS_ID = "an-e2e-736";

const json = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

function requirement(id: string, title: string, coverage: string): Record<string, unknown> {
  return {
    id,
    type: "feature",
    title,
    body: `${title} body`,
    priority: "medium",
    labels: [],
    storyPoints: null,
    reviewStatus: "draft",
    evidenceFindingIds: [],
    coverage,
    version: 0,
  };
}

function snapshot(projectId: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: ANALYSIS_ID,
    projectId,
    startedById: "u-admin",
    status: "completed",
    startedAt: now,
    completedAt: now,
    totalTokens: 1000,
    inputTokens: 900,
    outputTokens: 100,
    errorMessage: null,
    metadata: null,
    agents: [],
    requirements: [
      requirement("r-code", "Code-grounded requirement", "grounded_in_code"),
      requirement("r-docs", "Docs-only requirement", "grounded_in_docs_only"),
      requirement("r-none", "Ungrounded requirement", "no_evidence"),
    ],
    capability: null,
    affectedCode: null,
  };
}

async function mockAnalysisReads(
  page: import("@playwright/test").Page,
  projectId: string,
): Promise<void> {
  await page.route("**/api/analyses/personas", (route) => route.fulfill(json({ items: [] })));
  await page.route("**/api/analyses/cost-cap", (route) =>
    route.fulfill(
      json({
        monthlyCap: 0,
        monthlyUsed: 0,
        monthlyRemaining: 0,
        monthBucket: "2026-07",
        exceeded: false,
      }),
    ),
  );
  await page.route(`**/api/projects/${projectId}/analyses`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill(
      json({
        items: [
          {
            id: ANALYSIS_ID,
            projectId,
            startedById: "u-admin",
            status: "completed",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            totalTokens: 1000,
            errorMessage: null,
          },
        ],
      }),
    );
  });
  await page.route(`**/api/analyses/${ANALYSIS_ID}`, (route) =>
    route.fulfill(json(snapshot(projectId))),
  );
  await page.route(`**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/approvals`, (route) =>
    route.fulfill(
      json({ items: [], ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 } }),
    ),
  );
}

test.describe("Analysis requirement coverage badges + filter (#736)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-coverage-736-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Coverage 736 ${slug}`, slug, description: "epic-726 #736 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { data?: { id?: string }; id?: string };
    projectId = (body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await ctx.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("admin", "password");
  });

  test("renders a coverage badge per requirement and filters the list by coverage", async ({
    page,
  }) => {
    await mockAnalysisReads(page, projectId);
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await test.step("all three coverage badges render", async () => {
      await expect(page.getByTestId("coverage-badge-grounded_in_code")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("coverage-badge-grounded_in_docs_only")).toBeVisible();
      await expect(page.getByTestId("coverage-badge-no_evidence")).toBeVisible();
    });

    await test.step("filtering to no_evidence narrows the list to that requirement", async () => {
      await page.getByTestId("coverage-filter-no_evidence").click();
      await expect(page.getByTestId("coverage-badge-no_evidence")).toBeVisible();
      await expect(page.getByTestId("coverage-badge-grounded_in_code")).toHaveCount(0);
      await expect(page.getByTestId("coverage-badge-grounded_in_docs_only")).toHaveCount(0);
    });

    await test.step("clearing the filter (All) restores every requirement", async () => {
      await page.getByTestId("coverage-filter-all").click();
      await expect(page.getByTestId("coverage-badge-grounded_in_code")).toBeVisible();
      await expect(page.getByTestId("coverage-badge-grounded_in_docs_only")).toBeVisible();
      await expect(page.getByTestId("coverage-badge-no_evidence")).toBeVisible();
    });
  });
});
