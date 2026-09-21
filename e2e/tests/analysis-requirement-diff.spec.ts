/**
 * E2E — diff-style current-vs-proposed view for changed requirements
 * (Issue #743, Epic #728).
 *
 * The analysis results page renders a side-by-side diff for the requirements
 * that CHANGED between a base ("current") and the head ("proposed") run: the
 * left column shows the base requirement + its code evidence, the right column
 * the proposed requirement + gap, with the changed body text highlighted and a
 * severity badge per entry.
 *
 * Determinism: the offline-stub AI provider cannot produce two graded runs with a
 * real diff, so the requirement-diff endpoint (assembled server-side by composing
 * the Change Analysis engine) is stubbed at the route level — the same approach
 * the coverage / affected-code suites use. The composition itself is covered by
 * unit tests (requirement-diff*.test.ts).
 *
 * Acceptance criteria covered
 *   #743 — a changed requirement renders a side-by-side current-vs-proposed diff
 *          with a severity badge; only real changes appear.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisFindingsPage } from "../pages/analysis-findings.page.js";

const API_BASE = apiBase();
const ANALYSIS_ID = "an-e2e-743";

const json = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

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
      {
        id: "r-login",
        type: "feature",
        title: "Users can log in",
        body: "Users authenticate with email and password.",
        priority: "high",
        labels: [],
        storyPoints: 3,
        reviewStatus: "draft",
        evidenceFindingIds: [],
        coverage: "grounded_in_code",
        version: 0,
      },
    ],
    capability: null,
    affectedCode: null,
  };
}

function diff(projectId: string): Record<string, unknown> {
  return {
    projectId,
    headAnalysisId: ANALYSIS_ID,
    baseAnalysisId: "an-base-743",
    entries: [
      {
        changeType: "modified",
        severity: "medium",
        impactScore: 0.55,
        diffSummary: "Body content modified (40 character delta)",
        current: {
          requirementId: "r-login-base",
          title: "Users can log in",
          body: "Users authenticate with email and password.",
          priority: "high",
          storyPoints: 3,
          codeCitations: [{ filePath: "server/src/auth.ts", startLine: 10, endLine: 20 }],
          hasEvidence: true,
        },
        proposed: {
          requirementId: "r-login",
          title: "Users can log in",
          body: "Users authenticate with email and password and are locked out after failures.",
          priority: "high",
          storyPoints: 3,
          gapReport: {
            requirementId: "r-login",
            title: "Users can log in",
            body: "…",
            priority: "high",
            coverage: "grounded_in_docs_only",
            storyPoints: 3,
            verificationStatus: "unverified",
            currentImplementation: { hasEvidence: false, citations: [], citedFindingCount: 0 },
            gapFindings: [
              {
                id: "f-lockout",
                title: "No account lockout",
                body: "auth.ts has no throttle; add attempt counting.",
                severity: "high",
                verificationStatus: "unverified",
                citations: [],
              },
            ],
            noEvidence: true,
          },
        },
      },
    ],
    summary: { total: 1, added: 0, removed: 0, modified: 1 },
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
  await page.route(
    `**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/requirement-diff*`,
    (route) => route.fulfill(json(diff(projectId))),
  );
}

test.describe("Analysis current-vs-proposed diff (#743)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-diff-743-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Diff 743 ${slug}`, slug, description: "epic-728 #743 e2e" },
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

  test("renders a side-by-side current-vs-proposed diff with a severity badge", async ({
    page,
  }) => {
    await mockAnalysisReads(page, projectId);
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await test.step("both sides of the diff render", async () => {
      await expect(page.getByTestId("diff-current").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("diff-proposed").first()).toBeVisible();
    });

    await test.step("the change carries a severity badge and the changed text is highlighted", async () => {
      await expect(page.getByTestId("diff-change-type").first()).toContainText("Modified");
      await expect(page.getByTestId("diff-severity").first()).toContainText("medium");
      await expect(page.getByTestId("diff-added").first()).toBeVisible();
    });

    await test.step("the current side surfaces code evidence and the proposed side the gap", async () => {
      await expect(page.getByText(/server\/src\/auth\.ts/).first()).toBeVisible();
      await expect(page.getByTestId("diff-gap-finding-f-lockout")).toContainText(
        "No account lockout",
      );
    });
  });
});
