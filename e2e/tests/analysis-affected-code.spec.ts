/**
 * E2E — deterministic requirement→code mapping on the analysis results
 * (Issue #735, Epic #726).
 *
 * When an "Evaluate new requirements" run maps the operator's free-text new
 * requirements to code (Impact Analysis mapper + blast radius), the results page
 * renders a per-candidate affected-code list: symbol, `filePath:startLine`,
 * relation (direct vs blast-radius), confidence, and an empty state for a
 * candidate that matched no code.
 *
 * Determinism: the offline-stub AI provider cannot produce a real code-graph
 * mapping, so the analysis snapshot (with its `affectedCode` block) is stubbed
 * at the route level — the same approach the findings suite
 * (`analysis-findings.spec.ts`) uses. The server-side mapping is covered by unit
 * + orchestrator tests.
 *
 * Acceptance criteria covered
 *   #735 — an evaluate-requirements run renders at least one affected-code list
 *          with relation + confidence, and an empty state for unmatched candidates.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisFindingsPage } from "../pages/analysis-findings.page.js";

const API_BASE = apiBase();
const ANALYSIS_ID = "an-e2e-735";

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
    agents: [
      {
        agentKey: "code",
        status: "completed",
        startedAt: now,
        completedAt: now,
        errorMessage: null,
        summary: null,
        findings: [],
      },
    ],
    requirements: [],
    capability: null,
    // Issue #735 — the deterministic requirement→code mapping.
    affectedCode: {
      truncated: false,
      candidates: [
        {
          id: "NR-1",
          title: "Add a monthly invoice charge",
          body: "Add a monthly invoice charge",
          symbols: [
            {
              filePath: "server/src/billing/invoice.ts",
              qualifiedName: "InvoiceService.charge",
              startLine: 20,
              endLine: 40,
              relation: "direct",
              depth: 0,
              confidence: 0.92,
            },
            {
              filePath: "server/src/billing/controller.ts",
              qualifiedName: "BillingController.run",
              startLine: 10,
              endLine: 15,
              relation: "caller",
              depth: 1,
              confidence: 0.49,
            },
          ],
        },
        {
          id: "NR-2",
          title: "Add a refund endpoint",
          body: "Add a refund endpoint",
          symbols: [],
        },
      ],
    },
  };
}

async function mockAnalysisReads(
  page: import("@playwright/test").Page,
  projectId: string,
): Promise<void> {
  await page.route("**/api/analyses/personas", (route) =>
    route.fulfill(
      json({
        items: [
          {
            agentKey: "code",
            name: "Winston",
            role: "Solution Architect",
            avatar: "🏛️",
            description: "",
          },
        ],
      }),
    ),
  );
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

test.describe("Analysis affected-code mapping (#735)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-affected-735-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Affected 735 ${slug}`, slug, description: "epic-726 #735 e2e" },
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

  test("renders a per-candidate affected-code list with relation, locator and confidence", async ({
    page,
  }) => {
    await mockAnalysisReads(page, projectId);
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    const panel = page.getByTestId("affected-code-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    await test.step("the matched candidate lists its symbols with relation + confidence", async () => {
      const candidate = page.getByTestId("affected-code-candidate-NR-1");
      await expect(candidate).toContainText("InvoiceService.charge");
      await expect(candidate).toContainText("server/src/billing/invoice.ts:20");
      await expect(candidate).toContainText("direct");
      await expect(candidate).toContainText("caller");
      await expect(candidate).toContainText(/conf 0\.92/);
    });

    await test.step("the unmatched candidate shows an explicit empty state", async () => {
      await expect(page.getByTestId("affected-code-empty-NR-2")).toContainText(/no code matched/i);
    });
  });
});
