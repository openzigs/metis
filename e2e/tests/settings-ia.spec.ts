/**
 * Epic #196 — settings IA + top-level surfaces e2e.
 *
 * Round-trips the new /api/vault routes (#222), confirms the existing
 * connector + document routes are reachable (so the new top-level
 * /repositories /databases /documents pages stay client-side fan-outs),
 * and walks every UI route added in this epic to ensure it renders.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { apiBase, uiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();
const UI_BASE = uiBase();

async function login(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.post("/api/auth/login", {
    data: { username: "admin", password: "password" },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).data.accessToken as string;
}

test.describe("Settings IA + top-level surfaces (#196) @quarantine", () => {
  test("vault HTTP surface — create + reveal + rotate + audit + delete", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const token = await login(ctx);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const label = `e2e-vault-${Date.now()}`;

      const create = await ctx.post("/api/vault", {
        headers,
        data: { label, value: "first-secret-value", scope: "global" },
      });
      expect(create.status()).toBe(201);
      const id = (await create.json()).data.id as string;

      const list = await ctx.get("/api/vault", { headers });
      expect(list.status()).toBe(200);
      const items = (await list.json()).data.items as Array<{ id: string }>;
      expect(items.find((i) => i.id === id)).toBeTruthy();

      const reveal = await ctx.get(`/api/vault/${id}/reveal`, { headers });
      expect(reveal.status()).toBe(200);
      const revealed = (await reveal.json()).data;
      expect(typeof revealed.plaintext).toBe("string");

      const rotate = await ctx.post(`/api/vault/${id}/rotate`, {
        headers,
        data: { value: "second-secret-value" },
      });
      expect(rotate.status()).toBe(200);
      expect((await rotate.json()).data.keyVersion).toBeGreaterThanOrEqual(2);

      const audit = await ctx.get(`/api/vault/${id}/audit`, { headers });
      expect(audit.status()).toBe(200);
      const auditItems = (await audit.json()).data.items as Array<{ action: string }>;
      expect(auditItems.length).toBeGreaterThan(0);

      const del = await ctx.delete(`/api/vault/${id}`, { headers });
      expect(del.status()).toBe(204);
    } finally {
      await ctx.dispose();
    }
  });

  test("vault label validation rejects bad characters", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const token = await login(ctx);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const res = await ctx.post("/api/vault", {
        headers,
        data: { label: "bad label!", value: "v", scope: "global" },
      });
      expect(res.status()).toBe(400);
      expect((await res.json()).error.code).toBe("INVALID_BODY");
    } finally {
      await ctx.dispose();
    }
  });

  test("settings hub + every sub-page renders", async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login("admin", "password");

    const surfaces: Array<[string, string]> = [
      ["/settings", "settings-hub-root"],
      ["/settings/profile", "settings-profile-root"],
      ["/settings/appearance", "settings-appearance-root"],
      ["/settings/notifications", "settings-notifications-root"],
      ["/settings/api-keys", "settings-api-keys-root"],
      ["/settings/audit", "settings-api-keys-root"],
      ["/settings/integrations", "settings-integrations-root"],
      ["/vault", "vault-root"],
      ["/documents", "documents-top-root"],
      ["/repositories", "repositories-top-root"],
      ["/databases", "databases-top-root"],
    ];

    for (const [path, testid] of surfaces) {
      await page.goto(`${UI_BASE}${path}`);
      await expect(page.getByTestId(testid)).toBeVisible({ timeout: 10_000 });
    }
  });
});
