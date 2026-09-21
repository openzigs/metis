/**
 * E2E — database-aware analysis settings control + result-view status
 * indicator (Issue #861, Epic #852 Phase 5b).
 *
 * The per-project `databaseAwareAnalysis` setting (#858's settings card) and
 * the analysis result badge (#859's indicator) both surface the SAME #854
 * resolver decision that gates the run path (#855) and the gap-report path
 * (#856). A fresh project has no connected database and no schema graph, so
 * it deterministically exercises the resolver's "no schema data" branch —
 * exactly like `analysis-capability-signals.spec.ts` uses a fresh project's
 * degraded state as its natural, reachable fixture (constructing a project
 * with REAL schema data in a browser E2E is out of scope; that reachability
 * proof lives in the server integration suite,
 * `server/src/lib/analysis/database-aware-e2e-reachability.test.ts`).
 *
 * Acceptance criteria covered:
 *   - #858: the settings card renders the resolved state and the no-schema-
 *     data hint, and Save persists a new setting + updates the resolved copy.
 *   - #859: the result-view badge reflects the resolved reason (`data-reason`)
 *     and tone, using the SAME injected-snapshot technique the "skipped-repo
 *     banner" test (`analysis-capability-signals.spec.ts`) established for
 *     result states that are impractical to construct via a real run.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectDetailPage } from "../pages/project.page.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Database-aware analysis — settings control + status indicator (#861)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const slug = `e2e-db-aware-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: { name: `DB Aware ${slug}`, slug, description: "database-aware analysis e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { data: { project: { id: string } } };
    projectId = body.data.project.id;
    await api.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("settings card shows the resolved auto/no-data state, and Save updates the resolved state for on/off", async ({
    page,
  }) => {
    const detail = new ProjectDetailPage(page);
    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });

    await test.step("a fresh project resolves 'auto' with no schema data — hint links to Connections", async () => {
      await expect(detail.databaseAwareCard).toBeVisible({ timeout: 15_000 });
      await expect(detail.databaseAwareSelect).toHaveValue("auto");
      await expect(detail.databaseAwareResolvedState).toContainText(/Currently OFF/i);
      await expect(detail.databaseAwareResolvedState).toContainText(/will activate automatically/i);
      await expect(detail.databaseAwareNoSchemaDataHint).toBeVisible();
      await expect(detail.databaseAwareConnectLink).toHaveAttribute(
        "href",
        `/projects/${projectId}/connections`,
      );
    });

    await test.step("switching to 'on' persists and resolves ON-but-not-running (still no schema data)", async () => {
      await detail.databaseAwareSelect.selectOption("on");
      await detail.databaseAwareSaveButton.click();
      await expect(detail.databaseAwareSavedToast).toBeVisible({ timeout: 10_000 });
      await expect(detail.databaseAwareResolvedState).toContainText(
        /Currently ON, but not running yet/i,
      );
      // "on" with no schema data still shows the actionable hint (#851: an
      // explicit ON is always reachable but reports the skip, never a silent no-op).
      await expect(detail.databaseAwareNoSchemaDataHint).toBeVisible();

      const api = await authedApi(accessToken);
      const res = await api.get(`/api/projects/${projectId}/database-aware-analysis`);
      expect(res.status()).toBe(200);
      const persisted = (await res.json()) as { data: { setting: string; reason: string } };
      expect(persisted.data.setting).toBe("on");
      expect(persisted.data.reason).toBe("skipped-no-schema-data");
      await api.dispose();
    });

    await test.step("switching to 'off' persists as an explicit override and hides the hint", async () => {
      await detail.databaseAwareSelect.selectOption("off");
      await detail.databaseAwareSaveButton.click();
      await expect(detail.databaseAwareSavedToast).toBeVisible({ timeout: 10_000 });
      await expect(detail.databaseAwareResolvedState).toContainText(
        /Currently OFF \(explicit override\)/i,
      );
      // An explicit "off" never shows the no-schema-data hint, even without data.
      await expect(detail.databaseAwareNoSchemaDataHint).not.toBeAttached();

      const api = await authedApi(accessToken);
      const res = await api.get(`/api/projects/${projectId}/database-aware-analysis`);
      expect(res.status()).toBe(200);
      const persisted = (await res.json()) as { data: { setting: string; reason: string } };
      expect(persisted.data.setting).toBe("off");
      expect(persisted.data.reason).toBe("off");
      await api.dispose();
    });
  });

  test("result-view badge reflects the resolved databaseAware reason (on / off / skipped)", async ({
    page,
  }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("start a run so a completed analysis exists to inspect", async () => {
      await expect(analysis.runButton).toBeEnabled();
      await analysis.runButton.click();
      await expect(page.getByRole("heading", { name: /^Run / })).toBeVisible({ timeout: 60_000 });
    });

    // The wire GET /api/analyses/:id payload is intercepted and patched with a
    // `databaseAware` decision, mirroring the established technique
    // `analysis-capability-signals.spec.ts` uses for the "skipped-repo banner"
    // case — an end-to-end run genuinely resolving `enabled` needs real schema
    // data, which the server integration suite (#861's other deliverable)
    // already proves; this half proves the UI renders whatever the resolver
    // decided, using its exact reason vocabulary.
    async function injectDatabaseAware(databaseAware: {
      setting: string;
      enabled: boolean;
      ran: boolean;
      reason: string;
    }): Promise<void> {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.route(
        (url) => /\/api\/analyses\/[^/]+$/.test(url.pathname),
        async (route) => {
          if (route.request().method() !== "GET") return route.fallback();
          const resp = await route.fetch();
          const body = (await resp.json().catch(() => null)) as {
            data?: Record<string, unknown>;
          } | null;
          if (body?.data) {
            body.data.databaseAware = databaseAware;
            return route.fulfill({ response: resp, json: body });
          }
          return route.fulfill({ response: resp });
        },
      );
      await page.reload({ waitUntil: "load" });
    }

    await test.step("reason 'auto->resolved-on' renders the 'on' badge (emerald tone)", async () => {
      await injectDatabaseAware({
        setting: "auto",
        enabled: true,
        ran: true,
        reason: "auto->resolved-on",
      });
      await expect(analysis.databaseAwareBadge).toBeVisible({ timeout: 15_000 });
      await expect(analysis.databaseAwareBadge).toHaveAttribute("data-reason", "auto->resolved-on");
      await expect(analysis.databaseAwareBadge).toContainText(/Database-aware analysis: on/i);
      await expect(analysis.databaseAwareSkippedHint).not.toBeAttached();
    });

    await test.step("reason 'off' renders the 'off' badge with no remediation hint", async () => {
      await injectDatabaseAware({ setting: "off", enabled: false, ran: false, reason: "off" });
      await expect(analysis.databaseAwareBadge).toHaveAttribute("data-reason", "off");
      await expect(analysis.databaseAwareBadge).toContainText(/Database-aware analysis: off/i);
      await expect(analysis.databaseAwareSkippedHint).not.toBeAttached();
    });

    await test.step("reason 'skipped-no-schema-data' renders the skipped badge + Connections hint", async () => {
      await injectDatabaseAware({
        setting: "on",
        enabled: true,
        ran: false,
        reason: "skipped-no-schema-data",
      });
      await expect(analysis.databaseAwareBadge).toHaveAttribute(
        "data-reason",
        "skipped-no-schema-data",
      );
      await expect(analysis.databaseAwareBadge).toContainText(/Database-aware analysis: skipped/i);
      await expect(analysis.databaseAwareSkippedHint).toBeVisible();
      await expect(analysis.databaseAwareConnectionsLink).toHaveAttribute(
        "href",
        `/projects/${projectId}/connections`,
      );
    });
  });
});
