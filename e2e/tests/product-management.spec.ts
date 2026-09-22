/**
 * E2E tests for Multi-Repository Product Management (Epic #544 / Issue #547).
 *
 * Tests the product CRUD lifecycle via both UI and API:
 * - Product list page, empty state, creation, and navigation
 * - Product detail page with repo associations
 * - Role selection for repos
 * - Error and loading states
 *
 * Uses the same global-setup infrastructure (SQLite + offline-stub AI) as
 * the other full-flow specs. Auth: mock provider, `admin / password`.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProductsListPage, ProductDetailPage } from "../pages/products.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Product Management (#547)", () => {
  let accessToken: string;

  test.beforeEach(async ({ page }) => {
    // Prime admin user + get token for API-level setup/teardown
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    // Log in via the UI
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
    await page.waitForURL(/(?!.*login).*/, { timeout: 30_000 });
  });

  // AC #8: Empty state with clear CTA when no products exist
  test("should display empty state when no products exist", async ({ page }) => {
    // Clean up any existing products via API
    const api = await authedApi(accessToken);
    const listRes = await api.get("/api/products");
    const listBody = await listRes.json();
    if (listBody.data?.items) {
      for (const p of listBody.data.items) {
        await api.delete(`/api/products/${p.id}`);
      }
    }
    await api.dispose();

    const productsPage = new ProductsListPage(page);
    await productsPage.goto();

    await expect(productsPage.heading).toBeVisible();
    await expect(productsPage.emptyState).toBeVisible();
    await expect(productsPage.newProductButton).toBeVisible();
  });

  // AC #1: Product list page shows all products with name, description, repo count, last updated
  test("should display products in a list with name and description", async ({ page }) => {
    // Seed a product via API
    const api = await authedApi(accessToken);
    const slug = `e2e-list-${Date.now()}`;
    await api.post("/api/products", {
      data: { name: "E2E List Product", slug, description: "Test product for listing" },
    });
    await api.dispose();

    const productsPage = new ProductsListPage(page);
    await productsPage.goto();

    const card = productsPage.getProductCard("E2E List Product");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Test product for listing");
  });

  // AC #2: Create product modal collects name, description, and auto-generates slug
  test("should create a product via the create modal", async ({ page }) => {
    const productsPage = new ProductsListPage(page);
    await productsPage.goto();

    const slug = `e2e-create-${Date.now()}`;
    await productsPage.createProduct({
      name: "E2E Created Product",
      slug,
      description: "Created via the modal",
    });

    // Product should now appear in the list
    const card = productsPage.getProductCard("E2E Created Product");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Created via the modal");
  });

  // AC #2 error path: Create product shows validation error for duplicate slug
  test("should show error when creating product with duplicate slug", async ({ page }) => {
    const api = await authedApi(accessToken);
    const slug = `e2e-dup-${Date.now()}`;
    await api.post("/api/products", {
      data: { name: "Existing Product", slug, description: "Already exists" },
    });
    await api.dispose();

    const productsPage = new ProductsListPage(page);
    await productsPage.goto();

    await productsPage.openCreateDialog();
    await productsPage.fillCreateForm({
      name: "Duplicate Product",
      slug,
      description: "Should fail",
    });
    await productsPage.submitCreate();

    // Error message should appear
    await expect(productsPage.createError).toBeVisible();
  });

  // AC #3: Product detail view shows metadata and list of associated repos with roles
  test("should navigate to product detail and show metadata", async ({ page }) => {
    const api = await authedApi(accessToken);
    const slug = `e2e-detail-${Date.now()}`;
    await api.post("/api/products", {
      data: { name: "E2E Detail Product", slug, description: "Detail test" },
    });
    await api.dispose();

    const productsPage = new ProductsListPage(page);
    await productsPage.goto();
    await productsPage.openProduct("E2E Detail Product");

    const detailPage = new ProductDetailPage(page);
    await expect(detailPage.productName).toContainText("E2E Detail Product");
    await expect(detailPage.reposHeading).toBeVisible();
    await expect(detailPage.repoEmptyState).toBeVisible();
  });

  // AC #4: Repo assignment panel allows adding/removing repos from the product
  test("should add and remove a repo from the product", async ({ page }) => {
    const api = await authedApi(accessToken);
    const stamp = `${Date.now()}`;

    // A real repo CONNECTION to attach: the dialog picks one from the list of
    // existing connections (it no longer takes a pasted id), so a fake id can
    // never be entered and the old version of this test timed out waiting for
    // an input that is gone.
    const projectRes = await api.post("/api/projects", {
      data: { name: `Repo Host ${stamp}`, slug: `repo-host-${stamp}` },
    });
    expect(projectRes.status(), await projectRes.text()).toBe(201);
    const hostProjectId = ((await projectRes.json()) as { data: { id: string } }).data.id;
    const connRes = await api.post(`/api/projects/${hostProjectId}/connectors/repos`, {
      data: {
        label: `prod-repo-${stamp}`,
        ownerOrOrg: "metis-e2e",
        repoName: `product-repo-${stamp}`,
      },
    });
    expect(connRes.status(), await connRes.text()).toBe(201);

    const createRes = await api.post("/api/products", {
      data: { name: "E2E Repo Product", slug: `e2e-repo-${stamp}`, description: "Repo test" },
    });
    expect(createRes.status(), await createRes.text()).toBe(201);
    const productId = ((await createRes.json()) as { data: { id: string } }).data.id;
    await api.dispose();

    await page.goto(`/products/${productId}`);
    const detailPage = new ProductDetailPage(page);
    await expect(detailPage.reposHeading).toBeVisible();
    await expect(detailPage.repoEmptyState).toBeVisible();

    await test.step("add the repo through the dialog", async () => {
      await detailPage.openAddRepoDialog();
      await detailPage.fillRepoForm(`metis-e2e/product-repo-${stamp}`, "frontend");
      await detailPage.submitAddRepo();
      await expect(detailPage.addRepoDialogTitle).toBeHidden({ timeout: 15_000 });
      await expect(page.getByText(`metis-e2e/product-repo-${stamp}`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText("Role: frontend")).toBeVisible();
    });

    await test.step("remove it again", async () => {
      await page.getByRole("button", { name: "Remove repository" }).click();
      await expect(detailPage.repoEmptyState).toBeVisible({ timeout: 15_000 });
    });
  });

  // AC #6: Role selector dropdown offers the expected roles
  test("should display role options in the add-repo dialog", async ({ page }) => {
    const api = await authedApi(accessToken);
    const slug = `e2e-roles-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "E2E Roles Product", slug, description: "Roles test" },
    });
    const created = await createRes.json();
    await api.dispose();

    await page.goto(`/products/${created.data.id}`);
    const detailPage = new ProductDetailPage(page);

    await detailPage.openAddRepoDialog();

    // Verify the role dropdown contains expected options
    const options = detailPage.repoRoleSelect.locator("option");
    await expect(options).toHaveCount(8); // 8 roles defined in the component
    await expect(detailPage.repoRoleSelect).toContainText("frontend");
    await expect(detailPage.repoRoleSelect).toContainText("backend-api");
    await expect(detailPage.repoRoleSelect).toContainText("gateway");
    await expect(detailPage.repoRoleSelect).toContainText("docs");
  });

  // AC #10: Loading state handled gracefully
  test("should show loading state before products are fetched", async ({ page }) => {
    // Intercept the API call to slow it down
    await page.route("**/api/products", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });

    await page.goto("/products");
    const productsPage = new ProductsListPage(page);

    // Loading indicator should be visible briefly
    await expect(productsPage.loadingIndicator).toBeVisible();
    // Then it should disappear when data loads
    await expect(productsPage.loadingIndicator).not.toBeVisible({ timeout: 15_000 });
  });

  // AC #9: Responsive layout using existing design system
  test("should render product grid with responsive layout", async ({ page }) => {
    const api = await authedApi(accessToken);
    const slug = `e2e-responsive-${Date.now()}`;
    await api.post("/api/products", {
      data: { name: "E2E Responsive", slug, description: "Layout test" },
    });
    await api.dispose();

    const productsPage = new ProductsListPage(page);
    await productsPage.goto();

    // The grid should use CSS grid classes
    await expect(productsPage.productGrid).toBeVisible();
  });
});
