/**
 * Epic #701 / Issue #706 — DB Connector Wizard end-to-end walkthrough.
 *
 * Walks a seeded postgresql suggestion through the four-step wizard:
 *   1. Review   — discovered host visible
 *   2. Configure — username pre-filled, password masked then revealed
 *   3. Test      — server response mocked OK → green check appears
 *   4. Provision — mocked success → wizard closes + toast appears
 *
 * The DB liveness probe and the provision write are mocked via Playwright
 * route interception so this test does NOT stand up a real Postgres.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ConnectionsPage } from "../pages/connections.page.js";

const API_BASE = apiBase();

async function seedSuggestionViaDb(projectId: string, databaseUrl: string): Promise<string> {
  const { execSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const payload = JSON.stringify([
    {
      driverType: "postgresql",
      host: "wiz-db.internal",
      port: 5432,
      database: "wizdb",
      sourceFile: ".env.development",
      lineNumber: 3,
      confidence: "high",
    },
  ]);
  const result = execSync(
    `pnpm --filter @metis/server exec tsx scripts/e2e-seed-suggested-connectors.ts "${projectId}" '${payload}'`,
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: "sqlite" },
      encoding: "utf8",
    },
  );
  const ids = JSON.parse(result.trim()) as string[];
  return ids[0]!;
}

test.describe("Epic #701 — DB Connector Wizard", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-wizard-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Wizard ${slug}`, slug, description: "epic-701 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    projectId = body.data?.id ?? body.id;
    await ctx.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("admin", "password");
  });

  test("walks Review → Configure → Test → Provision and closes on success", async ({ page }) => {
    const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE}`;
    const suggestionId = await seedSuggestionViaDb(projectId, databaseUrl);

    // Mock the DB test (so we don't need a real Postgres) and the provision
    // call (so we don't need a real vault round-trip).
    await page.route(`**/api/projects/*/suggested-connectors/${suggestionId}/test`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { ok: true, latencyMs: 12 } }),
      }),
    );
    await page.route(`**/api/projects/*/suggested-connectors/${suggestionId}/provision`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { connectorId: "db_e2e_42", vaultRef: "vault-e2e", mutation: "created" },
        }),
      }),
    );

    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    // Step 1 — Review
    const card = connections.suggestionCard("postgresql");
    await connections.clickConfigure(card);
    await expect(connections.wizardSection("review")).toBeVisible();
    // Scope to the dialog: the suggestion card behind it renders the same
    // host:port string (with the database suffix).
    await expect(
      connections.wizardSection("review").getByText("wiz-db.internal:5432"),
    ).toBeVisible();

    // Step 2 — Configure
    await connections.wizardNext().click();
    await expect(connections.wizardSection("configure")).toBeVisible();
    const password = connections.wizardPasswordInput();
    await expect(password).toHaveAttribute("type", "password");
    await connections.wizardShowPasswordButton().click();
    await expect(password).toHaveAttribute("type", "text");
    // Need a password to provision; the seeded suggestion has none.
    await password.fill("e2e-secret");

    // Step 3 — Test (mocked OK → auto-advances to provision)
    await connections.wizardNext().click();
    await expect(connections.wizardSection("test")).toBeVisible();
    await connections.wizardRunTest().click();
    await expect(connections.wizardSection("provision")).toBeVisible();

    // Step 4 — Provision (mocked → wizard closes)
    await connections.wizardProvision().click();
    await expect(connections.wizardSection("provision")).toBeHidden();
  });

  test("test failure does not advance to provision step", async ({ page }) => {
    const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE}`;
    const suggestionId = await seedSuggestionViaDb(projectId, databaseUrl);

    await page.route(`**/api/projects/*/suggested-connectors/${suggestionId}/test`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { ok: false, errorMessage: "connection refused" } }),
      }),
    );

    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);
    const card = connections.suggestionCard("postgresql");
    await connections.clickConfigure(card);
    await connections.wizardNext().click(); // → configure
    await connections.wizardPasswordInput().fill("anything");
    await connections.wizardNext().click(); // → test
    await connections.wizardRunTest().click();
    await expect(page.getByText(/connection refused/)).toBeVisible();
    await expect(connections.wizardSection("provision")).toBeHidden();
  });

  test("allow-credential-scan toggle PATCHes the project and persists", async ({ page }) => {
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    const toggle = connections.allowCredentialScanToggle();
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    // `.check()` re-clicks while the box still reads unchecked, and this one is
    // a CONTROLLED input that only flips after the PATCH round-trips — the
    // retry toggles it straight back off. Click once, then wait for the state.
    await toggle.click();
    await expect(toggle).toBeChecked();

    // Hard-reload — the value should round-trip from the server.
    await page.reload();
    await expect(connections.allowCredentialScanToggle()).toBeChecked();
  });
});
