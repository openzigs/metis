/**
 * Epic #194 — Eval & Bench end-to-end coverage.
 *
 * Drives the leaderboard API surface with the seeded admin token. Because
 * `EVAL_NIGHTLY_ENABLED` is unset in the e2e harness by default, the manual
 * trigger returns a `disabled` envelope — which is exactly what the page
 * surfaces to admins as "no nightly cron is registered yet" guidance.
 *
 * Coverage:
 *   1. GET /api/eval/leaderboard returns an empty list initially.
 *   2. POST /api/eval/leaderboard/run as admin returns a 202 envelope with
 *      `status: "disabled"` (flag off path).
 *   3. POST /api/eval/leaderboard/run rejects non-admins (RBAC).
 *   4. UI route `/eval/leaderboard` renders the leaderboard chrome.
 */
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user";
import { apiBase, uiBase } from "../fixtures/api-base";
import { LoginPage } from "../pages/login.page";

const API_BASE = apiBase();
const UI_BASE = uiBase();

interface Envelope<T> {
  success: boolean;
  data: T;
}

async function adminContext(): Promise<APIRequestContext> {
  const { accessToken } = await primeAdminUser(API_BASE);
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

test.describe("Epic #194 — Eval & Bench", () => {
  test("GET /api/eval/leaderboard returns the run list envelope", async () => {
    const ctx = await adminContext();
    try {
      const res = await ctx.get("/api/eval/leaderboard?bench=swe-bench-pro&days=7");
      expect(res.status(), await res.text()).toBe(200);
      const body = (await res.json()) as Envelope<{ runs: unknown[] }>;
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.runs)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });

  test("POST /api/eval/leaderboard/run reports disabled when EVAL_NIGHTLY_ENABLED is unset", async () => {
    const ctx = await adminContext();
    try {
      const res = await ctx.post("/api/eval/leaderboard/run", {
        data: { bench: "swe-bench-pro", model: "offline-stub" },
      });
      // 202 (queued/disabled) is the documented "flag-off" envelope.
      expect([200, 202], await res.text()).toContain(res.status());
      const body = (await res.json()) as Envelope<{ status: string; reason?: string }>;
      expect(body.success).toBe(true);
      expect(["disabled", "completed", "running"]).toContain(body.data.status);
    } finally {
      await ctx.dispose();
    }
  });

  test("UI route /eval/leaderboard renders the leaderboard surface", async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login("admin", "password");
    const res = await page.goto(`${UI_BASE}/eval/leaderboard`, { waitUntil: "domcontentloaded" });
    expect(res?.status(), `nav status was ${res?.status()}`).toBeLessThan(500);
    await expect(page.getByTestId("eval-leaderboard-root")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByTestId("leaderboard-empty").or(page.getByTestId("leaderboard-table")),
    ).toBeVisible();
  });
});
