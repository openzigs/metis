/**
 * Dependency Upgrades Regression — Epic #633 / PR #639
 *
 * Smoke-level end-to-end tests that verify core application flows remain
 * intact after the Q3 2025 major dependency upgrades:
 *   - Tailwind CSS 4.2 → 4.3 (UI styling and layout)
 *   - ESLint 9 → 10 (lint tooling — no runtime effect, but build must pass)
 *   - TypeScript 5 → 6 (type system — compile correctness)
 *   - @types/node 22 → 25 (Node type definitions)
 *   - Prisma 6 → 7 (database ORM — query layer)
 *
 * These are NOT feature tests. They verify existing behaviour is preserved.
 * Each test maps to a critical user journey that exercises one or more of
 * the upgraded dependencies at runtime.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectsPage, ProjectDetailPage } from "../pages/project.page.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Dependency Upgrades Regression (#633)", () => {
  test.describe.configure({ timeout: 120_000 });

  // ──────────────────────────────────────────────────────────────────────
  // AC: API health — Express server starts, Prisma 7 connects to database
  // ──────────────────────────────────────────────────────────────────────
  test("API healthz endpoint responds 200 (Express + Prisma 7 startup)", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.get("/healthz");
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    } finally {
      await ctx.dispose();
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // AC: Login flow — auth session works after TypeScript 6 + Prisma 7
  // ──────────────────────────────────────────────────────────────────────
  test("login flow works with valid credentials", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    // Verify login form renders (Tailwind styling intact)
    await expect(loginPage.title).toBeVisible();
    await expect(loginPage.username).toBeVisible();
    await expect(loginPage.password).toBeVisible();
    await expect(loginPage.submit).toBeVisible();

    // Perform login — exercises Prisma 7 user lookup + JWT generation
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    // After successful login, user is redirected away from /login
    await expect(page).not.toHaveURL(/\/login/);
  });

  test("login shows error for invalid credentials", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();

    await loginPage.username.fill("wronguser");
    await loginPage.password.fill("wrongpass");
    await loginPage.submit.click();

    // Should remain on /login and show an error
    await expect(loginPage.error).toBeVisible({ timeout: 15_000 });
  });

  // ──────────────────────────────────────────────────────────────────────
  // AC: Dashboard loads — Tailwind 4.3 renders layout correctly
  // ──────────────────────────────────────────────────────────────────────
  test("dashboard renders after login (Tailwind 4.3 layout)", async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    // Dashboard should be the default redirect target after login.
    // Verify the main navigation and layout elements are visible,
    // which proves Tailwind CSS is compiling and applying styles.
    await expect(page.getByRole("navigation")).toBeVisible({ timeout: 30_000 });

    // The app shell includes a sidebar or top nav with key links
    await expect(page.getByRole("link", { name: /projects/i })).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────────────────
  // AC: Projects page — list view + create project (Prisma 7 CRUD)
  // ──────────────────────────────────────────────────────────────────────
  test("projects page lists and creates projects (Prisma 7 queries)", async ({ page }) => {
    // Prime user so the mock admin row exists before login
    await primeAdminUser(API_BASE);

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    const projectsPage = new ProjectsPage(page);
    await projectsPage.goto();

    // Verify the projects page renders (heading visible)
    await expect(projectsPage.heading).toBeVisible();

    // Create a new project — exercises Prisma 7 INSERT
    const slug = `e2e-dep-upgrade-${Date.now()}`;
    await projectsPage.createProject(`Dep Upgrade Test ${slug}`, slug);

    // Project appears in the list — exercises Prisma 7 SELECT
    await expect(projectsPage.list.getByText(slug).first()).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────────────────
  // AC: Project detail — tab navigation works (React + Next.js routing)
  // ──────────────────────────────────────────────────────────────────────
  test("project detail page loads with tabs (Next.js routing)", async ({ page }) => {
    // Create a project via API to navigate into
    const primed = await primeAdminUser(API_BASE);
    const api = await authedApi(primed.accessToken);
    const slug = `e2e-detail-${Date.now()}`;
    const createRes = await api.post("/api/projects", {
      data: { name: `Detail Test ${slug}`, slug, description: "regression" },
    });
    expect(createRes.status()).toBe(201);
    const { data } = (await createRes.json()) as {
      data: { project: { id: string } };
    };
    const projectId = data.project.id;
    await api.dispose();

    // Log in and navigate to project detail
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    await page.goto(`/projects/${projectId}`, { waitUntil: "load" });

    // Verify the project detail page renders — the document upload zone
    // is a key indicator that the full component tree loaded successfully
    const detailPage = new ProjectDetailPage(page);
    await expect(detailPage.dropzone).toBeVisible({ timeout: 30_000 });
  });

  // ──────────────────────────────────────────────────────────────────────
  // AC: Settings page — form components render (Tailwind + React forms)
  // ──────────────────────────────────────────────────────────────────────
  test("project settings render AI provider picker (Tailwind forms)", async ({ page }) => {
    // Create a project via API
    const primed = await primeAdminUser(API_BASE);
    const api = await authedApi(primed.accessToken);
    const slug = `e2e-settings-${Date.now()}`;
    const createRes = await api.post("/api/projects", {
      data: { name: `Settings Test ${slug}`, slug, description: "regression" },
    });
    expect(createRes.status()).toBe(201);
    const { data } = (await createRes.json()) as {
      data: { project: { id: string } };
    };
    const projectId = data.project.id;
    await api.dispose();

    // Log in and navigate to project detail
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);

    await page.goto(`/projects/${projectId}/settings`, { waitUntil: "load" });

    // AI provider picker is a settings control — behind the ⚙ tab since #29
    const detailPage = new ProjectDetailPage(page);
    await expect(detailPage.aiProviderPicker).toBeVisible({ timeout: 30_000 });
    await expect(detailPage.aiProviderSelect).toBeVisible();
  });

  // ──────────────────────────────────────────────────────────────────────
  // AC: API CRUD round-trip — Prisma 7 query engine end-to-end
  // ──────────────────────────────────────────────────────────────────────
  test("API CRUD round-trip for projects (Prisma 7 query engine)", async () => {
    const primed = await primeAdminUser(API_BASE);
    const api = await authedApi(primed.accessToken);

    try {
      // CREATE
      const slug = `e2e-crud-${Date.now()}`;
      const createRes = await api.post("/api/projects", {
        data: { name: `CRUD Test ${slug}`, slug, description: "prisma 7 regression" },
      });
      expect(createRes.status()).toBe(201);
      const created = (await createRes.json()) as {
        data: { project: { id: string; slug: string } };
      };
      expect(created.data.project.slug).toBe(slug);
      const projectId = created.data.project.id;

      // READ (list)
      const listRes = await api.get("/api/projects");
      expect(listRes.status()).toBe(200);
      const listed = (await listRes.json()) as {
        data: { projects: Array<{ id: string; slug: string }> };
      };
      expect(listed.data.projects.some((p) => p.id === projectId)).toBe(true);

      // READ (single)
      const getRes = await api.get(`/api/projects/${projectId}`);
      expect(getRes.status()).toBe(200);

      // UPDATE
      const updateRes = await api.patch(`/api/projects/${projectId}`, {
        data: { description: "updated by e2e regression" },
      });
      expect(updateRes.status()).toBe(200);

      // DELETE
      const deleteRes = await api.delete(`/api/projects/${projectId}`);
      expect(deleteRes.status()).toBe(200);

      // Verify deletion
      const verifyRes = await api.get(`/api/projects/${projectId}`);
      expect(verifyRes.status()).toBe(404);
    } finally {
      await api.dispose();
    }
  });
});
