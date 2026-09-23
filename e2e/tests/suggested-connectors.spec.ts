/**
 * Epic #467 — Automatic Database Connector Discovery from Repo Code.
 *
 * Verifies the "Suggested Connectors" section on the Connections page:
 *   AC1: Suggestions badge + section appears when pending suggestions exist
 *   AC2: "Connect" pre-fills the DB connector form with extracted details
 *   AC3: "Dismiss" removes the suggestion from the pending list
 *   AC4: No suggestions section when no pending suggestions exist
 *
 * Strategy: Seed suggested connector rows via the API, then exercise the UI.
 * The test creates its own project to ensure isolation.
 */
import { test, expect, request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ConnectionsPage } from "../pages/connections.page.js";

const API_BASE = apiBase();

interface SeedSuggestion {
  driverType: string;
  host: string | null;
  port: number | null;
  database: string | null;
  sourceFile: string;
  lineNumber: number;
  confidence: string;
}

const SUGGESTIONS: SeedSuggestion[] = [
  {
    driverType: "postgresql",
    host: "db-prod.internal",
    port: 5432,
    database: "orders_db",
    sourceFile: "src/config/database.ts",
    lineNumber: 14,
    confidence: "high",
  },
  {
    driverType: "mysql",
    host: "mysql.corp.net",
    port: 3306,
    database: "analytics",
    sourceFile: "services/analytics/db.py",
    lineNumber: 42,
    confidence: "medium",
  },
  {
    driverType: "oracle",
    host: "ora-host",
    port: 1521,
    database: "FINDB",
    sourceFile: "legacy/conn.xml",
    lineNumber: 8,
    confidence: "low",
  },
];

/**
 * Seed suggested connectors via the dedicated seed script that uses Prisma
 * to insert rows directly into the e2e SQLite database.
 */
async function seedSuggestionsViaDb(projectId: string, databaseUrl: string): Promise<string[]> {
  const { execSync } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const REPO_ROOT = path.resolve(__dirname, "..", "..");

  const result = execSync(
    `pnpm --filter @metis/server exec tsx scripts/e2e-seed-suggested-connectors.ts "${projectId}" '${JSON.stringify(SUGGESTIONS)}'`,
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  return JSON.parse(result.trim()) as string[];
}

test.describe("Epic #467 — Suggested Database Connectors", () => {
  let projectId: string;
  let accessToken: string;

  test.beforeEach(async ({ page }) => {
    // Prime admin user and create a fresh project for each test
    const { accessToken: token } = await primeAdminUser(API_BASE);
    accessToken = token;

    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });

    const slug = `e2e-connectors-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Connector Discovery ${slug}`, slug, description: "epic-467 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    projectId = body.data?.id ?? body.id;
    await ctx.dispose();

    // Login via the UI
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("admin", "password");
  });

  // AC1: Given a project with pending suggestions, When user visits Connections page,
  //      Then suggestions section with badge appears
  test("shows suggestions badge and section when pending suggestions exist", async ({ page }) => {
    // Seed suggestions directly into the DB
    const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE}`;
    await seedSuggestionsViaDb(projectId, databaseUrl);

    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    // Badge with count is visible
    await expect(connections.suggestionsBadge).toBeVisible();
    await expect(connections.suggestionsBadge).toContainText("3 suggestions");

    // Section heading is visible
    await expect(connections.suggestedSection).toBeVisible();

    // All 3 suggestion cards render
    await expect(connections.suggestedCards).toHaveCount(3);

    // Verify first card details (high confidence postgresql)
    const pgCard = connections.suggestionCard("postgresql");
    await expect(pgCard).toBeVisible();
    await expect(connections.confidenceBadge(pgCard)).toHaveText("high");
    await expect(connections.connectionInfo(pgCard)).toContainText(
      "db-prod.internal:5432/orders_db",
    );
    await expect(connections.sourceFileInfo(pgCard)).toContainText("src/config/database.ts:14");

    // Verify medium confidence card
    const mysqlCard = connections.suggestionCard("mysql");
    await expect(mysqlCard).toBeVisible();
    await expect(connections.confidenceBadge(mysqlCard)).toHaveText("medium");

    // Verify low confidence card
    const oracleCard = connections.suggestionCard("oracle");
    await expect(oracleCard).toBeVisible();
    await expect(connections.confidenceBadge(oracleCard)).toHaveText("low");
  });

  // AC2: Given a suggestion, When user clicks "Configure", Then the wizard
  //      opens pre-filled with extracted host/port/database/driver (Epic #701)
  test("Configure button opens wizard pre-filled with suggestion details", async ({ page }) => {
    const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE}`;
    await seedSuggestionsViaDb(projectId, databaseUrl);

    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    // Click Configure on the postgresql suggestion
    const pgCard = connections.suggestionCard("postgresql");
    await connections.clickConfigure(pgCard);

    // Wizard opens on the review step
    await expect(connections.wizardSection("review")).toBeVisible();

    // Advance to configure step and verify pre-fill from the suggestion row
    await connections.wizardNext().click();
    await expect(connections.wizardSection("configure")).toBeVisible();
    // Scope to the wizard dialog: the page behind it has its own
    // Host/Port/Database/Label inputs in the "add database connector" form.
    const wizard = connections.wizardDialog();
    await expect(wizard.getByLabel("Host")).toHaveValue("db-prod.internal");
    await expect(wizard.getByLabel("Port")).toHaveValue("5432");
    await expect(wizard.getByLabel("Database")).toHaveValue("orders_db");
    await expect(wizard.locator("#wiz-driver")).toHaveText("postgres");
    await expect(wizard.getByLabel("Label")).toHaveValue("postgresql-orders_db");
  });

  // AC3: Given a suggestion, When user clicks "Dismiss", Then suggestion disappears
  //      from pending list
  test("Dismiss button removes suggestion from pending list", async ({ page }) => {
    const databaseUrl = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE}`;
    await seedSuggestionsViaDb(projectId, databaseUrl);

    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    // Initially 3 suggestions
    await expect(connections.suggestedCards).toHaveCount(3);

    // Dismiss the oracle suggestion
    const oracleCard = connections.suggestionCard("oracle");
    await connections.clickDismiss(oracleCard);

    // Oracle card disappears, only 2 remain
    await expect(connections.suggestedCards).toHaveCount(2);
    await expect(connections.suggestionCard("oracle")).not.toBeVisible();

    // Badge updates
    await expect(connections.suggestionsBadge).toContainText("2 suggestions");
  });

  // AC4: Given a project with no suggestions, When user visits Connections page,
  //      Then no suggestions section appears
  test("no suggestions section when project has no pending suggestions", async ({ page }) => {
    // No seeding — project starts empty
    const connections = new ConnectionsPage(page);
    await connections.goto(projectId);

    // Heading is still visible (page renders)
    await expect(connections.heading).toBeVisible();

    // But no suggestions section or badge
    await expect(connections.suggestedSection).not.toBeVisible();
    await expect(connections.suggestionsBadge).not.toBeVisible();
  });
});
