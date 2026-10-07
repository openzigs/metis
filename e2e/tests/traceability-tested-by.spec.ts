/**
 * E2E — "Tested by" and untested requirements in the traceability UI (#816,
 * Epic #812).
 *
 * The walkthrough shape: the password requirement's chain shows
 * `internal/validator/user_test.go` › `TestValidatePassword`, and "OIDC role
 * mapping" (mapped code, no test) is listed under "Untested requirements" on
 * the Traceability tab, linking back to its requirement card.
 *
 * Determinism: the offline-stub AI provider cannot produce a mapped, tested
 * run, so the analysis snapshot, the requirement chains, the matrix and the
 * test-gaps page are stubbed at the route level, as in
 * `analysis-requirement-coverage.spec.ts`. The resolver itself is covered by
 * the server suite (#814).
 *
 * Acceptance criteria covered (#816)
 *   - TraceabilityView: "Tested by" lists `file:line › name` with a relation
 *     badge; "No linked test" is distinct from the no-code wording.
 *   - UntestedRequirementsPanel: "N of M" summary, untested list linking to
 *     the requirement card, "Load more" through `nextCursor`.
 *   - axe-clean (WCAG 2.2 AA) over both new regions.
 */
import { test, expect, request, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { TraceabilityTestedByPage } from "../pages/traceability-tested-by.page.js";

const API_BASE = apiBase();
const ANALYSIS_ID = "an-e2e-816";
const WCAG_22_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const REQ_PASSWORD = { id: "r-password", title: "Passwords are validated on sign-up" };
const REQ_OIDC = { id: "r-oidc", title: "OIDC role mapping" };
const REQ_EXPORT = { id: "r-export", title: "Audit log export" };

const json = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

function requirement(id: string, title: string): Record<string, unknown> {
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
    coverage: "grounded_in_code",
    version: 0,
  };
}

function codeNode(filePath: string, isTest = false): Record<string, unknown> {
  return {
    codeSymbolId: null,
    filePath,
    startLine: 10,
    endLine: 30,
    confidence: 0.9,
    source: "analysis-grounding",
    isTest,
  };
}

function chain(projectId: string, req: { id: string; title: string }, tested: boolean) {
  return {
    requirementId: req.id,
    requirementTitle: req.title,
    projectId,
    specs: [],
    directCode: [codeNode(tested ? "internal/validator/user.go" : "internal/auth/oidc.go")],
    testedBy: tested
      ? [
          {
            codeSymbolId: "t-1",
            filePath: "internal/validator/user_test.go",
            symbol: "internal/validator/user_test.go::TestValidatePassword",
            name: "TestValidatePassword",
            startLine: 18,
            convention: "go-testing",
            relation: "exercises",
            subject: { filePath: "internal/validator/user.go", symbol: "ValidatePassword" },
            score: 0.8,
          },
        ]
      : [],
  };
}

function gap(req: { id: string; title: string }) {
  return {
    requirementId: req.id,
    title: req.title,
    analysisId: ANALYSIS_ID,
    reason: "no-test",
    mappedFiles: 1,
  };
}

async function mockReads(page: Page, projectId: string): Promise<void> {
  const now = new Date().toISOString();
  const run = {
    id: ANALYSIS_ID,
    projectId,
    startedById: "u-admin",
    status: "completed",
    startedAt: now,
    completedAt: now,
    totalTokens: 1000,
    errorMessage: null,
  };
  await page.route("**/api/analyses/personas", (route) => route.fulfill(json({ items: [] })));
  await page.route("**/api/analyses/cost-cap", (route) =>
    route.fulfill(
      json({
        monthlyCap: 0,
        monthlyUsed: 0,
        monthlyRemaining: 0,
        monthBucket: "2026-10",
        exceeded: false,
      }),
    ),
  );
  await page.route(`**/api/projects/${projectId}/analyses`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill(json({ items: [run] }));
  });
  await page.route(`**/api/analyses/${ANALYSIS_ID}`, (route) =>
    route.fulfill(
      json({
        ...run,
        inputTokens: 900,
        outputTokens: 100,
        metadata: null,
        agents: [],
        requirements: [
          requirement(REQ_PASSWORD.id, REQ_PASSWORD.title),
          requirement(REQ_OIDC.id, REQ_OIDC.title),
          requirement(REQ_EXPORT.id, REQ_EXPORT.title),
        ],
        capability: null,
        affectedCode: null,
      }),
    ),
  );
  await page.route(`**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/approvals`, (route) =>
    route.fulfill(
      json({ items: [], ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 } }),
    ),
  );
  await page.route(`**/api/projects/${projectId}/requirements/*/traceability*`, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const req = [REQ_PASSWORD, REQ_OIDC, REQ_EXPORT].find((r) => r.id === id);
    if (!req) return route.fallback();
    return route.fulfill(json(chain(projectId, req, req.id === REQ_PASSWORD.id)));
  });
  await page.route(`**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/traceability`, (route) =>
    route.fulfill(
      json({ analysisId: ANALYSIS_ID, projectId, testsDetection: "heuristic", rows: [] }),
    ),
  );
  await page.route(`**/api/projects/${projectId}/traceability/test-gaps*`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const base = { total: 3, tested: 1, noCode: 0 };
    return route.fulfill(
      json(
        cursor === REQ_OIDC.id
          ? { ...base, untested: [gap(REQ_EXPORT)], nextCursor: null }
          : { ...base, untested: [gap(REQ_OIDC)], nextCursor: REQ_OIDC.id },
      ),
    );
  });
}

async function expectNoAxeViolations(page: Page, selector: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include(selector).withTags(WCAG_22_AA).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    nodes: v.nodes.map((n) => `${n.target.join(" ")} — ${n.failureSummary ?? ""}`).slice(0, 5),
  }));
  expect(summary).toEqual([]);
}

test.describe("Traceability — Tested by and untested requirements (#816)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-tested-by-816-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Tested by 816 ${slug}`, slug, description: "epic-812 #816 e2e" },
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

  test("the password requirement is tested by TestValidatePassword", async ({ page }) => {
    await mockReads(page, projectId);
    const pom = new TraceabilityTestedByPage(page);
    await pom.goto(projectId, "requirements");

    const tested = pom.testedBy(REQ_PASSWORD.id);
    await expect(tested).toBeVisible({ timeout: 30_000 });
    await expect(tested.getByRole("listitem")).toHaveText(
      /internal\/validator\/user_test\.go:18\s*›\s*TestValidatePassword\s*Calls the code/,
    );

    // Mapped code, no test: "No linked test" — never the no-code wording.
    const untested = pom.testedBy(REQ_OIDC.id);
    await expect(untested).toContainText("No linked test");
    await expect(untested).not.toContainText("No code mapped yet");

    await expectNoAxeViolations(
      page,
      `[id="requirement-${REQ_PASSWORD.id}"] section[aria-label="Requirement traceability"]`,
    );
  });

  test("OIDC role mapping is listed under Untested requirements", async ({ page }) => {
    await mockReads(page, projectId);
    const pom = new TraceabilityTestedByPage(page);
    await pom.goto(projectId, "traceability");

    await expect(pom.untestedPanel).toBeVisible({ timeout: 30_000 });
    await expect(pom.untestedSummary).toHaveText(
      "1 of 3 requirements with mapped code have a linked test",
    );
    await expect(pom.untestedLink(REQ_OIDC.title)).toBeVisible();
    await expectNoAxeViolations(page, "[data-testid='untested-requirements-panel']");

    await test.step("Load more appends the next page", async () => {
      await pom.loadMore.click();
      await expect(pom.untestedLink(REQ_EXPORT.title)).toBeVisible();
      await expect(pom.loadMore).toHaveCount(0);
    });

    await test.step("a link opens the requirement's card", async () => {
      await pom.untestedLink(REQ_OIDC.title).click();
      await expect(pom.requirementCard(REQ_OIDC.id)).toHaveAttribute("data-deep-linked", "true", {
        timeout: 30_000,
      });
    });
  });
});
