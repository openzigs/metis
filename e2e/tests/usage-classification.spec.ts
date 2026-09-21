/**
 * Epic #292 (#298) — Usage Classification UI e2e tests.
 *
 * The project-impact view now surfaces a per-object used/unreferenced/uncertain
 * classification. These tests map directly to the #298 acceptance criteria:
 *
 *   AC1 — each schema object shows a used | unreferenced | uncertain badge,
 *         with an evidence tooltip on the used / uncertain ones.
 *   AC2 — an "Only show used" toggle narrows the list to `used` objects, while
 *         the FULL schema remains accessible when the toggle is off.
 *   AC3 — `uncertain` objects are visually distinct (destructive/distinct badge
 *         variant) and labelled with a reason.
 *   AC4 — there is NO drop / remove / delete affordance anywhere in this view.
 *   AC5 — the section is accessible: a labelled region + a native checkbox
 *         toggle reachable by keyboard.
 *
 * Seeding strategy (see e2e/fixtures/seed-usage-classification.ts):
 *   The classification is normally computed by introspecting a live DB
 *   connector and reconciling it against the code→schema graph (#296/#297) —
 *   a path the offline e2e stack cannot reproduce deterministically. So the
 *   spec seeds the *persisted output* (an ImpactAnalysis with one item + a
 *   fixed set of SchemaUsageClassification rows) straight into the e2e DB and
 *   then drives the real `GET .../usage-classification` route and the real
 *   React rendering. Only the upstream introspection is short-circuited.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import path from "node:path";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedUsageClassificationViaCli } from "../fixtures/seed-usage-classification.js";
import { LoginPage } from "../pages/login.page.js";
import { UsageClassificationPage } from "../pages/usage-classification.page.js";

const API_BASE = apiBase();

/** The forbidden destructive affordances this read-only view must never expose. */
const FORBIDDEN_AFFORDANCES = ["drop", "remove", "delete"] as const;

/** Resolve the e2e SQLite database URL (mirrors global-setup). */
function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const dbFile =
    process.env.E2E_DB_FILE ??
    path.join(process.cwd(), "test-results", "stack-data", "metis-e2e.db");
  return `file:${dbFile}`;
}

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function createProject(api: APIRequestContext, suffix: string): Promise<string> {
  const slug = `e2e-usage-${suffix}-${Date.now()}`;
  const res = await api.post("/api/projects", {
    data: { name: `Usage Classification ${slug}`, slug, description: "epic-292 #298 e2e" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
}

test.describe("Epic #292 (#298) — Usage Classification API", () => {
  let accessToken: string;
  let projectId: string;
  let api: APIRequestContext;

  test.beforeEach(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    api = await authedApi(accessToken);
    projectId = await createProject(api, "api");
  });

  test.afterEach(async () => {
    await api.dispose();
  });

  // AC1/AC3: the GET route returns the persisted classification with class,
  // evidence and the uncertain reason intact (the data the UI renders).
  test("GET returns seeded used / unreferenced / uncertain rows", async () => {
    seedUsageClassificationViaCli({ projectId, databaseUrl: e2eDatabaseUrl() });

    const res = await api.get(`/api/impact-analyses/projects/${projectId}/usage-classification`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const rows = body.data as Array<{
      usageClass: string;
      uncertainReason: string | null;
      evidence: unknown[];
    }>;
    const byClass = (c: string) => rows.filter((r) => r.usageClass === c);

    expect(byClass("used").length).toBe(2);
    expect(byClass("unreferenced").length).toBe(1);
    expect(byClass("uncertain").length).toBe(1);

    // uncertain carries a non-null reason; used carries evidence.
    expect(byClass("uncertain")[0].uncertainReason).toBeTruthy();
    expect(byClass("used")[0].evidence.length).toBeGreaterThan(0);
  });

  // Tenant isolation — auth middleware is enforced on the read route.
  test("GET rejects unauthenticated requests", async () => {
    const unauthApi = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await unauthApi.get(
        `/api/impact-analyses/projects/${projectId}/usage-classification`,
      );
      expect(res.status()).toBe(401);
    } finally {
      await unauthApi.dispose();
    }
  });
});

test.describe("Epic #292 (#298) — Usage Classification UI", () => {
  let accessToken: string;
  let projectId: string;
  let analysisId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const api = await authedApi(accessToken);
    projectId = await createProject(api, "ui");
    await api.dispose();

    // Seed the persisted classification + an impact analysis to view it in.
    const seeded = seedUsageClassificationViaCli({
      projectId,
      databaseUrl: e2eDatabaseUrl(),
    });
    analysisId = seeded.analysisId;

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC1: each schema object shows a used | unreferenced | uncertain badge,
  // and the used / uncertain ones expose evidence via the badge tooltip.
  test("renders a usage badge per object with an evidence tooltip", async ({ page }) => {
    const usage = new UsageClassificationPage(page);
    await usage.goto(analysisId);

    await expect(usage.section).toBeVisible();
    // 2 used + 1 unreferenced + 1 uncertain = 4 rows / 4 badges.
    await expect(usage.rows).toHaveCount(4);
    await expect(usage.badges).toHaveCount(4);

    await test.step("each badge shows its class label", async () => {
      await expect(usage.badges.filter({ hasText: "Used" })).toHaveCount(2);
      await expect(usage.badges.filter({ hasText: "Unreferenced" })).toHaveCount(1);
      await expect(usage.badges.filter({ hasText: "Uncertain" })).toHaveCount(1);
    });

    await test.step("used + uncertain badges carry evidence in their tooltip", async () => {
      const usedRow = usage.rowByName("public.orders").first();
      // Tooltip is exposed via the badge `title` attribute (#298 a11y contract).
      await expect(usage.badgeIn(usedRow)).toHaveAttribute("title", /OrderMapper/);

      const uncertainRow = usage.rowsForClass("uncertain").first();
      await expect(usage.badgeIn(uncertainRow)).toHaveAttribute(
        "title",
        /LegacyMapper|table-not-found/,
      );
    });
  });

  // AC2: the "Only show used" toggle narrows the list to used objects; turning
  // it off restores the FULL schema (unreferenced + uncertain reappear).
  test("'Only show used' toggle narrows to used and restores the full schema", async ({ page }) => {
    const usage = new UsageClassificationPage(page);
    await usage.goto(analysisId);

    await expect(usage.rows).toHaveCount(4);
    await expect(usage.onlyUsedToggle).not.toBeChecked();

    await test.step("toggle on → only the 2 used objects remain", async () => {
      await usage.onlyUsedToggle.check();
      await expect(usage.onlyUsedToggle).toBeChecked();
      await expect(usage.rows).toHaveCount(2);
      await expect(usage.rowsForClass("used")).toHaveCount(2);
      await expect(usage.rowsForClass("unreferenced")).toHaveCount(0);
      await expect(usage.rowsForClass("uncertain")).toHaveCount(0);
    });

    await test.step("toggle off → the full schema is accessible again", async () => {
      await usage.onlyUsedToggle.uncheck();
      await expect(usage.onlyUsedToggle).not.toBeChecked();
      await expect(usage.rows).toHaveCount(4);
      await expect(usage.rowsForClass("unreferenced")).toHaveCount(1);
      await expect(usage.rowsForClass("uncertain")).toHaveCount(1);
    });
  });

  // AC3: uncertain objects are visually distinct and labelled with a reason.
  test("uncertain objects are visually distinct and carry a reason", async ({ page }) => {
    const usage = new UsageClassificationPage(page);
    await usage.goto(analysisId);

    const uncertainRow = usage.rowsForClass("uncertain").first();
    await expect(uncertainRow).toBeVisible();

    await test.step("badge is marked distinct (destructive variant contract)", async () => {
      const badge = usage.badgeIn(uncertainRow);
      // The component sets data-distinct="true" only for the destructive
      // `uncertain` variant — distinct from both used and unreferenced.
      await expect(badge).toHaveAttribute("data-distinct", "true");
      await expect(badge).toHaveAttribute("data-usage-class", "uncertain");
    });

    await test.step("a human-readable reason is labelled on the row", async () => {
      await expect(usage.uncertainReasonIn(uncertainRow)).toBeVisible();
      await expect(usage.uncertainReasonIn(uncertainRow)).toHaveText(/.+/);
    });

    await test.step("used / unreferenced badges are NOT marked distinct", async () => {
      await expect(usage.badgeIn(usage.rowsForClass("used").first())).toHaveAttribute(
        "data-distinct",
        "false",
      );
      await expect(usage.badgeIn(usage.rowsForClass("unreferenced").first())).toHaveAttribute(
        "data-distinct",
        "false",
      );
    });
  });

  // AC4: there is NO drop / remove / delete affordance anywhere in this view.
  test("exposes no drop / remove / delete affordance", async ({ page }) => {
    const usage = new UsageClassificationPage(page);
    await usage.goto(analysisId);
    await expect(usage.section).toBeVisible();

    await test.step("no destructive buttons or links in the section", async () => {
      for (const word of FORBIDDEN_AFFORDANCES) {
        const re = new RegExp(word, "i");
        await expect(usage.section.getByRole("button", { name: re })).toHaveCount(0);
        await expect(usage.section.getByRole("link", { name: re })).toHaveCount(0);
        await expect(usage.section.getByRole("menuitem", { name: re })).toHaveCount(0);
      }
    });

    await test.step("the framing note states these are review candidates, not drops", async () => {
      await expect(usage.safetyNote).toBeVisible();
    });
  });

  // AC5: accessibility — labelled region + native checkbox reachable by keyboard.
  test("is accessible: labelled region and keyboard-operable checkbox", async ({ page }) => {
    const usage = new UsageClassificationPage(page);
    await usage.goto(analysisId);

    await test.step("section is a region with an accessible name", async () => {
      await expect(usage.section).toBeVisible();
    });

    await test.step("toggle is a native checkbox reachable + operable by keyboard", async () => {
      await expect(usage.onlyUsedToggle).not.toBeChecked();
      // Focus then toggle with the keyboard (Space) — proves it is a native,
      // keyboard-operable control, not a div with a click handler.
      await usage.onlyUsedToggle.focus();
      await expect(usage.onlyUsedToggle).toBeFocused();
      await page.keyboard.press("Space");
      await expect(usage.onlyUsedToggle).toBeChecked();
      await expect(usage.rowsForClass("used")).toHaveCount(2);
    });
  });
});
