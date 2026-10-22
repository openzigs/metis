/**
 * #1386 — an OIDC login ends on a signed-in page, in a real browser.
 *
 * The SSO callback used to set `accessToken` / `refreshToken` cookies, which the
 * UI never reads (its session is `metis.at` / `metis.rt`), so the browser landed
 * on a page that sent it straight back to `/login`.
 *
 * The identity provider is in-process (`scripts/lib/mock-oidc-idp.mjs`): real
 * discovery, authorize, PKCE code exchange and an RS256 id_token, on loopback,
 * with no external service. In a deployment the Ingress sends
 * `/api/auth/oidc/*` to the API on the UI's host; this stack serves the API on
 * its own port of the same host (cookies are per host, not per port), so the
 * browser starts the login there, exactly where the Ingress would send it.
 */
import { expect, request, test } from "@playwright/test";
import { apiBase, uiBase } from "../fixtures/api-base.js";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { startMockOidcIdp } from "../../scripts/lib/mock-oidc-idp.mjs";

const API_BASE = apiBase();
const UI_BASE = uiBase();

test.describe("SSO session (#1386)", () => {
  test("OIDC: METIS → IdP → callback → the signed-in dashboard", async ({ page, context }) => {
    const redirectUri = `${API_BASE}/api/auth/oidc/callback`;
    // Each IdP instance is a new issuer, and #1395 binds an SSO account to its
    // issuer + subject: a retry against the same database needs its own user.
    const username = `e2e.oidc.${Date.now().toString(36)}`;
    const idp = await startMockOidcIdp({
      clientId: "metis-e2e",
      clientSecret: "metis-e2e-secret",
      redirectUri,
      user: {
        sub: "e2e-oidc-1386",
        preferredUsername: username,
        email: `${username}@example.test`,
        name: "E2E OIDC User",
        groups: [],
      },
    });
    const { accessToken } = await primeAdminUser(API_BASE);
    const admin = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    let providerId: string | undefined;
    try {
      await test.step("configure the OIDC provider against the test IdP", async () => {
        const res = await admin.put("/api/admin/auth/providers/oidc", {
          data: {
            name: "E2E OIDC",
            discoveryUrl: idp.discoveryUrl,
            clientId: "metis-e2e",
            clientSecret: "metis-e2e-secret",
            redirectUri,
            enabled: true,
            groupMappings: [{ claimValue: "metis-admins", role: "admin" }],
            defaultRole: "reader",
          },
        });
        expect(res.status(), await res.text()).toBe(200);
        providerId = ((await res.json()) as { data?: { id?: string } }).data?.id;
      });

      await test.step("redirect → IdP → callback lands on the UI's dashboard", async () => {
        await page.goto(`${API_BASE}/api/auth/oidc/login`);
        await page.waitForURL(`${UI_BASE}/dashboard`);
        expect(idp.calls.authorize).toBe(1);
        expect(idp.calls.token).toBe(1);
      });

      await test.step("the page is signed in, as the SSO user", async () => {
        await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
        expect(new URL(page.url()).pathname).toBe("/dashboard");

        const cookies = await context.cookies(UI_BASE);
        const access = cookies.find((c) => c.name === "metis.at");
        expect(access?.httpOnly).toBe(true);
        expect(access?.sameSite).toBe("Lax");
        expect(cookies.some((c) => c.name === "metis.rt")).toBe(true);
        expect(cookies.some((c) => c.name === "accessToken")).toBe(false);

        const me = await page.request.get(`${UI_BASE}/api/auth/me`);
        expect(me.status()).toBe(200);
        const body = (await me.json()) as { data: { user: { username: string; role: string } } };
        expect(body.data.user).toMatchObject({ username, role: "reader" });
      });
    } finally {
      if (providerId) await admin.delete(`/api/admin/auth/providers/${providerId}`);
      await admin.dispose();
      await idp.close();
    }
  });
});
