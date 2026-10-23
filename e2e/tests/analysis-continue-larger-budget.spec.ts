/**
 * E2E — "Continue with a larger budget" (issue #1131).
 *
 * In #706 run 8 Continue cost more than the run it continued, showed nothing
 * while it ran, and was offered for requirements the code agent had already
 * reached (inconclusive, not unreached). This spec drives the banner on the
 * analysis page:
 *
 *   AC1: before it starts, Continue states what it re-runs and an estimate.
 *   AC2: while the rerun goes, the page shows it in progress.
 *   AC4/AC6: an inconclusive-only run offers no Continue and names them.
 *
 * No model is called. As in `analysis-capability-signals.spec.ts`, a REAL
 * completed analysis is seeded and only its snapshot's capability record (and
 * the fields this issue adds) is patched on the wire; the Continue request is
 * intercepted, so nothing re-runs.
 */
import { test, expect, request, type Page } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedGroundedAnalysisViaCli } from "../fixtures/seed-helpers.js";

const API_BASE = apiBase();

type Snapshot = {
  status?: string;
  capability?: Record<string, unknown> & { reasons?: string[] };
  ledgerUsage?: unknown;
  liveAgents?: unknown[];
  codeContinuation?: unknown;
};

/** Patch every GET of the analysis snapshot with `patch`. */
async function patchSnapshot(page: Page, patch: (data: Snapshot) => void): Promise<void> {
  await page.route(
    (url) => /\/api\/analyses\/[^/]+$/.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      let status = 200;
      let headers: Record<string, string> = { "content-type": "application/json" };
      let text = "";
      try {
        const resp = await route.fetch();
        status = resp.status();
        headers = resp.headers();
        text = await resp.text();
      } catch {
        return route.fallback();
      }
      let body: { data?: Snapshot } | null = null;
      try {
        body = JSON.parse(text) as { data?: Snapshot };
      } catch {
        body = null;
      }
      if (body?.data?.capability && Array.isArray(body.data.capability.reasons)) {
        patch(body.data);
        return route.fulfill({ status, headers, body: JSON.stringify(body) });
      }
      return route.fulfill({ status, headers, body: text });
    },
  );
}

/** The capability fields of a code pass that ran out of budget. */
function cutShort(data: Snapshot, gap: { unreached: number; inconclusive: number; total: number }) {
  const cap = data.capability!;
  cap.codeAnalysisRequested = true;
  cap.codeInvestigationCutShort = true;
  cap.codeInvestigationUnreached = gap;
  const reason =
    gap.unreached > 0 ? "code-investigation-cut-short" : "code-investigation-inconclusive";
  cap.reasons = [...(cap.reasons ?? []).filter((r) => !r.startsWith("code-investigation")), reason];
}

test.describe("Continue with a larger budget (#1131)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${primed.accessToken}` },
    });
    const slug = `e2e-continue-${Date.now()}`;
    const res = await api.post("/api/projects", {
      data: { name: `Continue ${slug}`, slug, description: "continue e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    await api.dispose();

    const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE}`;
    seedGroundedAnalysisViaCli({ projectId, startedById: primed.userId, databaseUrl });

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("Continue - states what it re-runs and an estimate before it starts", async ({ page }) => {
    await patchSnapshot(page, (data) => {
      cutShort(data, { unreached: 3, inconclusive: 2, total: 19 });
      data.codeContinuation = { tokenBudget: 200_000, budgetMultiplier: 2 };
      data.ledgerUsage = { totalTokens: 400_000, costUsd: 0.1084, unpricedTokens: 0 };
    });
    let continueBody: unknown = null;
    await page.route("**/api/analyses/*/agents/code/regenerate", async (route) => {
      continueBody = route.request().postDataJSON();
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: { accepted: true } }),
      });
    });

    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    await expect(analysis.capabilityBanner).toBeVisible({ timeout: 90_000 });

    await test.step("the first click asks, with the scope and the estimate", async () => {
      await page.getByRole("button", { name: "Continue with a larger budget…" }).click();
      const confirm = page.getByRole("group", { name: "Continue the code analysis" });
      await expect(confirm).toContainText(
        "only the 3 of 19 requirements the code analysis did not reach",
      );
      await expect(confirm).toContainText("2 inconclusive requirements are not re-run");
      await expect(confirm).toContainText("up to 200.0k tokens");
      await expect(confirm).toContainText("about $0.0542");
      expect(continueBody).toBeNull();
    });

    await test.step("confirming starts the continuation", async () => {
      await page.getByRole("button", { name: "Start the continuation" }).click();
      await expect.poll(() => continueBody, { timeout: 10_000 }).toEqual({ extendBudget: true });
    });
  });

  test("Continue - a rerun in progress shows on the summary", async ({ page }) => {
    await patchSnapshot(page, (data) => {
      cutShort(data, { unreached: 3, inconclusive: 2, total: 19 });
      data.status = "running";
      data.liveAgents = [
        {
          agentKey: "code",
          startedAt: new Date(Date.now() - 64_000).toISOString(),
          toolCalls: 12,
          rerun: true,
          phase: "investigating",
          continuation: { requirements: 3, total: 19 },
        },
      ];
    });

    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    await expect(analysis.capabilityBanner).toContainText(
      "Rerun in progress: re-investigating 3 of 19 requirements",
      { timeout: 90_000 },
    );
    await expect(analysis.capabilityBanner).toContainText("12 steps so far");
    await expect(page.getByRole("button", { name: /Continue with a larger budget/ })).toHaveCount(
      0,
    );
  });

  test("Continue - is not offered when the only gaps are inconclusive", async ({ page }) => {
    await patchSnapshot(page, (data) => {
      cutShort(data, { unreached: 0, inconclusive: 3, total: 19 });
      data.codeContinuation = null;
    });

    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);
    await expect(analysis.capabilityBanner).toContainText("3 of 19 requirements are inconclusive", {
      timeout: 90_000,
    });
    await expect(analysis.capabilityBanner).toContainText(/a larger budget would not change/i);
    await expect(page.getByRole("button", { name: /Continue with a larger budget/ })).toHaveCount(
      0,
    );
  });
});
