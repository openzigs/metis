/**
 * E2E tests for the Interactive Schema Graph Explorer (Epic #895).
 *
 * Maps the epic acceptance criteria to concrete UI assertions:
 *   - #900: Database-scope docs expose a Document / Schema Graph tab toggle;
 *           the graph is fetched lazily only when the graph tab is opened.
 *   - #898: The graph renders one node per table with PK/FK column affordances.
 *   - #899: Hover shows the LLM table description; clicking a table opens a
 *           detail drawer listing every column + description; search centres and
 *           highlights a matching table; a fullscreen toggle is available.
 *
 * The doc list, doc detail, and schema-graph endpoints are mocked via
 * `page.route` so the test is deterministic and does not require a live DB
 * connector or real LLM generation.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { LoginPage } from "../pages/login.page.js";
import { DocumentationPage } from "../pages/documentation.page.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

const DOC_ID = "doc-schema-graph-e2e";

const SCHEMA_GRAPH = {
  tables: [
    {
      schema: "public",
      name: "users",
      description: "Stores registered user accounts and their credentials.",
      columns: [
        { name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true, isForeignKey: false },
        {
          name: "email",
          dataType: "varchar",
          nullable: false,
          isPrimaryKey: false,
          isForeignKey: false,
        },
      ],
    },
    {
      schema: "public",
      name: "orders",
      description: "Customer orders placed against the catalogue.",
      columns: [
        { name: "id", dataType: "uuid", nullable: false, isPrimaryKey: true, isForeignKey: false },
        {
          name: "user_id",
          dataType: "uuid",
          nullable: false,
          isPrimaryKey: false,
          isForeignKey: true,
        },
        {
          name: "total",
          dataType: "numeric",
          nullable: true,
          isPrimaryKey: false,
          isForeignKey: false,
        },
      ],
    },
    {
      schema: "public",
      name: "order_items",
      description: "Line items belonging to an order.",
      columns: [
        {
          name: "order_id",
          dataType: "uuid",
          nullable: false,
          isPrimaryKey: false,
          isForeignKey: true,
        },
        {
          name: "sku",
          dataType: "varchar",
          nullable: false,
          isPrimaryKey: false,
          isForeignKey: false,
        },
      ],
    },
  ],
  edges: [
    { source: "orders", target: "users", columns: ["user_id"], refColumns: ["id"] },
    { source: "order_items", target: "orders", columns: ["order_id"], refColumns: ["id"] },
  ],
};

const DOC = {
  id: DOC_ID,
  title: "Production Database Schema",
  scope: "database",
  status: "ready",
  autoUpdate: false,
  generatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  content: "# Production Database Schema\n\n## Overview\n\n3 tables.\n",
};

test.describe("Interactive Schema Graph Explorer (Epic #895)", () => {
  test.describe.configure({ timeout: 120_000 });

  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx: APIRequestContext = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-schema-graph-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Schema Graph ${slug}`, slug, description: "epic-895 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    projectId = body.data?.id ?? body.id;
    await ctx.dispose();

    // Mock the docs endpoints so the test is deterministic.
    await page.route(`**/api/projects/${projectId}/docs`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: [DOC] }),
      }),
    );
    await page.route(`**/api/projects/${projectId}/docs/${DOC_ID}/schema-graph`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: SCHEMA_GRAPH }),
      }),
    );
    await page.route(`**/api/projects/${projectId}/docs/${DOC_ID}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: DOC }),
      }),
    );

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  async function openDocAndGraph(
    page: import("@playwright/test").Page,
  ): Promise<DocumentationPage> {
    const docPage = new DocumentationPage(page);
    await docPage.goto(projectId);
    await docPage.docsList.getByText(DOC.title).click();
    await expect(docPage.exportPdfButton).toBeVisible({ timeout: 15_000 });
    return docPage;
  }

  // AC (#900): database docs show a Document / Schema Graph tab toggle.
  test("shows Document and Schema Graph tabs for a database-scope document", async ({ page }) => {
    const docPage = await openDocAndGraph(page);
    await expect(docPage.documentTab).toBeVisible();
    await expect(docPage.graphTab).toBeVisible();
    // Document tab is selected by default → markdown previewer visible.
    await expect(docPage.documentTab).toHaveAttribute("aria-selected", "true");
  });

  // AC (#900 + #898): switching to the graph tab lazily fetches + renders nodes.
  test("renders a table node per table when the Schema Graph tab is opened", async ({ page }) => {
    const docPage = await openDocAndGraph(page);
    await docPage.openGraphTab();

    await expect(docPage.schemaGraphExplorer).toBeVisible();
    await expect(docPage.schemaNode("users")).toBeVisible();
    await expect(docPage.schemaNode("orders")).toBeVisible();
    await expect(docPage.schemaNode("order_items")).toBeVisible();

    // PK / FK affordances render inside a node.
    const ordersNode = docPage.schemaNode("orders");
    await expect(ordersNode.getByText("PK").first()).toBeVisible();
    await expect(ordersNode.getByText("FK").first()).toBeVisible();
  });

  // AC (#899): hovering a table reveals its LLM description as a tooltip.
  test("reveals the table description on hover", async ({ page }) => {
    const docPage = await openDocAndGraph(page);
    await docPage.openGraphTab();

    const tooltip = page.getByTestId("schema-node-tooltip-users");
    await expect(tooltip).toBeHidden();
    await page.getByTestId("schema-node-header-users").hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("registered user accounts");
  });

  // AC (#899): clicking a table opens a detail drawer with every column.
  test("opens a detail drawer listing all columns and the description", async ({ page }) => {
    const docPage = await openDocAndGraph(page);
    await docPage.openGraphTab();

    await page.getByTestId("schema-node-header-orders").click();

    const drawer = docPage.schemaDetailDrawer;
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("schema-detail-title")).toHaveText("orders");
    await expect(page.getByTestId("schema-detail-description")).toContainText("Customer orders");
    await expect(page.getByTestId("schema-detail-col-id")).toBeVisible();
    await expect(page.getByTestId("schema-detail-col-user_id")).toBeVisible();
    await expect(page.getByTestId("schema-detail-col-total")).toBeVisible();

    // Drawer closes.
    await drawer.getByRole("button", { name: "Close details" }).click();
    await expect(drawer).toBeHidden();
  });

  // AC (#899): searching for a table centres and highlights it.
  test("highlights a matching table when searched", async ({ page }) => {
    const docPage = await openDocAndGraph(page);
    await docPage.openGraphTab();

    await docPage.schemaSearchInput.fill("order_items");

    await expect(docPage.schemaNode("order_items")).toHaveClass(/ring-primary/);
  });

  // AC (#899): a fullscreen toggle expands the explorer.
  test("toggles fullscreen mode", async ({ page }) => {
    const docPage = await openDocAndGraph(page);
    await docPage.openGraphTab();

    await expect(docPage.schemaFullscreenToggle).toHaveText("Fullscreen");
    await docPage.schemaFullscreenToggle.click();
    await expect(docPage.schemaGraphExplorer).toHaveClass(/fixed/);
    await expect(docPage.schemaFullscreenToggle).toHaveText("Exit fullscreen");
    await docPage.schemaFullscreenToggle.click();
    await expect(docPage.schemaGraphExplorer).not.toHaveClass(/fixed/);
  });
});
