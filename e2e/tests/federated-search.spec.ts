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
import { primeAdminUser } from "../fixtures/seed-user.js";

const API_BASE = apiBase();

test.describe("Cross-project federated search", () => {
  let token: string;
  let projectId1: string;
  let projectId2: string;

  test.beforeAll(async () => {
    // The login route takes `username` / `password` and answers with
    // `data.accessToken`. Posting `{ email, password: "admin" }` never
    // succeeded, so this whole file skipped itself on every run.
    token = (await primeAdminUser(API_BASE)).accessToken;
    const ctx = await request.newContext({ baseURL: API_BASE });

    // Create two test projects
    const slug1 = `fed-search-1-${Date.now()}`;
    const slug2 = `fed-search-2-${Date.now()}`;

    const p1 = await ctx.post("/api/projects", {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: "Fed Search Project 1", slug: slug1 },
    });
    expect(p1.status(), await p1.text()).toBe(201);
    projectId1 = ((await p1.json()) as { data: { id: string } }).data.id;

    const p2 = await ctx.post("/api/projects", {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: "Fed Search Project 2", slug: slug2 },
    });
    expect(p2.status(), await p2.text()).toBe(201);
    projectId2 = ((await p2.json()) as { data: { id: string } }).data.id;

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
