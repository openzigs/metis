/**
 * E2E — per-finding verification badges + filter on the analysis results
 * (Issue #740, Epic #727).
 *
 * The verifier/critic pass marks each finding `confirmed | unverified` before
 * synthesis. The results page renders a colour-coded verification badge per
 * finding and a filter control that narrows the findings list to a single
 * verification state. Findings that made no code claim carry no badge.
 *
 * Determinism: the offline-stub AI provider cannot produce a real graded run, so
 * the analysis snapshot (with per-finding `verificationStatus`) is stubbed at the
 * route level — the same approach the coverage/findings suites use. The
 * server-side verdict is covered by unit + persistence tests.
 *
 * Acceptance criteria covered
 *   #740 — confirmed/unverified badges render; the filter narrows the list to the
 *          selected verification state; an unverified finding stays visible.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisFindingsPage } from "../pages/analysis-findings.page.js";

const API_BASE = apiBase();
const ANALYSIS_ID = "an-e2e-740";

const json = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

function finding(
  id: string,
  title: string,
  verificationStatus: string | null,
): Record<string, unknown> {
  return {
    id,
    category: "security",
    severity: "high",
    title,
    body: `${title} body`,
    tags: [],
    citations: [],
    derivation: "inferred",
    confidence: 0.7,
    agentResultId: "ar-code",
    requirementId: null,
    verificationStatus,
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
    agents: [
      {
        agentKey: "code",
        status: "completed",
        startedAt: now,
        completedAt: now,
        summary: "code agent",
        notes: [],
        errorMessage: null,
        findings: [
          finding("f-confirmed", "Confirmed finding", "confirmed"),
          finding("f-unverified", "Unverified finding", "unverified"),
          finding("f-neutral", "Neutral finding", null),
        ],
      },
    ],
    requirements: [],
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

test.describe("Analysis finding verification badges + filter (#740)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-verify-740-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Verify 740 ${slug}`, slug, description: "epic-727 #740 e2e" },
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

  test("renders a verification badge per graded finding and filters the list", async ({ page }) => {
    await mockAnalysisReads(page, projectId);
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await test.step("confirmed + unverified badges render", async () => {
      await expect(page.getByTestId("verification-badge-confirmed")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("verification-badge-unverified")).toBeVisible();
    });

    await test.step("filtering to unverified keeps that finding visible and hides the others", async () => {
      await page.getByTestId("verification-filter-unverified").click();
      await expect(page.getByTestId("verification-badge-unverified")).toBeVisible();
      await expect(page.getByTestId("verification-badge-confirmed")).toHaveCount(0);
      await expect(page.getByText("Neutral finding")).toHaveCount(0);
    });

    await test.step("filtering to confirmed narrows to the confirmed finding", async () => {
      await page.getByTestId("verification-filter-confirmed").click();
      await expect(page.getByTestId("verification-badge-confirmed")).toBeVisible();
      await expect(page.getByTestId("verification-badge-unverified")).toHaveCount(0);
    });

    await test.step("clearing the filter (All) restores every finding", async () => {
      await page.getByTestId("verification-filter-all").click();
      await expect(page.getByTestId("verification-badge-confirmed")).toBeVisible();
      await expect(page.getByTestId("verification-badge-unverified")).toBeVisible();
      await expect(page.getByText("Neutral finding")).toBeVisible();
    });
  });
});
