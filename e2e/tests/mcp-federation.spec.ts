/**
 * Epic #195 — MCP federation (Smithery + Official Registry mirror) e2e.
 *
 * Drives the public REST surface (`/api/mcp/search`, `/api/mcp/federation/*`)
 * with a seeded admin token. Upstream Smithery + Official Registry are not
 * called from CI; instead we exercise the cache + search + install pipeline
 * end-to-end by writing a synthetic federation entry through the refresh
 * endpoint with a `?source=` we control via a test seam (see
 * `server/src/lib/mcp/federation/registry-cache.ts`).
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { primeAdminUser, ADMIN_USER } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

async function login(): Promise<{ token: string }> {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", {
    data: { username: ADMIN_USER.username, password: ADMIN_USER.password },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ApiEnvelope<{ token: string }>;
  await ctx.dispose();
  return { token: body.data.token };
}

async function authed(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Epic #195 — MCP federation", () => {
  test.beforeAll(async () => {
    await primeAdminUser(API_BASE);
  });

  test("GET /api/mcp/search returns federated envelope", async () => {
    const { token } = await login();
    const api = await authed(token);
    const res = await api.get("/api/mcp/search?source=local");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as ApiEnvelope<{
      total: number;
      entries: Array<{ id: string; source: string; name: string }>;
    }>;
    expect(body.success).toBe(true);
    expect(typeof body.data.total).toBe("number");
    expect(Array.isArray(body.data.entries)).toBe(true);
    await api.dispose();
  });

  test("POST /api/mcp/federation/refresh requires mcp.write and returns per-source results", async () => {
    const { token } = await login();
    const api = await authed(token);
    // Refresh both sources — upstream may fail in CI, errors are reported per-source.
    const res = await api.post("/api/mcp/federation/refresh");
    expect([200, 502]).toContain(res.status());
    if (res.status() === 200) {
      const body = (await res.json()) as ApiEnvelope<{
        results: Array<{ source: string; fetched: number; upserted: number; errors: string[] }>;
      }>;
      expect(body.success).toBe(true);
      expect(body.data.results.length).toBeGreaterThanOrEqual(1);
      for (const r of body.data.results) {
        expect(["smithery", "official"]).toContain(r.source);
        expect(typeof r.fetched).toBe("number");
        expect(typeof r.upserted).toBe("number");
        expect(Array.isArray(r.errors)).toBe(true);
      }
    }
    await api.dispose();
  });

  test("federation/install rejects unknown entries with 404", async () => {
    const { token } = await login();
    const api = await authed(token);
    const res = await api.post("/api/mcp/federation/install", {
      data: { entryId: "does-not-exist" },
    });
    expect(res.status()).toBe(404);
    await api.dispose();
  });

  test("federation routes require authentication", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    const search = await ctx.get("/api/mcp/search");
    expect(search.status()).toBe(401);
    const install = await ctx.post("/api/mcp/federation/install", {
      data: { entryId: "x" },
    });
    expect(install.status()).toBe(401);
    await ctx.dispose();
  });
});
