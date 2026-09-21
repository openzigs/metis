/**
 * Epic #889 / Sub-issue #894 — Requirement detail "Data Mappings" panel.
 *
 * The UI slice delivered in PR #888 adds a `DataMappingsPanel`
 * (`ui/src/components/traceability/data-mappings-panel.tsx`) under each
 * requirement on `/projects/:id/analysis`, beside the findings/requirements
 * review section. These tests exercise the user-facing behaviour against the
 * REAL #892 CRUD API and the #893 suggest endpoint.
 *
 * Acceptance criteria mapped (issue #894 / epic #889):
 *   AC#1  Panel renders linked mappings with connector label, table/column and
 *         confidence next to the requirement.                  (render + add)
 *   AC#2  Add and remove work against the #892 API and reflect immediately.
 *   AC#3  "Suggest mappings" calls the #893 endpoint, displays candidates with
 *         confidence/rationale, and supports accepting them.
 *   AC#4  Empty / loading / error states handled; controls keyboard-accessible
 *         with proper ARIA (empty-state + accessible region/labels asserted).
 *   AC#5  e2e coverage for render, add, remove, and suggest-accept flows.
 *
 * Determinism notes:
 *   - The offline-stub AI provider returns deterministic prose, not structured
 *     requirements, so a Requirement is seeded directly into the e2e SQLite DB
 *     (the same fixture used by `full-flow.spec.ts`) to give the panel a row to
 *     attach to. The CRUD + suggest paths under test are entirely real.
 *   - The suggest endpoint, with no ingested DB schema in the project, returns
 *     an empty candidate set with an explanatory note — that real response is
 *     asserted directly (test 4). To exercise candidate *rendering* and the
 *     *accept→persist* path deterministically (the LLM cannot emit structured
 *     candidates offline), test 5 stubs ONLY the suggest response; the Accept
 *     action still round-trips through the real create API and is verified via
 *     the GET endpoint.
 */
import { test, expect, request, type APIRequestContext, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";

// The e2e package does not link `@metis/shared`; mirror the API response shape
// locally (see `packages/shared/src/traceability.ts`'s RequirementDataMappingDetail).
interface RequirementDataMappingDetail {
  id: string;
  requirementId: string;
  dbConnectorId: string;
  dbConnectorLabel: string | null;
  schemaName: string | null;
  tableName: string;
  columnName: string | null;
  confidence: number;
  source: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
import { apiBase } from "../fixtures/api-base.js";
import { seedRequirementViaCli } from "../fixtures/seed-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { DataMappingsPage } from "../pages/data-mappings.page.js";

const API_BASE = apiBase();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function createProject(api: APIRequestContext, suffix: string): Promise<string> {
  const slug = `e2e-894-${suffix}-${Date.now()}`;
  const res = await api.post("/api/projects", {
    data: { name: `Data Mappings ${slug}`, slug, description: "issue-894 e2e" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
}

/** Create a DB connector (label + driver are the only required fields). */
async function createDbConnector(
  api: APIRequestContext,
  projectId: string,
  label: string,
): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/connectors/dbs`, {
    data: { label, driver: "postgres" },
  });
  expect(res.status(), `connector create: ${await res.text()}`).toBe(201);
  const body = await res.json();
  return (body.data?.id ?? body.id) as string;
}

/** Start an analysis and poll the snapshot to a terminal state. */
async function seedCompletedAnalysis(api: APIRequestContext, projectId: string): Promise<string> {
  const startRes = await api.post(`/api/projects/${projectId}/analyses`, {
    data: { documentIds: [] },
  });
  expect([201, 202]).toContain(startRes.status());
  const startBody = await startRes.json();
  const analysisId = (startBody.data?.id ?? startBody.id) as string;
  expect(analysisId).toBeTruthy();

  for (let i = 0; i < 90; i++) {
    const res = await api.get(`/api/analyses/${analysisId}`);
    if (res.ok()) {
      const body = await res.json();
      const status = body.data?.status ?? body.status;
      if (["completed", "failed", "cancelled"].includes(status)) return analysisId;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Analysis ${analysisId} did not reach terminal state`);
}

function e2eDatabaseUrl(): string {
  const dbFile =
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db");
  return `file:${dbFile}`;
}

async function listMappings(
  token: string,
  projectId: string,
  requirementId: string,
): Promise<RequirementDataMappingDetail[]> {
  const ctx = await authedApi(token);
  try {
    const res = await ctx.get(
      `/api/projects/${projectId}/requirements/${requirementId}/data-mappings`,
    );
    expect(res.ok(), `list mappings: ${await res.text()}`).toBeTruthy();
    const body = (await res.json()) as { data: RequirementDataMappingDetail[] };
    return body.data;
  } finally {
    await ctx.dispose();
  }
}

async function createMappingViaApi(
  token: string,
  projectId: string,
  requirementId: string,
  body: Record<string, unknown>,
): Promise<RequirementDataMappingDetail> {
  const ctx = await authedApi(token);
  try {
    const res = await ctx.post(
      `/api/projects/${projectId}/requirements/${requirementId}/data-mappings`,
      { data: body },
    );
    expect(res.status(), `create mapping: ${await res.text()}`).toBe(201);
    return (await res.json()).data as RequirementDataMappingDetail;
  } finally {
    await ctx.dispose();
  }
}

async function loginViaUi(page: Page): Promise<void> {
  const loginPage = new LoginPage(page);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await loginPage.goto();
    await loginPage.username.fill(ADMIN_USER.username);
    await loginPage.password.fill(ADMIN_USER.password);
    try {
      // Hydration race guard. When this spec runs in isolation, Next.js dev
      // compiles the /login route cold and the submit button can fire a
      // native GET form submission (navigating to /login?username=...) before
      // React attaches the onSubmit handler. A hydrated submit instead issues
      // a client-side POST /api/auth/login — so we wait for that POST as proof
      // of hydration. On a native GET no POST fires and we reload the
      // now-warm route and retry.
      await Promise.all([
        page.waitForResponse(
          (res) => res.url().endsWith("/api/auth/login") && res.request().method() === "POST",
          { timeout: 30_000 },
        ),
        loginPage.submit.click(),
      ]);
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      // Retry against the now-warm route.
    }
  }
}

// ─── Suite ───────────────────────────────────────────────────────────────────

test.describe("Issue #894 — Requirement Data Mappings panel", () => {
  let token: string;
  let projectId: string;
  let requirementId: string;
  let connectorId: string;
  const connectorLabel = "Primary warehouse";

  test.beforeEach(async ({ page }) => {
    // The hook is heavy: it primes auth, logs in through the UI (which can pay
    // a cold Next.js dev-compile cost on the first /login hit), creates a
    // project + connector, runs an analysis to completion (polled up to ~90s),
    // and seeds a requirement via the CLI. That comfortably exceeds the default
    // 120s test timeout, so extend the budget for setup + test.
    test.setTimeout(300_000);

    const primed = await primeAdminUser(API_BASE);
    token = primed.accessToken;

    // Log in first, while the full timeout budget is available and the /login
    // route is freshest — the analysis poll below must not starve the login
    // hydration retries.
    await loginViaUi(page);

    const api = await authedApi(token);
    projectId = await createProject(api, "panel");
    connectorId = await createDbConnector(api, projectId, connectorLabel);
    const analysisId = await seedCompletedAnalysis(api, projectId);
    await api.dispose();

    // The offline-stub completes the analysis with zero structured
    // requirements; seed one directly so the panel has a row to render.
    requirementId = seedRequirementViaCli({
      projectId,
      analysisId,
      databaseUrl: e2eDatabaseUrl(),
    });
    expect(requirementId).toBeTruthy();
  });

  // AC#1 (render) + AC#4 (empty state + accessible region/controls).
  test("renders the Data Mappings panel with an empty state and controls", async ({ page }) => {
    const dm = new DataMappingsPage(page);
    await dm.goto(projectId);

    await test.step("panel landmark and heading are present", async () => {
      await expect(dm.panel).toBeVisible();
      await expect(dm.heading).toBeVisible();
    });

    await test.step("empty state and accessible action buttons render", async () => {
      await expect(dm.emptyState).toBeVisible();
      await expect(dm.addMappingButton).toBeVisible();
      await expect(dm.suggestButton).toBeVisible();
    });
  });

  // AC#1 (connector label + table/column + confidence) + AC#2 (add reflects).
  test("manually adds a mapping which renders with label, path and confidence", async ({
    page,
  }) => {
    const dm = new DataMappingsPage(page);
    await dm.goto(projectId);

    await test.step("submit the add-mapping form", async () => {
      await dm.addMapping({
        connectorLabel,
        table: "users",
        column: "email",
        note: "Stores account email",
      });
    });

    await test.step("the new mapping appears with its path, label and confidence", async () => {
      const row = dm.mappingRow("users.email");
      await expect(row).toBeVisible();
      // No confidence supplied → DB default 0.7 → 70%.
      await expect(row.getByText("70% confidence")).toBeVisible();
      await expect(row.getByText(connectorLabel)).toBeVisible();
    });

    await test.step("the mapping persisted to the #892 API", async () => {
      const mappings = await listMappings(token, projectId, requirementId);
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toMatchObject({
        tableName: "users",
        columnName: "email",
        source: "manual",
      });
    });
  });

  // AC#2 (remove reflects immediately + persists to the API).
  test("removes a linked mapping and returns to the empty state", async ({ page }) => {
    await createMappingViaApi(token, projectId, requirementId, {
      dbConnectorId: connectorId,
      tableName: "orders",
      columnName: "total",
      note: "seed for removal",
    });

    const dm = new DataMappingsPage(page);
    await dm.goto(projectId);

    const row = dm.mappingRow("orders.total");
    await expect(row).toBeVisible();

    await test.step("click Remove via its accessible label", async () => {
      await dm.removeButton("orders.total").click();
    });

    await test.step("row disappears and empty state returns", async () => {
      await expect(row).toHaveCount(0);
      await expect(dm.emptyState).toBeVisible();
    });

    await test.step("removal persisted to the #892 API", async () => {
      const mappings = await listMappings(token, projectId, requirementId);
      expect(mappings).toHaveLength(0);
    });
  });

  // AC#3 + AC#4 — the real #893 endpoint is called and its response surfaces.
  // With no ingested DB schema, the endpoint returns an explanatory note.
  test("Suggest mappings calls the #893 endpoint and surfaces its response", async ({ page }) => {
    const dm = new DataMappingsPage(page);
    await dm.goto(projectId);

    await test.step("click Suggest mappings", async () => {
      await dm.suggestButton.click();
    });

    await test.step("suggestions region surfaces the backend note", async () => {
      await expect(dm.suggestionsRegion).toBeVisible();
      await expect(dm.suggestionNote).toContainText("No ingested database schema found");
    });
  });

  // AC#3 + AC#5 — candidates render with confidence/rationale, and Accept
  // round-trips through the real create API. Only the suggest response is
  // stubbed (the offline LLM cannot emit structured candidates).
  test("displays suggested candidates and accepts one into the linked list", async ({ page }) => {
    await page.route("**/data-mappings/suggest", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            candidates: [
              {
                dbConnectorId: connectorId,
                dbConnectorLabel: connectorLabel,
                schemaName: null,
                tableName: "orders",
                columnName: "total",
                confidence: 0.92,
                lowConfidence: false,
                rationale: "Stores per-order monetary totals",
                source: "llm-suggested",
              },
            ],
            budgetExhausted: false,
            note: null,
          },
        }),
      });
    });

    const dm = new DataMappingsPage(page);
    await dm.goto(projectId);

    await test.step("request suggestions", async () => {
      await dm.suggestButton.click();
    });

    await test.step("candidate renders with confidence and rationale", async () => {
      const candidate = dm.candidate("orders.total");
      await expect(candidate).toBeVisible();
      await expect(candidate.getByText("92% confidence")).toBeVisible();
      await expect(candidate.getByText("Stores per-order monetary totals")).toBeVisible();
    });

    await test.step("accepting the candidate persists it via the real create API", async () => {
      await dm.acceptButton("orders.total").click();

      const row = dm.mappingRow("orders.total");
      await expect(row).toBeVisible();
      await expect(row.getByText("92% confidence")).toBeVisible();
      // llm-suggested mappings are tagged with an "AI" badge.
      await expect(row.getByText("AI", { exact: true })).toBeVisible();
      // The accepted candidate is dropped from the suggestion list.
      await expect(dm.candidate("orders.total")).toHaveCount(0);
    });

    await test.step("accepted mapping persisted with llm-suggested provenance", async () => {
      const mappings = await listMappings(token, projectId, requirementId);
      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toMatchObject({
        tableName: "orders",
        columnName: "total",
        source: "llm-suggested",
        confidence: 0.92,
      });
    });
  });
});
