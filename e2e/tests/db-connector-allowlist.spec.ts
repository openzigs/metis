/**
 * Epic #880 / Sub-issue #882 — Per-connector table/column allow-list UI.
 *
 * Scope: the ONLY UI change in PR #888 is the addition of "Allowed tables" and
 * "Allowed columns" inputs to the Database connector form on
 * `/projects/:id/connections`. These tests verify the user-facing slice of
 * #882:
 *
 *   - The allow-list inputs render on the DB connector form.
 *   - They accept comma-separated table/column identifiers.
 *   - Saving the connector persists the allow-list into
 *     `DatabaseConnection.options` (verified by round-tripping the GET API).
 *   - Persistence survives a page reload.
 *   - Leaving the inputs blank persists NO allow-list (documented allow-all
 *     default; read-only validation still applies server-side).
 *
 * Out of scope (covered by server unit tests, NOT e2e): the actual
 * `whiteListCheck` enforcement inside `sql-validator`, and the
 * `query_database` / `inspect_schema` rejection paths — those require a live
 * database and the AI tool loop, which this deterministic offline suite does
 * not stand up.
 *
 * The DB connector create form only requires a label (no host / live DB),
 * so connectors persist with status `pending` without any external service.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ConnectionsPage } from "../pages/connections.page.js";

const API_BASE = apiBase();

interface PersistedAllowList {
  tables?: string[];
  columns?: string[];
}

/** Fetch a DB connector by label via the API and parse its `options` blob. */
async function fetchConnectorOptions(
  accessToken: string,
  projectId: string,
  label: string,
): Promise<{ options: string | null; allowList: PersistedAllowList | null }> {
  const ctx: APIRequestContext = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
  try {
    const res = await ctx.get(`/api/projects/${projectId}/connectors/dbs`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data: Array<{ label: string; options: string | null }> };
    const conn = body.data.find((c) => c.label === label);
    expect(conn, `connector "${label}" should exist`).toBeTruthy();
    const options = conn!.options;
    const allowList = options
      ? ((JSON.parse(options) as { allowList?: PersistedAllowList }).allowList ?? null)
      : null;
    return { options, allowList };
  } finally {
    await ctx.dispose();
  }
}

test.describe("Issue #882 — DB connector table/column allow-list", () => {
  let projectId: string;
  let accessToken: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-allowlist-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Allowlist ${slug}`, slug, description: "issue-882 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    projectId = body.data?.id ?? body.id;
    await ctx.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("admin", "password");
  });

  // AC #882: "Allow-list is editable in the connector UI."
  test("renders Allowed tables / Allowed columns inputs on the DB connector form", async ({
    page,
  }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    await test.step("both allow-list inputs are present and empty", async () => {
      await expect(connections.dbAllowTablesInput).toBeVisible();
      await expect(connections.dbAllowColumnsInput).toBeVisible();
      await expect(connections.dbAllowTablesInput).toHaveValue("");
      await expect(connections.dbAllowColumnsInput).toHaveValue("");
    });

    await test.step("inputs advertise comma/newline-separated usage", async () => {
      await expect(connections.dbAllowTablesInput).toHaveAttribute(
        "placeholder",
        "people, orders, public.invoices",
      );
      await expect(connections.dbAllowColumnsInput).toHaveAttribute(
        "placeholder",
        "id, name, created_at",
      );
      await expect(
        page.getByText("When set, AI queries may only touch these tables.", { exact: false }),
      ).toBeVisible();
    });
  });

  // AC #882: "Allow-list is editable in the connector UI." (input acceptance)
  test("accepts comma-separated table and column identifiers", async ({ page }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    await connections.dbAllowTablesInput.fill("people, orders, public.invoices");
    await connections.dbAllowColumnsInput.fill("id, name, created_at");

    await expect(connections.dbAllowTablesInput).toHaveValue("people, orders, public.invoices");
    await expect(connections.dbAllowColumnsInput).toHaveValue("id, name, created_at");
  });

  // AC #882: "Allow-list is persisted on `DatabaseConnection.options`."
  test("persists the allow-list into options when saving a connector", async ({ page }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    const label = `pg-allow-${Date.now()}`;
    await test.step("create a connector with an allow-list", async () => {
      await connections.addDbConnector({
        label,
        allowTables: "people, orders, public.invoices",
        allowColumns: "id, name, created_at",
      });
    });

    await test.step("options round-trips with the parsed allow-list", async () => {
      const { allowList } = await fetchConnectorOptions(accessToken, projectId, label);
      expect(allowList).not.toBeNull();
      expect(allowList!.tables).toEqual(["people", "orders", "public.invoices"]);
      expect(allowList!.columns).toEqual(["id", "name", "created_at"]);
    });
  });

  // AC #882: persistence survives a reload (server-side round-trip).
  test("allow-list survives a page reload", async ({ page }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    const label = `pg-reload-${Date.now()}`;
    await connections.addDbConnector({ label, allowTables: "customers" });

    await test.step("reload still shows the connector", async () => {
      await page.reload();
      await expect(connections.heading).toBeVisible();
      await expect(page.getByText(label)).toBeVisible();
    });

    await test.step("allow-list is still persisted after reload", async () => {
      const { allowList } = await fetchConnectorOptions(accessToken, projectId, label);
      expect(allowList).not.toBeNull();
      expect(allowList!.tables).toEqual(["customers"]);
    });
  });

  // AC #882: trims whitespace and de-duplicates identifiers (splitIdentifiers).
  test("trims and de-duplicates table identifiers before persisting", async ({ page }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    const label = `pg-dedup-${Date.now()}`;
    await connections.addDbConnector({
      label,
      allowTables: "  people ,people,  orders ,people",
    });

    const { allowList } = await fetchConnectorOptions(accessToken, projectId, label);
    expect(allowList).not.toBeNull();
    expect(allowList!.tables).toEqual(["people", "orders"]);
  });

  // AC #882: "Given no allow-list configured ... existing read-only behavior is
  // preserved (allow-all default)." The UI slice: blank inputs persist NO
  // allow-list — options stays unset rather than an empty list.
  test("leaving the allow-list blank persists no allow-list (allow-all default)", async ({
    page,
  }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    const label = `pg-noallow-${Date.now()}`;
    await connections.addDbConnector({ label });

    const { options, allowList } = await fetchConnectorOptions(accessToken, projectId, label);
    expect(options).toBeNull();
    expect(allowList).toBeNull();
  });
});
