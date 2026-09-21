/**
 * E2E — Analysis degraded-mode capability signals (issue #733, epic #725).
 *
 * A fresh project has no code graph, no ingested repository source, and the
 * grounding feature flags default off — i.e. it is a *degraded* project. The
 * pipeline used to swallow this silently; #733 surfaces it in two places:
 *
 *   - Start-analysis form: a pre-run capability HINT warns which capabilities
 *     the run will (not) have, gated by the selected agents.
 *   - Results page: a degradation BANNER on a completed run explains, in plain
 *     language, what was not analyzed and how to fix it.
 *
 * The "fully-capable project shows no banner" half of the AC is covered by the
 * UI unit tests (a fully-capable project needs a built code graph + ingested
 * source, which is out of scope to construct in a browser E2E).
 *
 * Acceptance criteria covered:
 *   AC1: degraded run completes → explanatory banner (not silence).
 *   AC3: start-analysis form on a degraded project → capability hint shown.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Analysis capability signals (#733)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const slug = `e2e-capability-${Date.now()}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: { name: `Capability ${slug}`, slug, description: "capability signals e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await api.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC3 — the form warns, before a run, that code analysis will be limited.
  test("start-analysis form shows the capability hint for a degraded project", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    // Code is a default-selected agent, so the code-related hints apply.
    await expect(analysis.capabilityHint).toBeVisible({ timeout: 30_000 });
    await expect(analysis.capabilityHint).toContainText(/no code graph/i);
    await expect(analysis.capabilityHint).toContainText(
      /Repository source code has not been ingested/i,
    );
  });

  // AC1 — a completed degraded run explains what was not analyzed on the results.
  test("completed degraded run shows the capability banner", async ({ page }) => {
    const analysis = new AnalysisPage(page);
    await analysis.goto(projectId);

    await test.step("start a run with the default agents", async () => {
      await expect(analysis.runButton).toBeEnabled();
      await analysis.runButton.click();
      await expect(page.getByRole("heading", { name: /^Run / })).toBeVisible({ timeout: 60_000 });
    });

    await test.step("the degradation banner is shown with actionable copy", async () => {
      await expect(analysis.capabilityBanner).toBeVisible({ timeout: 90_000 });
      await expect(analysis.capabilityBanner).toContainText(
        /Some analysis capabilities were limited/i,
      );
      await expect(analysis.capabilityBanner).toContainText(/no code graph/i);
    });
  });

  // #741 — the multi-repo budget-cap resume action. Constructing a real
  // budget-capped multi-repo run in a browser is impractical (needs a built code
  // graph + several connectors + a starved budget), so — following this spec's
  // own precedent of delegating hard-to-construct states to unit tests — we take
  // a REAL completed snapshot and patch only `skippedRepos` into its capability
  // record on the wire. That exercises the true banner→endpoint wiring without
  // fabricating the payload shape.
  test("skipped-repo banner exposes a working resume action (#741)", async ({ page }) => {
    const analysis = new AnalysisPage(page);

    // Inject a skipped repo into the live analysis snapshot (GET /api/analyses/:id).
    await page.route(
      (url) => /\/api\/analyses\/[^/]+$/.test(url.pathname),
      async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const resp = await route.fetch();
        const body = (await resp.json().catch(() => null)) as {
          data?: { capability?: { skippedRepos?: unknown[]; reasons?: string[] } };
        } | null;
        const cap = body?.data?.capability;
        if (cap && Array.isArray(cap.reasons)) {
          cap.skippedRepos = [{ connectorId: "c-extra", label: "extra-repo" }];
          if (!cap.reasons.includes("repos-skipped-budget")) {
            cap.reasons.push("repos-skipped-budget");
          }
          return route.fulfill({ response: resp, json: body });
        }
        return route.fulfill({ response: resp });
      },
    );

    // Capture the resume call and short-circuit it (202 accepted).
    let resumeCalled = false;
    await page.route("**/api/analyses/*/resume-repos", async (route) => {
      resumeCalled = true;
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { accepted: true, willResume: [{ connectorId: "c-extra", label: "extra-repo" }] },
        }),
      });
    });

    await analysis.goto(projectId);
    await expect(analysis.runButton).toBeEnabled();
    await analysis.runButton.click();

    await test.step("the banner names the skipped repo and offers the resume action", async () => {
      await expect(analysis.capabilityBanner).toBeVisible({ timeout: 90_000 });
      const reason = page.getByTestId("capability-reason-repos-skipped-budget");
      await expect(reason).toContainText(/extra-repo/i);
      await expect(page.getByTestId("resume-skipped-repos")).toBeVisible();
    });

    await test.step("clicking the action calls the resume endpoint", async () => {
      await page.getByTestId("resume-skipped-repos").click();
      await expect.poll(() => resumeCalled, { timeout: 10_000 }).toBe(true);
    });
  });
});
