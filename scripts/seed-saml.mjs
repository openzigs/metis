#!/usr/bin/env node
/**
 * Seed METIS's SAML provider to point at the LOCAL mock SAML IdP (Issue #523).
 *
 * Flow (all against localhost):
 *   1. Log in to METIS as the mock `admin` user (AUTH_MODE=mock) to obtain an
 *      admin access token. SAML login itself does NOT depend on AUTH_MODE — the
 *      SSO routes are always mounted and read the stored provider config — so the
 *      dev server keeps AUTH_MODE=mock and the SAML provider is layered on top
 *      via the admin API (exactly how SAML is configured in production).
 *   2. Fetch the mock IdP's metadata XML (entityID + SSO URL + signing cert).
 *   3. PUT it to `/api/admin/auth/providers/saml`. METIS parses the entryPoint /
 *      cert / issuer out of the metadata itself, so the cert METIS trusts is
 *      exactly the cert the mock signs with.
 *   4. Re-read the provider via the admin API and assert it was accepted +
 *      enabled. Exits non-zero on any failure (usable as a smoke check).
 *
 * Env (all optional, sensible localhost defaults):
 *   METIS_API_URL        default http://localhost:4000
 *   SAML_IDP_URL         default http://localhost:4500
 *   METIS_ADMIN_USER     default admin
 *   METIS_ADMIN_PASSWORD default password
 *   SAML_DEFAULT_ROLE    default admin
 *   SAML_PROVIDER_NAME   default "Local Mock SAML"
 *
 * Node built-ins + global fetch (Node 18+) only.
 */
import { DEFAULTS, buildSamlProviderBody, idpMetadataUrl, trimSlash } from "./lib/saml-harness.mjs";

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

async function main() {
  const metisApiUrl = trimSlash(process.env.METIS_API_URL ?? DEFAULTS.metisApiUrl);
  const idpUrl = trimSlash(process.env.SAML_IDP_URL ?? DEFAULTS.idpBaseUrl);
  const adminUser = process.env.METIS_ADMIN_USER ?? "admin";
  const adminPassword = process.env.METIS_ADMIN_PASSWORD ?? "password";
  const defaultRole = process.env.SAML_DEFAULT_ROLE ?? DEFAULTS.defaultRole;
  const name = process.env.SAML_PROVIDER_NAME ?? DEFAULTS.providerName;

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

  // 2. Fetch mock IdP metadata.
  const metaUrl = idpMetadataUrl(idpUrl);
  log(`fetching mock IdP metadata from ${metaUrl}`);
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) {
    die(
      `could not fetch IdP metadata (${metaRes.status}). Is the mock IdP up? ` +
        `Run: docker compose -f docker-compose.saml.yml up -d`,
    );
  }
  const idpMetadataXml = await metaRes.text();
  if (!idpMetadataXml.includes("X509Certificate")) {
    die(
      "IdP metadata has no X509Certificate — the mock IdP is running WITHOUT a " +
        "signing key. Set PUBLIC_KEY/PRIVATE_KEY (see scripts/saml-harness/up.sh).",
    );
  }
  ok("fetched signed IdP metadata (contains X509 cert)");

  // 3. PUT the SAML provider config.
  const body = buildSamlProviderBody({ idpMetadataXml, metisApiUrl, name, defaultRole });
  log("configuring METIS SAML provider via admin API");
  const putRes = await fetch(`${metisApiUrl}/api/admin/auth/providers/saml`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    die(`SAML provider PUT failed (${putRes.status}): ${text}`);
  }
  ok("SAML provider configuration accepted");

  // 4. Verify it round-trips (enabled + saml mode) via the admin read view.
  const listRes = await fetch(`${metisApiUrl}/api/admin/auth/providers`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) die(`could not re-read providers (${listRes.status})`);
  const listJson = /** @type {any} */ (await listRes.json());
  const providers = listJson?.data?.providers ?? [];
  const saml = providers.find((/** @type {any} */ p) => p.mode === "saml");
  if (!saml) die("SAML provider missing from admin read view after save");
  if (!saml.enabled) die("SAML provider was saved but is not enabled");
  ok(`SAML provider '${saml.name}' is configured and enabled`);

  process.stdout.write("\n");
  ok("SAML harness seed complete.");
  log(`Start the login flow at: ${metisApiUrl}/auth/saml/login`);
  log("Mock IdP test users: user1@example.com / user2@example.com (any password)");
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
