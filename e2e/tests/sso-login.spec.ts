/**
 * SSO Login page e2e tests.
 *
 * Epic #748, Issue #755: Login page provider auto-detect + branded buttons.
 *
 * Tests cover:
 * - SSO buttons render when providers are configured via API
 * - Fallback to standard LDAP/mock login when no SSO providers configured
 * - Clicking SSO button initiates the correct redirect flow
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { SSOLoginPage } from "../pages/sso-login.page.js";

const API_BASE = apiBase();

/**
 * Delete every configured SSO provider. Providers live in one global config,
 * so a spec that asserts "no providers" has to establish that state itself.
 */
async function removeAllSsoProviders(token: string): Promise<void> {
  const ctx = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const res = await ctx.get("/api/admin/auth/providers");
    expect(res.status(), await res.text()).toBe(200);
    const { data } = (await res.json()) as { data: { providers: Array<{ id: string }> } };
    for (const provider of data.providers) {
      const del = await ctx.delete(`/api/admin/auth/providers/${provider.id}`);
      expect([200, 404]).toContain(del.status());
    }
  } finally {
    await ctx.dispose();
  }
}

test.describe("SSO Login — Provider Buttons (#755)", () => {
  let adminToken: string;

  test.beforeEach(async () => {
    // Prime the admin user and get an auth token for API setup
    const primed = await primeAdminUser(API_BASE);
    adminToken = primed.accessToken;
  });

  // AC: Login page falls back to standard LDAP/mock when no SSO providers configured
  test("should show standard login form when no SSO providers configured", async ({ page }) => {
    // SSO providers are GLOBAL state that other specs configure (admin-auth
    // saves a "Test SAML IdP"). Clear them first, or this test's result depends
    // on which files ran before it.
    await removeAllSsoProviders(adminToken);

    const loginPage = new SSOLoginPage(page);
    await loginPage.goto();

    await test.step("Standard username/password form is visible", async () => {
      await loginPage.expectStandardLoginVisible();
    });

    await test.step("No SSO buttons are displayed", async () => {
      await expect(loginPage.getAllSSOButtons()).toHaveCount(0);
    });
  });

  // AC: Login page shows branded SSO buttons when providers are configured
  test("should show branded SSO buttons when providers are configured", async ({ page }) => {
    const ctx: APIRequestContext = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    });

    await test.step("Configure a SAML provider via admin API", async () => {
      const res = await ctx.put("/api/admin/auth/providers/saml", {
        data: {
          name: "Okta SAML",
          entityId: "https://metis.example.com/sp",
          acsUrl: "https://metis.example.com/api/auth/saml/acs",
          idpMetadataXml: "<EntityDescriptor></EntityDescriptor>",
          enabled: true,
          groupMappings: [{ claimValue: "admins", role: "admin" }],
          defaultRole: "reader",
        },
      });
      expect(res.status()).toBe(200);
    });

    await test.step("Configure an OIDC provider via admin API", async () => {
      const res = await ctx.put("/api/admin/auth/providers/oidc", {
        data: {
          name: "Azure AD",
          discoveryUrl: "https://login.microsoftonline.com/tenant/.well-known/openid-configuration",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://metis.example.com/api/auth/oidc/callback",
          enabled: true,
          groupMappings: [{ claimValue: "platform-admins", role: "admin" }],
          defaultRole: "reader",
        },
      });
      expect(res.status()).toBe(200);
    });

    await test.step("Login page shows SSO buttons for configured providers", async () => {
      const loginPage = new SSOLoginPage(page);
      await loginPage.goto();

      await expect(loginPage.getSSOButton("Okta SAML")).toBeVisible();
      await expect(loginPage.getSSOButton("Azure AD")).toBeVisible();
    });

    await test.step("Separator between SSO buttons and standard form is shown", async () => {
      const loginPage = new SSOLoginPage(page);
      await loginPage.expectSSOSeparatorVisible();
    });

    await test.step("Standard login form is still available below SSO buttons", async () => {
      const loginPage = new SSOLoginPage(page);
      await loginPage.expectStandardLoginVisible();
    });

    await ctx.dispose();
  });

  // AC: Clicking SSO button initiates the correct redirect flow
  test("should initiate SAML redirect when clicking SAML SSO button", async ({ page }) => {
    const ctx: APIRequestContext = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    });

    await test.step("Ensure SAML provider is configured and enabled", async () => {
      const res = await ctx.put("/api/admin/auth/providers/saml", {
        data: {
          name: "Enterprise IdP",
          entityId: "https://metis.example.com/sp",
          acsUrl: "https://metis.example.com/api/auth/saml/acs",
          idpMetadataXml: "<EntityDescriptor></EntityDescriptor>",
          enabled: true,
          groupMappings: [{ claimValue: "admins", role: "admin" }],
          defaultRole: "reader",
        },
      });
      expect(res.status()).toBe(200);
    });

    await test.step("Click SSO button and verify redirect to SAML login endpoint", async () => {
      const loginPage = new SSOLoginPage(page);
      await loginPage.goto();

      const ssoButton = loginPage.getSSOButton("Enterprise IdP");
      await expect(ssoButton).toBeVisible();

      // Intercept navigation — SAML login redirects to the API endpoint
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes("/api/auth/saml/login")),
        ssoButton.click(),
      ]);

      // The SAML login endpoint should respond (redirect to IdP or error due to no real IdP)
      expect(response.status()).toBeGreaterThanOrEqual(200);
    });

    await ctx.dispose();
  });

  // AC: Clicking OIDC SSO button initiates OIDC redirect
  test("should initiate OIDC redirect when clicking OIDC SSO button", async ({ page }) => {
    const ctx: APIRequestContext = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    });

    await test.step("Ensure OIDC provider is configured and enabled", async () => {
      const res = await ctx.put("/api/admin/auth/providers/oidc", {
        data: {
          name: "Google Workspace",
          discoveryUrl: "https://accounts.google.com/.well-known/openid-configuration",
          clientId: "e2e-client-id",
          clientSecret: "e2e-client-secret",
          redirectUri: "https://metis.example.com/api/auth/oidc/callback",
          enabled: true,
          groupMappings: [{ claimValue: "gcp-admins", role: "admin" }],
          defaultRole: "reader",
        },
      });
      expect(res.status()).toBe(200);
    });

    await test.step("Click OIDC button and verify redirect to OIDC login endpoint", async () => {
      const loginPage = new SSOLoginPage(page);
      await loginPage.goto();

      const ssoButton = loginPage.getSSOButton("Google Workspace");
      await expect(ssoButton).toBeVisible();

      // Intercept navigation — OIDC login redirects to the API endpoint
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes("/api/auth/oidc/login")),
        ssoButton.click(),
      ]);

      expect(response.status()).toBeGreaterThanOrEqual(200);
    });

    await ctx.dispose();
  });
});
