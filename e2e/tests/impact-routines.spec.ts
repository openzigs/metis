/**
 * Epic #293 Phase 2 (#302) — Procedures & functions in impact analysis (e2e).
 *
 * Phase 2 extends the impact-analysis affected-objects UI so database
 * **procedures & functions** are surfaced alongside tables/columns. These tests
 * map directly to the #302 acceptance criteria:
 *
 *   AC1 — Routines are classified `used | unreferenced | uncertain` and rendered
 *         alongside tables/columns (in the Phase 1 UsageClassificationSection).
 *   AC2 — Impact output and the affected-tables UI surface routines (the
 *         "Affected procedures & functions" sub-section of AffectedTablesSection).
 *   AC3 — Proc/func bodies are treated as `uncertain` evidence and are NEVER
 *         auto-recommended for drop: an unanalysed routine body classifies as
 *         `uncertain` (reason `routine-body-unanalyzed`), and there is no
 *         drop/alter affordance — only a verify-only note.
 *
 * Seeding strategy (see e2e/fixtures/seed-impact-routines.ts):
 *   The affected routines + their classification are normally computed by
 *   introspecting a live DB connector and reconciling against the code→schema
 *   graph — a path the offline e2e stack cannot reproduce deterministically. So
 *   the spec seeds the *persisted output* (an ImpactAnalysis whose item has
 *   table+procedure+function affectedTables, plus matching
 *   SchemaUsageClassification rows) and drives the real read route + real React
 *   rendering. Only the upstream introspection is short-circuited. No real DB
 *   connector / network is used.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import path from "node:path";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedImpactRoutinesViaCli } from "../fixtures/seed-impact-routines.js";
import { LoginPage } from "../pages/login.page.js";
import { AffectedRoutinesPage } from "../pages/affected-routines.page.js";

const API_BASE = apiBase();

/** The forbidden destructive affordances a routine view must never expose. */
const FORBIDDEN_AFFORDANCES = ["drop", "alter", "remove", "delete"] as const;

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
  const slug = `e2e-routines-${suffix}-${Date.now()}`;
  const res = await api.post("/api/projects", {
    data: { name: `Impact Routines ${slug}`, slug, description: "epic-293 #302 e2e" },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  return (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
}

test.describe("Epic #293 Phase 2 (#302) — Routine classification API", () => {
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

  // AC1 + AC3 (data contract): the usage-classification read route returns
  // routine rows (kind = procedure|function) classified used/uncertain, and the
  // uncertain function carries the routine-body-unanalyzed reason — never a drop.
  test("GET surfaces routines classified used / uncertain with a body-unanalysed reason", async () => {
    seedImpactRoutinesViaCli({ projectId, databaseUrl: e2eDatabaseUrl() });

    const res = await api.get(`/api/impact-analyses/projects/${projectId}/usage-classification`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    const rows = body.data as Array<{
      kind: string;
      tableName: string;
      usageClass: string;
      uncertainReason: string | null;
    }>;

    const proc = rows.find((r) => r.kind === "procedure");
    const fn = rows.find((r) => r.kind === "function");

    await test.step("a procedure invoked from code is classified used", async () => {
      expect(proc).toBeTruthy();
      expect(proc?.usageClass).toBe("used");
    });

    await test.step("a function whose body is unanalysed is uncertain, never dropped", async () => {
      expect(fn).toBeTruthy();
      expect(fn?.usageClass).toBe("uncertain");
      expect(fn?.uncertainReason).toBe("routine-body-unanalyzed");
    });
  });
});

test.describe("Epic #293 Phase 2 (#302) — Procedures & functions in impact UI", () => {
  let accessToken: string;
  let projectId: string;
  let analysisId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const api = await authedApi(accessToken);
    projectId = await createProject(api, "ui");
    await api.dispose();

    const seeded = seedImpactRoutinesViaCli({
      projectId,
      databaseUrl: e2eDatabaseUrl(),
    });
    analysisId = seeded.analysisId;

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC2: the affected-tables UI surfaces routines in a dedicated
  // "Affected procedures & functions" sub-section, alongside affected tables.
  test("affected-objects UI surfaces procedures & functions alongside tables", async ({ page }) => {
    const view = new AffectedRoutinesPage(page);
    await view.goto(analysisId);

    await expect(view.detailRoot).toBeVisible();
    await expect(view.schemaImpactSection).toBeVisible();

    await test.step("a relational table is still rendered (routines are *alongside*)", async () => {
      await expect(view.tableRows).toHaveCount(1);
    });

    await test.step("the procedures & functions sub-section is present and labelled", async () => {
      await expect(view.routinesSection).toBeVisible();
      await expect(view.routinesHeading).toBeVisible();
    });

    await test.step("one procedure and one function row are rendered", async () => {
      await expect(view.routineRows).toHaveCount(2);
      await expect(view.routineRowsByKind("procedure")).toHaveCount(1);
      await expect(view.routineRowsByKind("function")).toHaveCount(1);
    });

    await test.step("each routine row shows its qualified name and a kind badge", async () => {
      const proc = view.routineRowByName("public.recalc_order_totals");
      await expect(proc).toBeVisible();
      await expect(view.kindBadgeIn(proc)).toHaveText("procedure");

      const fn = view.routineRowByName("public.fn_order_discount");
      await expect(fn).toBeVisible();
      await expect(view.kindBadgeIn(fn)).toHaveText("function");
    });
  });

  // AC1: routines flow through the same used/unreferenced/uncertain
  // classification UI and are rendered alongside tables/columns.
  test("routines are classified used / uncertain in the classification UI", async ({ page }) => {
    const view = new AffectedRoutinesPage(page);
    await view.goto(analysisId);

    await expect(view.usageSection).toBeVisible();
    // 1 table (used) + 1 procedure (used) + 1 function (uncertain) = 3 rows.
    await expect(view.usageRows).toHaveCount(3);

    await test.step("the invoked procedure carries a Used badge", async () => {
      const proc = view.usageRowByName("public.recalc_order_totals");
      await expect(proc).toHaveCount(1);
      await expect(view.usageBadgeIn(proc)).toHaveText("Used");
      await expect(view.usageBadgeIn(proc)).toHaveAttribute("data-usage-class", "used");
    });

    await test.step("the unanalysed function carries an Uncertain badge", async () => {
      const fn = view.usageRowByName("public.fn_order_discount");
      await expect(fn).toHaveCount(1);
      await expect(view.usageBadgeIn(fn)).toHaveText("Uncertain");
      await expect(view.usageBadgeIn(fn)).toHaveAttribute("data-usage-class", "uncertain");
    });

    await test.step("classes coexist with the relational table row", async () => {
      await expect(view.usageRowsForClass("used")).toHaveCount(2);
      await expect(view.usageRowsForClass("uncertain")).toHaveCount(1);
    });
  });

  // AC3: a proc/func body is `uncertain` evidence, NEVER auto-recommended for
  // drop. The uncertain routine is visually distinct + reasoned, and neither the
  // classification UI nor the affected-routines UI exposes any destructive DDL.
  test("routine bodies are uncertain evidence — never recommended for drop", async ({ page }) => {
    const view = new AffectedRoutinesPage(page);
    await view.goto(analysisId);

    await test.step("the uncertain function is visually distinct + carries a reason", async () => {
      const fn = view.usageRowByName("public.fn_order_discount");
      const badge = view.usageBadgeIn(fn);
      await expect(badge).toHaveAttribute("data-distinct", "true");
      await expect(view.uncertainReasonIn(fn)).toBeVisible();
      await expect(view.uncertainReasonIn(fn)).toHaveText(/routine-body-unanalyzed/);
    });

    await test.step("affected-routine notes are verify-only, not drop/alter DDL", async () => {
      const proc = view.routineRowByName("public.recalc_order_totals");
      await expect(view.noteIn(proc)).toBeVisible();
      await expect(view.noteIn(proc)).toHaveText(/verify only/i);
      await expect(view.noteIn(proc)).not.toHaveText(/drop|alter/i);

      const fn = view.routineRowByName("public.fn_order_discount");
      await expect(view.noteIn(fn)).toHaveText(/verify only/i);
      await expect(view.noteIn(fn)).not.toHaveText(/drop|alter/i);
    });

    await test.step("no drop/alter/remove/delete affordance in the routines sub-section", async () => {
      for (const word of FORBIDDEN_AFFORDANCES) {
        const re = new RegExp(word, "i");
        await expect(view.routinesSection.getByRole("button", { name: re })).toHaveCount(0);
        await expect(view.routinesSection.getByRole("link", { name: re })).toHaveCount(0);
        await expect(view.routinesSection.getByRole("menuitem", { name: re })).toHaveCount(0);
      }
    });

    await test.step("no drop/alter/remove/delete affordance in the classification UI", async () => {
      for (const word of FORBIDDEN_AFFORDANCES) {
        const re = new RegExp(word, "i");
        await expect(view.usageSection.getByRole("button", { name: re })).toHaveCount(0);
        await expect(view.usageSection.getByRole("link", { name: re })).toHaveCount(0);
      }
    });
  });
});
