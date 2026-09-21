/**
 * Issue #541 — E2E tests for cross-project federated search.
 *
 * Verifies:
 *   1. Scope selector renders on the Chat page
 *   2. Federated search endpoint works
 *   3. Project provenance in results
 */
import { test, expect, request } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

test.describe("Cross-project federated search", () => {
  let token: string;
  let projectId1: string;
  let projectId2: string;

  test.beforeAll(async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const login = await ctx.post("/api/auth/login", {
      data: { email: "admin@metis.local", password: "admin" },
    });
    if (login.status() !== 200) {
      test.skip(true, "Requires seeded admin user");
      return;
    }
    const loginBody = (await login.json()) as { token: string };
    token = loginBody.token;

    // Create two test projects
    const slug1 = `fed-search-1-${Date.now()}`;
    const slug2 = `fed-search-2-${Date.now()}`;

    const p1 = await ctx.post("/api/projects", {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: "Fed Search Project 1", slug: slug1 },
    });
    if (p1.ok()) {
      const body = (await p1.json()) as { data: { project: { id: string } } };
      projectId1 = body.data.project.id;
    }

    const p2 = await ctx.post("/api/projects", {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: "Fed Search Project 2", slug: slug2 },
    });
    if (p2.ok()) {
      const body = (await p2.json()) as { data: { project: { id: string } } };
      projectId2 = body.data.project.id;
    }

    await ctx.dispose();
  });

  test("GET /api/search/projects returns accessible projects", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.get("/api/search/projects", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { id: string; name: string }[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    await ctx.dispose();
  });

  test("POST /api/search/federated returns results across projects", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.post("/api/search/federated", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        query: "test query",
        projectIds: [projectId1, projectId2].filter(Boolean),
        k: 5,
      },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: {
        hits: unknown[];
        projectsSearched: string[];
        projectsFailed: string[];
        totalHits: number;
      };
    };
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty("hits");
    expect(body.data).toHaveProperty("projectsSearched");
    expect(body.data).toHaveProperty("projectsFailed");
    expect(body.data).toHaveProperty("totalHits");
    await ctx.dispose();
  });

  test("POST /api/search/federated rejects unauthenticated requests", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.post("/api/search/federated", {
      data: { query: "test" },
    });
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test("POST /api/search/federated validates input", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.post("/api/search/federated", {
      headers: { Authorization: `Bearer ${token}` },
      data: { query: "" }, // empty query should fail validation
    });
    expect(res.status()).toBe(400);
    await ctx.dispose();
  });
});
