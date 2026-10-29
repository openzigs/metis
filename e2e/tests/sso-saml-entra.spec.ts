/**
 * #1553 — a SAML sign-in from the METIS login page against an IdP that
 * behaves like Microsoft Entra ID, in a real browser, with no external
 * network.
 *
 * The IdP is in-process (`scripts/lib/mock-entra-saml-idp.mjs`): Entra-shaped
 * signed Federation Metadata, which the admin API is given as an admin pastes
 * it, and Entra-shaped signed Responses through Entra's auto-posting form.
 * Each test picks the IdP profile: the signing option, MFA or password-only, a
 * groups overage, an expired or wrong-audience assertion.
 *
 * In a deployment the Ingress sends `/api/auth/saml/*` on the UI's host to the
 * API. This stack has no Ingress and serves the API on its own port of the
 * same host (cookies are per host, not per port), so the spec routes the SAML
 * button's navigation the way the Ingress would; the button, the AuthnRequest,
 * the IdP, the ACS and the landing are all real.
 *
 * Not covered: refusing a password-only session on an MFA-required route. No
 * route requires MFA yet (#1554); the spec asserts the session's MFA claim,
 * which is what such a route reads.
 */
import { randomUUID } from "node:crypto";
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";
import { apiBase, uiBase } from "../fixtures/api-base.js";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { AdminAuthPage } from "../pages/admin-auth.page.js";
import { SSOLoginPage } from "../pages/sso-login.page.js";
import { startMockEntraSamlIdp } from "../../scripts/lib/mock-entra-saml-idp.mjs";

const API_BASE = apiBase();
const UI_BASE = uiBase();
const ACS_URL = `${API_BASE}/api/auth/saml/acs`;
const SP_ENTITY_ID = `${API_BASE}/api/auth/saml/metadata`;
const PROVIDER = "Microsoft Entra ID (mock)";
const ADMINS = randomUUID();
const MEMBERS = randomUUID();
// #1395 binds a username to the IdP identity that first used it; a retry
// against the same database meets a new tenant, so it needs new usernames.
const RUN = Date.now().toString(36);

type Idp = Awaited<ReturnType<typeof startMockEntraSamlIdp>>;
type Profile = Parameters<Idp["setProfile"]>[0];

function entraUser(name: string, groups: string[] = []) {
  return {
    upn: `${name}.${RUN}@contoso.example`,
    objectId: randomUUID(),
    displayName: name,
    groups,
  };
}

/** The claims of the session's access token (the `metis.at` cookie). */
async function sessionClaims(page: Page): Promise<{ role: string; mfaPassed?: boolean }> {
  const cookies = await page.context().cookies(UI_BASE);
  const token = cookies.find((c) => c.name === "metis.at")?.value;
  expect(token, "no metis.at session cookie").toBeTruthy();
  return JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString("utf8"));
}

test.describe.serial("SAML sign-in against an Entra-profile IdP (#1553)", () => {
  let idp: Idp;
  let admin: APIRequestContext;
  let providerId: string | undefined;

  test.beforeAll(async () => {
    idp = await startMockEntraSamlIdp({
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      user: entraUser("nobody"),
    });
    const { accessToken } = await primeAdminUser(API_BASE);
    admin = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    // What an admin downloads from the enterprise app and pastes into METIS.
    const metadataXml = await (await fetch(idp.metadataUrl)).text();
    const res = await admin.put("/api/admin/auth/providers/saml", {
      data: {
        name: PROVIDER,
        entityId: SP_ENTITY_ID,
        acsUrl: ACS_URL,
        idpMetadataXml: metadataXml,
        enabled: true,
        groupMappings: [
          { claimValue: ADMINS, role: "admin" },
          { claimValue: MEMBERS, role: "developer" },
        ],
        defaultRole: "reader",
      },
    });
    expect(res.status(), await res.text()).toBe(200);
    providerId = ((await res.json()) as { data?: { provider?: { id?: string } } }).data?.provider
      ?.id;
  });

  test.afterAll(async () => {
    if (providerId) await admin.delete(`/api/admin/auth/providers/${providerId}`);
    await admin?.dispose();
    await idp?.close();
  });

  /** Sign out, open /login and press the SAML button as `user` under `profile`. */
  async function signInWithSamlButton(
    page: Page,
    user: ReturnType<typeof entraUser>,
    profile: Profile,
  ): Promise<void> {
    idp.setUser(user);
    idp.setProfile(profile);
    await page.context().clearCookies();
    await page.route(`${UI_BASE}/api/auth/saml/login`, (route) =>
      route.fulfill({ status: 302, headers: { location: `${API_BASE}/api/auth/saml/login` } }),
    );
    const login = new SSOLoginPage(page);
    await login.goto();
    await login.getSSOButton(PROVIDER).click();
  }

  async function expectSignedInAs(page: Page, role: string): Promise<void> {
    await page.waitForURL(`${UI_BASE}/dashboard`);
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    const me = await page.request.get(`${UI_BASE}/api/auth/me`);
    expect(me.status()).toBe(200);
    expect(((await me.json()) as { data: { user: { role: string } } }).data.user.role).toBe(role);
  }

  /** The ACS refused the Response: the browser shows its error. */
  async function expectRefused(page: Page, message: RegExp | string): Promise<void> {
    await page.waitForURL(ACS_URL);
    await expect(page.locator("body")).toContainText("SAML_AUTH_FAILED");
    await expect(page.locator("body")).toContainText(message);
  }

  test("an admin-group user lands as admin; a member-group user as developer", async ({ page }) => {
    await signInWithSamlButton(page, entraUser("ada", [ADMINS]), { signing: "both" });
    await expectSignedInAs(page, "admin");

    await signInWithSamlButton(page, entraUser("max", [MEMBERS]), { signing: "both" });
    await expectSignedInAs(page, "developer");
  });

  test("Entra's default assertion-only signing is refused, naming the setting to choose", async ({
    page,
  }) => {
    await signInWithSamlButton(page, entraUser("sam", [ADMINS]), { signing: "assertion" });
    await expectRefused(page, 'Signing Option to \\"Sign SAML response and assertion\\"');
  });

  test("a password-only session carries mfaPassed false; an MFA session true", async ({ page }) => {
    await signInWithSamlButton(page, entraUser("pat"), { signing: "both", mfa: false });
    await expectSignedInAs(page, "reader");
    expect((await sessionClaims(page)).mfaPassed).toBe(false);

    await signInWithSamlButton(page, entraUser("mia"), { signing: "both", mfa: true });
    await expectSignedInAs(page, "reader");
    expect((await sessionClaims(page)).mfaPassed).toBe(true);
  });

  test("a groups overage signs in with the default role and the admin sees the warning", async ({
    page,
  }) => {
    const olga = entraUser("olga", [ADMINS]);
    await signInWithSamlButton(page, olga, { signing: "both", groupOverage: true });
    await expectSignedInAs(page, "reader");

    await signInWithSamlButton(page, entraUser("ada", [ADMINS]), { signing: "both" });
    await expectSignedInAs(page, "admin");
    const authPage = new AdminAuthPage(page);
    await authPage.goto();
    await authPage.expectPageLoaded();
    await expect(authPage.samlGroupOverageWarning).toBeVisible();
    await expect(authPage.samlGroupOverageWarning).toContainText(`olga.${RUN}`);
    await expect(authPage.samlGroupOverageWarning).toContainText(
      "Groups assigned to the application",
    );
  });

  test("a replayed Response is refused", async ({ page }) => {
    await signInWithSamlButton(page, entraUser("rex", [MEMBERS]), { signing: "both" });
    await expectSignedInAs(page, "developer");

    const replay = await page.request.post(ACS_URL, {
      form: { SAMLResponse: idp.lastResponse() ?? "" },
      maxRedirects: 0,
    });
    expect(replay.status()).toBe(401);
    expect(await replay.text()).toMatch(/InResponseTo/i);
  });

  test("a wrong-audience assertion is refused", async ({ page }) => {
    await signInWithSamlButton(page, entraUser("eve", [ADMINS]), {
      signing: "both",
      wrongAudience: true,
    });
    await expectRefused(page, /audience mismatch/i);
  });

  test("an expired assertion is refused", async ({ page }) => {
    await signInWithSamlButton(page, entraUser("old", [ADMINS]), {
      signing: "both",
      expired: true,
    });
    await expectRefused(page, /subject confirmation/i);
  });
});
