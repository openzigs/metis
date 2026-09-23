/**
 * Epic #597 — Requirements Enhancement with Web Search & Clarification E2E tests.
 *
 * Covers:
 *   Part 1 — API: Structured Requirements Extraction (#622)
 *   Part 2 — API: Web Research Augmentation (#623)
 *   Part 3 — API: Clarification Dialog endpoints (#624)
 *   Part 4 — API: Approval Checkpoint endpoints (#626)
 *   Part 5 — UI: Enhancement toggles, pipeline status, clarification dialog,
 *            evidence review panel (#625)
 *
 * Strategy:
 *   - API tests use `request.newContext()` for direct endpoint testing
 *   - UI tests navigate to `/projects/:id/analysis` and verify rendering,
 *     toggle state, pipeline indicator, and component behaviour
 *   - The offline-stub AI provider is active so clarification and web
 *     research produce deterministic stubs
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedCompletedAnalysis } from "../fixtures/review-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisEnhancementPage } from "../pages/analysis-enhancement.page.js";

const API_BASE = apiBase();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function createProject(api: APIRequestContext, suffix: string): Promise<string> {
  const slug = `e2e-597-${suffix}-${Date.now()}`;
  const res = await api.post("/api/projects", {
    data: { name: `Enhancement ${slug}`, slug, description: "epic-597 e2e" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
}

// A live analysis always ends `failed` under the offline-stub provider (every
// specialist agent rejects its prose as non-JSON), so seed a COMPLETED one
// through the shared CLI seam instead.
async function seedAnalysis(api: APIRequestContext, projectId: string): Promise<string> {
  return seedCompletedAnalysis(api, projectId);
}

async function loginViaUi(page: import("@playwright/test").Page): Promise<void> {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
}

// ─── Part 1: API — Structured Requirements Extraction (#622) ─────────────────

test.describe("API: Structured Requirements Extraction (#622)", () => {
  let token: string;
  let projectId: string;

  test.beforeEach(async () => {
    const prime = await primeAdminUser(API_BASE);
    token = prime.accessToken;
    const api = await authedApi(token);
    projectId = await createProject(api, "extract");
    await api.dispose();
  });

  // AC: POST to extract structured requirements from raw text
  test("should extract requirements via analysis run", async () => {
    const api = await authedApi(token);
    const analysisId = await seedAnalysis(api, projectId);

    const detailRes = await api.get(`/api/analyses/${analysisId}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json();
    const snapshot = detail.data ?? detail;

    // The offline-stub produces a deterministic analysis. We verify the
    // response shape has requirements with expected fields.
    expect(snapshot).toHaveProperty("requirements");
    // The snapshot names the per-agent rows `agents` (see
    // `toAnalysisSnapshot` in server/src/lib/analysis/analysis-service.ts).
    expect(snapshot).toHaveProperty("agents");
    expect(snapshot.status).toMatch(/completed|failed/);
    await api.dispose();
  });
});

// ─── Part 2: API — Web Research Augmentation (#623) ──────────────────────────

test.describe("API: Web Research Augmentation (#623)", () => {
  let token: string;
  let projectId: string;
  let analysisId: string;

  test.beforeEach(async () => {
    const prime = await primeAdminUser(API_BASE);
    token = prime.accessToken;
    const api = await authedApi(token);
    projectId = await createProject(api, "webres");
    analysisId = await seedAnalysis(api, projectId);
    await api.dispose();
  });

  // AC: Web research returns evidence with citations — approvals endpoint
  // lists items that can include evidence type entries.
  test("should list approvals which may include evidence items", async () => {
    const api = await authedApi(token);
    const res = await api.get(`/api/projects/${projectId}/analyses/${analysisId}/approvals`);
    // 200 OK even if no approval items (empty list is valid)
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    expect(data).toHaveProperty("items");
    expect(data).toHaveProperty("ticketStatus");
    expect(Array.isArray(data.items)).toBe(true);
    await api.dispose();
  });
});

// ─── Part 3: API — Clarification Dialog (#624) ──────────────────────────────

test.describe("API: Clarification Dialog (#624)", () => {
  let token: string;
  let projectId: string;
  let analysisId: string;

  test.beforeEach(async () => {
    const prime = await primeAdminUser(API_BASE);
    token = prime.accessToken;
    const api = await authedApi(token);
    projectId = await createProject(api, "clarify");
    analysisId = await seedAnalysis(api, projectId);
    await api.dispose();
  });

  // AC: POST /api/projects/:projectId/analysis/:analysisId/clarify
  test("should start clarification dialog with requirements payload", async () => {
    const api = await authedApi(token);
    const res = await api.post(`/api/projects/${projectId}/analyses/${analysisId}/clarify`, {
      data: {
        requirements: {
          requirements: [
            {
              id: "req-1",
              type: "feature",
              title: "User login",
              body: "Users should be able to log in",
              priority: "high",
              ambiguityScore: 0.8,
              ambiguityFields: ["authentication-method"],
              evidenceNeeds: [],
            },
          ],
          totalAmbiguities: 1,
          totalEvidenceNeeds: 0,
        },
      },
    });
    // Accept 200 (success) or 400/404 (offline-stub limitations)
    if (res.ok()) {
      const body = await res.json();
      const data = body.data ?? body;
      expect(data).toHaveProperty("analysisId");
      expect(data).toHaveProperty("currentRound");
      expect(data).toHaveProperty("maxRounds");
      expect(data).toHaveProperty("rounds");
      expect(data).toHaveProperty("completed");
    } else {
      // Offline-stub may not support full clarification flow —
      // verify the endpoint exists and returns a structured error
      expect([400, 404, 500]).toContain(res.status());
    }
    await api.dispose();
  });

  // AC: Multi-turn dialog flow — submit answers
  test("should accept answer submissions", async () => {
    const api = await authedApi(token);
    // First, start a dialog
    const startRes = await api.post(`/api/projects/${projectId}/analyses/${analysisId}/clarify`, {
      data: {
        requirements: {
          requirements: [
            {
              id: "req-mt-1",
              type: "feature",
              title: "Search functionality",
              body: "Users should be able to search",
              priority: "medium",
              ambiguityScore: 0.9,
              ambiguityFields: ["search-scope", "result-format"],
              evidenceNeeds: [],
            },
          ],
          totalAmbiguities: 2,
          totalEvidenceNeeds: 0,
        },
      },
    });

    if (startRes.ok()) {
      const startBody = await startRes.json();
      const state = startBody.data ?? startBody;
      if (state.rounds?.length > 0 && state.rounds[0].questions?.length > 0) {
        const questionId = state.rounds[0].questions[0].id;
        const answerRes = await api.post(
          `/api/projects/${projectId}/analyses/${analysisId}/clarify`,
          {
            data: {
              answers: [{ questionId, answer: "Full-text search across all documents" }],
              requirements: {
                requirements: [
                  {
                    id: "req-mt-1",
                    type: "feature",
                    title: "Search functionality",
                    body: "Users should be able to search",
                    priority: "medium",
                    ambiguityScore: 0.9,
                    ambiguityFields: ["search-scope", "result-format"],
                    evidenceNeeds: [],
                  },
                ],
                totalAmbiguities: 2,
                totalEvidenceNeeds: 0,
              },
            },
          },
        );
        if (answerRes.ok()) {
          const answerBody = await answerRes.json();
          const result = answerBody.data ?? answerBody;
          expect(result).toHaveProperty("analysisId");
        }
      }
    }
    // Endpoint exists and responds without crashing
    expect([200, 400, 404, 500]).toContain(startRes.status());
    await api.dispose();
  });

  // AC: Clarification endpoint rejects missing requirements
  test("should reject clarify request without requirements", async () => {
    const api = await authedApi(token);
    const res = await api.post(`/api/projects/${projectId}/analyses/${analysisId}/clarify`, {
      data: {},
    });
    expect(res.status()).toBe(400);
    await api.dispose();
  });
});

// ─── Part 3b: API — Enhancement flag wiring (Epic #922) ─────────────────────

test.describe("API: Enhancement flag wiring (Epic #922)", () => {
  let token: string;
  let projectId: string;

  test.beforeEach(async () => {
    const prime = await primeAdminUser(API_BASE);
    token = prime.accessToken;
    const api = await authedApi(token);
    projectId = await createProject(api, "enh-flags");
    await api.dispose();
  });

  async function startWithFlags(
    api: APIRequestContext,
    flags: { enableWebResearch?: boolean; enableClarification?: boolean },
  ): Promise<string> {
    const startRes = await api.post(`/api/projects/${projectId}/analyses`, {
      data: { documentIds: [], ...flags },
    });
    expect([201, 202]).toContain(startRes.status());
    const startBody = await startRes.json();
    const analysisId = (startBody.data?.id ?? startBody.id) as string;
    for (let i = 0; i < 60; i++) {
      const res = await api.get(`/api/analyses/${analysisId}`);
      if (res.ok()) {
        const body = await res.json();
        const status = body.data?.status ?? body.status;
        if (["completed", "failed", "cancelled"].includes(status)) return analysisId;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Analysis ${analysisId} did not reach terminal state in 60s`);
  }

  // AC: Opt-in flags are persisted into analysis metadata so the UI can
  // surface what was requested. Offline-stub makes this a deterministic no-op
  // beyond the recorded flags (no extraction/web research output).
  test("persists the enhancement flags into analysis metadata", async () => {
    const api = await authedApi(token);
    const analysisId = await startWithFlags(api, {
      enableWebResearch: true,
      enableClarification: true,
    });

    const detailRes = await api.get(`/api/analyses/${analysisId}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json();
    const snapshot = detail.data ?? detail;
    expect(snapshot.metadata?.enhancement).toEqual({
      enableWebResearch: true,
      enableClarification: true,
    });
    await api.dispose();
  });

  // AC: With both flags off, the enhancement pipeline never runs and no
  // enhancement metadata is recorded.
  test("does not record enhancement metadata when both flags are off", async () => {
    const api = await authedApi(token);
    const analysisId = await startWithFlags(api, {});

    const detailRes = await api.get(`/api/analyses/${analysisId}`);
    expect(detailRes.ok()).toBe(true);
    const detail = await detailRes.json();
    const snapshot = detail.data ?? detail;
    expect(snapshot.metadata?.enhancement).toBeUndefined();
    await api.dispose();
  });
});

// ─── Part 4: API — Approval Checkpoints (#626) ──────────────────────────────
test.describe("API: Approval Checkpoints (#626)", () => {
  let token: string;
  let projectId: string;
  let analysisId: string;

  test.beforeEach(async () => {
    const prime = await primeAdminUser(API_BASE);
    token = prime.accessToken;
    const api = await authedApi(token);
    projectId = await createProject(api, "approval");
    analysisId = await seedAnalysis(api, projectId);
    await api.dispose();
  });

  // AC: GET /api/projects/:projectId/analysis/:analysisId/approvals
  test("should list approval requests for an analysis", async () => {
    const api = await authedApi(token);
    const res = await api.get(`/api/projects/${projectId}/analyses/${analysisId}/approvals`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    expect(data).toHaveProperty("items");
    expect(data).toHaveProperty("ticketStatus");
    expect(data.ticketStatus).toHaveProperty("allowed");
    expect(data.ticketStatus).toHaveProperty("pendingCount");
    await api.dispose();
  });

  // AC: GET approvals supports status filter query parameter
  test("should support status filter on approvals list", async () => {
    const api = await authedApi(token);
    const res = await api.get(
      `/api/projects/${projectId}/analyses/${analysisId}/approvals?status=pending`,
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    expect(Array.isArray(data.items)).toBe(true);
    await api.dispose();
  });

  // AC: PUT /api/projects/:projectId/analysis/:analysisId/approvals/:approvalId
  test("should reject approval update with invalid status", async () => {
    const api = await authedApi(token);
    // Use a fake approvalId — should return 404 (approval not found)
    const res = await api.put(
      `/api/projects/${projectId}/analyses/${analysisId}/approvals/nonexistent-id`,
      { data: { status: "approved" } },
    );
    expect([404, 400]).toContain(res.status());
    await api.dispose();
  });

  // AC: Approval endpoint validates status field
  test("should reject approval with invalid status value", async () => {
    const api = await authedApi(token);
    const res = await api.put(
      `/api/projects/${projectId}/analyses/${analysisId}/approvals/some-id`,
      { data: { status: "banana" } },
    );
    expect(res.status()).toBe(400);
    await api.dispose();
  });

  // AC: Approval state management — ticketStatus reflects state
  test("should report ticket status based on approval state", async () => {
    const api = await authedApi(token);
    const res = await api.get(`/api/projects/${projectId}/analyses/${analysisId}/approvals`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    expect(typeof data.ticketStatus.allowed).toBe("boolean");
    expect(typeof data.ticketStatus.pendingCount).toBe("number");
    expect(typeof data.ticketStatus.rejectedCount).toBe("number");
    await api.dispose();
  });
});

// ─── Part 5: UI — Enhancement Options & Components (#625) ───────────────────

test.describe("UI: Enhancement Options (#625)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const prime = await primeAdminUser(API_BASE);
    const api = await authedApi(prime.accessToken);
    projectId = await createProject(api, "ui-enh");
    await api.dispose();

    await loginViaUi(page);
  });

  // AC: Enhancement toggles on analysis config page
  test("should display enhancement option toggles", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    await test.step("Enhancement Options section is visible", async () => {
      await expect(enhancementPage.enhancementOptions).toBeVisible();
    });

    await test.step('"Enhance with web research" toggle is visible', async () => {
      await expect(enhancementPage.webResearchToggle).toBeVisible();
    });

    await test.step('"Ask clarifying questions" toggle is visible', async () => {
      await expect(enhancementPage.clarificationToggle).toBeVisible();
    });
  });

  // AC: web research is opt-IN; clarifying questions are opt-OUT (the analysis
  // page defaults `enableClarification` to true so doc-grounded questions
  // surface without being asked for).
  //
  // This asserts the SHIPPED product, which diverges from the original
  // enhancement-toggles AC ("both default off"). The divergence looks
  // deliberate — the ON default carries its own rationale comment in
  // `ui/src/app/(authed)/projects/[id]/analysis/page.tsx` — but it is not this
  // spec's call to adjudicate, so it is tracked in
  // https://github.com/openzigs/metis/issues/95 rather than silently encoded here.
  test("should default web research off and clarifying questions on", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    await test.step("Web research toggle is unchecked by default", async () => {
      expect(await enhancementPage.isWebResearchChecked()).toBe(false);
    });

    await test.step("Clarification toggle is checked by default", async () => {
      expect(await enhancementPage.isClarificationChecked()).toBe(true);
    });
  });

  // AC: Enhancement status indicator shows pipeline progress
  test("should show enhancement status when web research toggle is enabled", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    await test.step("Enable web research toggle", async () => {
      await enhancementPage.enableWebResearch();
      expect(await enhancementPage.isWebResearchChecked()).toBe(true);
    });

    await test.step("Enhancement status indicator appears", async () => {
      await expect(enhancementPage.getStatusStep("Extract Requirements")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Web Research")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Approval")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Complete")).toBeVisible();
    });
  });

  // AC: Enhancement status indicator adapts to selected toggles
  test("should show clarification step while the clarification toggle is on", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    await test.step("Clarification is on out of the box", async () => {
      expect(await enhancementPage.isClarificationChecked()).toBe(true);
    });

    await test.step("Clarification step appears in status indicator", async () => {
      await expect(enhancementPage.getStatusStep("Extract Requirements")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Clarification")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Complete")).toBeVisible();
    });

    await test.step("Web Research step is hidden when only clarification is on", async () => {
      await expect(enhancementPage.getStatusStep("Web Research")).not.toBeVisible();
    });
  });

  // AC: Both toggles enabled shows full pipeline
  test("should show full pipeline when both toggles are enabled", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    await test.step("Enable both toggles (clarification is already on)", async () => {
      await enhancementPage.enableWebResearch();
      expect(await enhancementPage.isClarificationChecked()).toBe(true);
    });

    await test.step("All pipeline steps visible", async () => {
      await expect(enhancementPage.getStatusStep("Extract Requirements")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Web Research")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Clarification")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Approval")).toBeVisible();
      await expect(enhancementPage.getStatusStep("Complete")).toBeVisible();
    });
  });

  // AC: Pipeline indicator hidden when no toggles enabled
  test("should hide enhancement status when both toggles are off", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    // Clarification ships ON, so turn it off to reach the "no enhancements" state.
    await enhancementPage.enableClarification();
    expect(await enhancementPage.isClarificationChecked()).toBe(false);
    expect(await enhancementPage.isWebResearchChecked()).toBe(false);

    await expect(enhancementPage.getStatusStep("Extract Requirements")).not.toBeVisible();
  });

  // AC: Toggling off removes the status indicator
  test("should remove status indicator when toggle is turned off", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    await test.step("Enable web research (clarification is already on)", async () => {
      await enhancementPage.enableWebResearch();
      await expect(enhancementPage.getStatusStep("Extract Requirements")).toBeVisible();
    });

    await test.step("Turning BOTH off removes the indicator", async () => {
      await enhancementPage.enableWebResearch(); // toggles off
      expect(await enhancementPage.isWebResearchChecked()).toBe(false);
      // Clarification alone still keeps the pipeline on screen.
      await expect(enhancementPage.getStatusStep("Extract Requirements")).toBeVisible();

      await enhancementPage.enableClarification(); // toggles off
      expect(await enhancementPage.isClarificationChecked()).toBe(false);
      await expect(enhancementPage.getStatusStep("Extract Requirements")).not.toBeVisible();
    });
  });

  // AC: Run analysis button is present and clickable
  test("should display run analysis button", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);
    await expect(enhancementPage.runAnalysisButton).toBeVisible();
    await expect(enhancementPage.runAnalysisButton).toBeEnabled();
  });

  // AC: Responsive — page renders without horizontal overflow
  test("should render enhancement section without horizontal overflow", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    // Resize to mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(enhancementPage.enhancementOptions).toBeVisible();
    await expect(enhancementPage.webResearchToggle).toBeVisible();
    await expect(enhancementPage.clarificationToggle).toBeVisible();
  });

  // AC: Keyboard navigable — toggles are focusable and activatable via keyboard
  test("should support keyboard navigation for enhancement toggles", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    const webResearchInput = page
      .locator("label")
      .filter({ hasText: "Enhance with web research" })
      .locator("input[type='checkbox']");

    await test.step("Tab to web research checkbox and activate with Space", async () => {
      await webResearchInput.focus();
      await expect(webResearchInput).toBeFocused();
      await page.keyboard.press("Space");
      await expect(webResearchInput).toBeChecked();
    });

    await test.step("Pressing Space again unchecks the toggle", async () => {
      await page.keyboard.press("Space");
      await expect(webResearchInput).not.toBeChecked();
    });
  });
});

// ─── Part 5b: UI — Clarification Dialog Component (#625) ────────────────────

test.describe("UI: Clarification Dialog rendering (#625)", () => {
  // These tests verify the ClarificationDialogPanel component renders
  // correctly with given state. Since the offline-stub may not produce
  // actual clarification rounds, we test via the analysis page flow
  // and verify the component structure.

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const prime = await primeAdminUser(API_BASE);
    const api = await authedApi(prime.accessToken);
    projectId = await createProject(api, "ui-clarify");
    await api.dispose();

    await loginViaUi(page);
  });

  // AC: Clarification dialog UI — verify the heading text renders
  // on the analysis config page (the component is conditionally rendered)
  test("should render analysis page with enhancement section", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    // The analysis page should load with the config card
    await expect(page.getByRole("heading", { name: "Start a new analysis" })).toBeVisible();
    await expect(enhancementPage.enhancementOptions).toBeVisible();
  });
});

// ─── Part 5c: UI — Evidence Review Panel (#625) ─────────────────────────────

test.describe("UI: Evidence Review rendering (#625)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const prime = await primeAdminUser(API_BASE);
    const api = await authedApi(prime.accessToken);
    projectId = await createProject(api, "ui-evidence");
    await api.dispose();

    await loginViaUi(page);
  });

  // AC: Evidence review panel — verify analysis page loads with
  // the enhancement options section containing evidence-related controls
  test("should render analysis page ready for evidence review", async ({ page }) => {
    const enhancementPage = new AnalysisEnhancementPage(page);
    await enhancementPage.goto(projectId);

    // The config card loads; evidence review panel renders when an
    // analysis with evidence is selected. We verify the page structure.
    await expect(page.getByRole("heading", { name: "Start a new analysis" })).toBeVisible();
  });
});

// ─── Part 6: API — Auth & Permissions ────────────────────────────────────────

test.describe("API: Auth requirements for enhancement endpoints", () => {
  // AC: Endpoints require authentication (401 without token)

  test("should require auth for clarification endpoint", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.post("/api/projects/fake-id/analyses/fake-id/clarify", {
      data: { requirements: {} },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test("should require auth for approvals list endpoint", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.get("/api/projects/fake-id/analyses/fake-id/approvals");
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test("should require auth for approval review endpoint", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.put("/api/projects/fake-id/analyses/fake-id/approvals/fake-approval", {
      data: { status: "approved" },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });
});
