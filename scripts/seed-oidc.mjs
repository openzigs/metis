#!/usr/bin/env node
/**
 * Seed METIS's OIDC provider to point at the LOCAL Keycloak IdP (Issue #521).
 *
 * Flow (all against localhost):
 *   1. Log in to METIS as the mock `admin` user (AUTH_MODE=mock) to obtain an
 *      admin access token. OIDC login itself does NOT depend on AUTH_MODE — the
 *      SSO routes are always mounted and read the stored provider config — so the
 *      dev server keeps AUTH_MODE=mock and the OIDC provider is layered on top via
 *      the admin API (exactly how OIDC is configured in production).
 *   2. Wait for Keycloak's OIDC discovery document to be reachable (the realm
 *      import has to finish booting before METIS can discover it).
 *   3. PUT the provider config (discovery URL, client id/secret, redirect URI,
 *      scopes, group→role mappings) to `/api/admin/auth/providers/oidc`.
 *   4. Re-read the provider via the admin API and assert it was accepted +
 *      enabled. Exits non-zero on any failure (usable as a smoke check).
 *
 * Env (all optional, sensible localhost defaults):
 *   METIS_API_URL        default http://localhost:4000
 *   OIDC_IDP_URL         default http://localhost:4600  (Keycloak host base)
 *   OIDC_REALM           default metis
 *   OIDC_CLIENT_ID       default metis
 *   OIDC_CLIENT_SECRET   default metis-local-secret  (matches realm-metis.json)
 *   METIS_ADMIN_USER     default admin
 *   METIS_ADMIN_PASSWORD default password
 *   OIDC_DEFAULT_ROLE    default reader
 *   OIDC_PROVIDER_NAME   default "Local Keycloak (OIDC)"
 *
 * Node built-ins + global fetch (Node 18+) only.
 */
import { DEFAULTS, buildOidcProviderBody, discoveryUrl, trimSlash } from "./lib/oidc-harness.mjs";

/** @param {string} msg */
function log(msg) {
  process.stdout.write(`  - ${msg}\n`);
}
/** @param {string} msg */
function ok(msg) {
  process.stdout.write(`  OK ${msg}\n`);
}
/** @param {string} msg */
function die(msg) {
  process.stderr.write(`  FAIL ${msg}\n`);
  process.exit(1);
}

/** Poll the Keycloak discovery doc until it answers 200 or we time out. */
async function waitForDiscovery(url, attempts = 30, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Keycloak not up yet — keep polling.
    }
    if (i === attempts) {
      die(
        `Keycloak discovery doc never became reachable at ${url}. ` +
          `Is the IdP up? Run: docker compose -f docker-compose.oidc.yml up -d`,
      );
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

async function main() {
  const metisApiUrl = trimSlash(process.env.METIS_API_URL ?? DEFAULTS.metisApiUrl);
  const idpBaseUrl = trimSlash(process.env.OIDC_IDP_URL ?? DEFAULTS.idpBaseUrl);
  const realm = process.env.OIDC_REALM ?? DEFAULTS.realm;
  const clientId = process.env.OIDC_CLIENT_ID ?? DEFAULTS.clientId;
  const clientSecret = process.env.OIDC_CLIENT_SECRET ?? DEFAULTS.clientSecret;
  const adminUser = process.env.METIS_ADMIN_USER ?? "admin";
  const adminPassword = process.env.METIS_ADMIN_PASSWORD ?? "password";
  const defaultRole = process.env.OIDC_DEFAULT_ROLE ?? DEFAULTS.defaultRole;
  const name = process.env.OIDC_PROVIDER_NAME ?? DEFAULTS.providerName;

  // 1. Admin login (mock auth) → access token.
  log(`logging in to METIS at ${metisApiUrl} as '${adminUser}'`);
  const loginRes = await fetch(`${metisApiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: adminUser, password: adminPassword }),
  });
  if (!loginRes.ok) {
    die(
      `admin login failed (${loginRes.status}). Is the server up with AUTH_MODE=mock? ` +
        `Set METIS_ADMIN_USER/METIS_ADMIN_PASSWORD if you changed the mock creds.`,
    );
  }
  const loginJson = /** @type {any} */ (await loginRes.json());
  const token = loginJson?.data?.accessToken;
  if (!token) die("login response had no accessToken");
  ok("obtained admin access token");

  // 2. Wait for Keycloak discovery (realm import must finish booting).
  const discovery = discoveryUrl(idpBaseUrl, realm);
  log(`waiting for Keycloak discovery doc at ${discovery}`);
  await waitForDiscovery(discovery);
  ok("Keycloak discovery document is reachable");

  // 3. PUT the OIDC provider config.
  const body = buildOidcProviderBody({
    idpBaseUrl,
    realm,
    metisApiUrl,
    name,
    clientId,
    clientSecret,
    defaultRole,
  });
  log("configuring METIS OIDC provider via admin API");
  const putRes = await fetch(`${metisApiUrl}/api/admin/auth/providers/oidc`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    die(`OIDC provider PUT failed (${putRes.status}): ${text}`);
  }
  ok("OIDC provider configuration accepted");

  // 4. Verify it round-trips (enabled + oidc mode) via the admin read view.
  const listRes = await fetch(`${metisApiUrl}/api/admin/auth/providers`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) die(`could not re-read providers (${listRes.status})`);
  const listJson = /** @type {any} */ (await listRes.json());
  const providers = listJson?.data?.providers ?? [];
  const oidc = providers.find((/** @type {any} */ p) => p.mode === "oidc");
  if (!oidc) die("OIDC provider missing from admin read view after save");
  if (!oidc.enabled) die("OIDC provider was saved but is not enabled");
  ok(`OIDC provider '${oidc.name}' is configured and enabled`);

  process.stdout.write("\n");
  ok("OIDC harness seed complete.");
  log(`Start the login flow at: ${metisApiUrl}/api/auth/oidc/login`);
  log("Keycloak test user: tester / testpass (member of group 'metis-admins' → role admin)");
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
