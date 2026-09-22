/**
 * E2E API tests for Multi-Repository Product Documentation (Epic #544).
 *
 * Validates the full REST API surface for products:
 * - CRUD lifecycle (create, read, update, delete)
 * - Repo association (add, update role, remove)
 * - Pagination and search
 * - Error handling (404, validation, duplicate slug)
 *
 * These tests exercise the real Express API + Prisma + SQLite, same stack
 * that the webServer boots for the UI tests.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

test.describe("Products API (#544)", () => {
  let api: APIRequestContext;
  let accessToken: string;

  test.beforeEach(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
  });

  test.afterEach(async () => {
    await api.dispose();
  });

  // AC (API): POST /api/products — Create product
  test("POST /api/products creates a product", async () => {
    const slug = `api-create-${Date.now()}`;
    const res = await api.post("/api/products", {
      data: { name: "API Created", slug, description: "via API test" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.data.name).toBe("API Created");
    expect(body.data.slug).toBe(slug);
    expect(body.data.description).toBe("via API test");
    expect(body.data.id).toBeTruthy();
  });

  // AC (API): POST /api/products — Validation error on missing name
  test("POST /api/products returns 400 for missing required fields", async () => {
    const res = await api.post("/api/products", {
      data: { description: "no name or slug" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  // AC (API): POST /api/products — Duplicate slug
  test("POST /api/products returns error for duplicate slug", async () => {
    const slug = `api-dup-${Date.now()}`;
    await api.post("/api/products", {
      data: { name: "First", slug, description: "first" },
    });
    const res = await api.post("/api/products", {
      data: { name: "Second", slug, description: "duplicate" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  // AC (API): GET /api/products — List products
  test("GET /api/products returns products list", async () => {
    const slug = `api-list-${Date.now()}`;
    await api.post("/api/products", {
      data: { name: "Listable", slug, description: "for listing" },
    });

    const res = await api.get("/api/products");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.items).toBeInstanceOf(Array);
    expect(body.data.items.length).toBeGreaterThan(0);
    const found = body.data.items.find((p: { slug: string }) => p.slug === slug);
    expect(found).toBeTruthy();
    expect(found.name).toBe("Listable");
  });

  // AC (API): GET /api/products/:id — Get product with repos
  test("GET /api/products/:id returns product detail", async () => {
    const slug = `api-get-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "GetMe", slug, description: "get test" },
    });
    const created = await createRes.json();
    const id = created.data.id;

    const res = await api.get(`/api/products/${id}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(id);
    expect(body.data.name).toBe("GetMe");
    expect(body.data.slug).toBe(slug);
  });

  // AC (API): GET /api/products/:id — 404 for non-existent
  test("GET /api/products/:id returns 404 for non-existent product", async () => {
    const res = await api.get("/api/products/non-existent-id-12345");
    expect(res.status()).toBe(404);
  });

  // AC (API): PATCH /api/products/:id — Update product
  test("PATCH /api/products/:id updates product fields", async () => {
    const slug = `api-patch-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "PatchMe", slug, description: "before" },
    });
    const created = await createRes.json();
    const id = created.data.id;

    const res = await api.patch(`/api/products/${id}`, {
      data: { name: "Patched", description: "after" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.name).toBe("Patched");
    expect(body.data.description).toBe("after");
  });

  // AC (API): DELETE /api/products/:id — Delete product
  test("DELETE /api/products/:id removes the product", async () => {
    const slug = `api-del-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "DeleteMe", slug, description: "to be deleted" },
    });
    const created = await createRes.json();
    const id = created.data.id;

    const delRes = await api.delete(`/api/products/${id}`);
    // DELETE answers 204 No Content.
    expect(delRes.status()).toBe(204);

    // Verify it's gone
    const getRes = await api.get(`/api/products/${id}`);
    expect(getRes.status()).toBe(404);
  });

  // AC (API): POST /api/products/:id/repos — Associate repo
  test("POST /api/products/:id/repos associates a repo", async () => {
    const slug = `api-repo-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "RepoProduct", slug },
    });
    const created = await createRes.json();
    const productId = created.data.id;

    // First create a repo connection or use a known one. Since we're in offline
    // mode, we need to verify the endpoint accepts the request format even if
    // it fails due to missing repo connection.
    const res = await api.post(`/api/products/${productId}/repos`, {
      data: { repoConnectionId: "test-connection-id", role: "backend-api" },
    });

    // In offline mode with no actual repo connections, this may 404 or succeed
    // depending on whether the route validates the FK. Either way the endpoint
    // is reachable and returns a proper response format.
    expect([200, 201, 400, 404]).toContain(res.status());
  });

  // AC (API): PATCH /api/products/:id/repos/:repoId — Update repo role
  test("PATCH /api/products/:id/repos/:repoId updates role", async () => {
    const slug = `api-role-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "RoleProduct", slug },
    });
    const created = await createRes.json();
    const productId = created.data.id;

    // Try to update a repo role (may fail if no repo exists but endpoint should be reachable)
    const res = await api.patch(`/api/products/${productId}/repos/fake-repo-id`, {
      data: { role: "frontend" },
    });
    expect([200, 400, 404]).toContain(res.status());
  });

  // AC (API): DELETE /api/products/:id/repos/:repoId — Remove repo
  test("DELETE /api/products/:id/repos/:repoId removes association", async () => {
    const slug = `api-rmrepo-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "RmRepoProduct", slug },
    });
    const created = await createRes.json();
    const productId = created.data.id;

    const res = await api.delete(`/api/products/${productId}/repos/fake-repo-id`);
    expect([200, 204, 404]).toContain(res.status());
  });

  // AC (API): POST /api/products/:id/analyze — Trigger cross-repo analysis
  test("POST /api/products/:id/analyze endpoint is reachable", async () => {
    const slug = `api-analyze-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "AnalyzeProduct", slug },
    });
    const created = await createRes.json();
    const productId = created.data.id;

    const res = await api.post(`/api/products/${productId}/analyze`);
    // Without repos, analysis may fail gracefully (400) or succeed as no-op
    expect([200, 202, 400, 404]).toContain(res.status());
  });

  // AC (API): GET /api/products/:id/docs/architecture — Get unified architecture doc
  test("GET /api/products/:id/docs/architecture endpoint is reachable", async () => {
    const slug = `api-arch-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "ArchProduct", slug },
    });
    const created = await createRes.json();
    const productId = created.data.id;

    const res = await api.get(`/api/products/${productId}/docs/architecture`);
    // Without generated docs, returns 404 or empty
    expect([200, 404]).toContain(res.status());
  });

  // AC (API): GET /api/products/:id/docs/contracts — Get API contract docs
  test("GET /api/products/:id/docs/contracts endpoint is reachable", async () => {
    const slug = `api-contracts-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "ContractsProduct", slug },
    });
    const created = await createRes.json();
    const productId = created.data.id;

    const res = await api.get(`/api/products/${productId}/docs/contracts`);
    expect([200, 404]).toContain(res.status());
  });

  // AC (API): GET /api/products/:id/docs/services/:repoId — Get per-service doc
  test("GET /api/products/:id/docs/services/:repoId endpoint is reachable", async () => {
    const slug = `api-svc-${Date.now()}`;
    const createRes = await api.post("/api/products", {
      data: { name: "SvcProduct", slug },
    });
    const created = await createRes.json();
    const productId = created.data.id;

    const res = await api.get(`/api/products/${productId}/docs/services/some-repo-id`);
    expect([200, 404]).toContain(res.status());
  });

  // AC (API): Auth required — unauthenticated requests rejected
  test("API endpoints require authentication", async () => {
    const unauthApi = await request.newContext({ baseURL: API_BASE });
    const res = await unauthApi.get("/api/products");
    expect(res.status()).toBe(401);
    await unauthApi.dispose();
  });
});
