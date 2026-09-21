#!/usr/bin/env node
/**
 * Verify the LOCAL OpenLDAP harness (Issue #525, Epic #517).
 *
 * Unlike seed-oidc.mjs / seed-saml.mjs — which CONFIGURE METIS via the admin API
 * — LDAP is ENV-DRIVEN (AUTH_MODE=ldap + AUTH_LDAP_* env vars read by
 * server/src/lib/auth/ldap-provider.ts). So there is nothing to "seed into METIS"
 * here; instead this script is a SMOKE CHECK that the local directory is wired
 * the way METIS's LDAP provider expects:
 *
 *   1. Service-account (admin) BIND — the same bind the provider does before it
 *      can search (ldap-provider.ts:141).
 *   2. For each seeded user: SEARCH with the SAME filter shape METIS uses
 *      (AUTH_LDAP_SEARCH_FILTER with {{username}} substituted), assert exactly one
 *      entry, then BIND AS THE USER with their password — the exact 3-step flow
 *      the provider performs (search → user bind → attribute read).
 *   3. Extract the user's groups from `memberOf` the SAME way the provider does
 *      (CN of each group DN) and assert `resolveRoleForGroups` yields the expected
 *      METIS role — proving group→role mapping will work.
 *
 * Then it PRINTS the exact `AUTH_LDAP_*` env block to export so METIS points at
 * this directory. Exits non-zero on any failure (usable as a CI-free smoke check).
 *
 * NOTE on group→role at LOGIN: env-only LDAP config has empty `groupMappings`, so
 * a pure env login resolves everyone to `AUTH_LDAP`'s defaultRole (reader). To make
 * the mapping take effect at login, configure it via the admin API
 * (PUT /api/admin/auth/providers/ldap) — see docs/auth/ldap-local-testing.md. Pass
 * --configure-metis to have this script do that too (requires a running METIS
 * server + admin creds).
 *
 * Env (all optional, sensible localhost defaults; names mirror the siblings):
 *   LDAP_URL                default ldap://localhost:4400
 *   LDAP_BASE_DN            default dc=metis,dc=local
 *   LDAP_BIND_DN            default cn=admin,dc=metis,dc=local
 *   LDAP_BIND_PASSWORD      default adminpassword       (matches docker-compose.ldap.yml)
 *   LDAP_USER_SEARCH_BASE   default ou=users,dc=metis,dc=local
 *   METIS_API_URL           default http://localhost:4000   (only for --configure-metis)
 *   METIS_ADMIN_USER        default admin                   (only for --configure-metis)
 *   METIS_ADMIN_PASSWORD    default password                (only for --configure-metis)
 *
 * Requires the `ldapts` client (already a server dependency). We import it from
 * the repo's server workspace so this script needs no extra install.
 */
import { createRequire } from "node:module";
import {
  DEFAULTS,
  SEED_USERS,
  DEFAULT_GROUP_MAPPINGS,
  buildLdapEnvBlock,
  buildLdapProviderBody,
  renderEnvExport,
  resolveRoleForGroups,
  trimSlash,
} from "./lib/ldap-harness.mjs";

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

/** Resolve the `ldapts` Client from the server workspace (no root dependency). */
async function loadLdaptsClient() {
  try {
    const mod = await import("ldapts");
    return mod.Client;
  } catch {
    // Not resolvable from the scripts CWD — fall back to the server workspace,
    // where ldapts is a declared dependency.
    try {
      const require = createRequire(import.meta.url);
      const serverEntry = require.resolve("ldapts", {
        paths: [new URL("../server/", import.meta.url).pathname],
      });
      const mod = await import(serverEntry);
      return mod.Client;
    } catch (err) {
      die(
        "could not load the 'ldapts' client. Run `pnpm install` so the server " +
          "workspace dependency is available. " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

/** Extract bare group CNs from a memberOf value the SAME way the provider does. */
function extractGroupNames(memberOf) {
  if (!memberOf) return [];
  const dns = Array.isArray(memberOf) ? memberOf : [memberOf];
  return dns.map((dn) => {
    const m = String(dn).match(/^CN=([^,]+)/i);
    return m ? m[1] : String(dn);
  });
}

async function configureMetis(envBlock) {
  const metisApiUrl = trimSlash(process.env.METIS_API_URL ?? DEFAULTS_API);
  const adminUser = process.env.METIS_ADMIN_USER ?? "admin";
  const adminPassword = process.env.METIS_ADMIN_PASSWORD ?? "password";

  log(`configuring METIS LDAP provider via admin API at ${metisApiUrl}`);
  const loginRes = await fetch(`${metisApiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: adminUser, password: adminPassword }),
  });
  if (!loginRes.ok) {
    die(
      `admin login failed (${loginRes.status}). For --configure-metis you need a ` +
        `running METIS server where '${adminUser}' is an admin (e.g. AUTH_MODE=mock, ` +
        `or AUTH_MODE=ldap with alice as the admin).`,
    );
  }
  const token = (await loginRes.json())?.data?.accessToken;
  if (!token) die("login response had no accessToken");

  const body = buildLdapProviderBody({
    url: envBlock.AUTH_LDAP_URL,
    baseDN: envBlock.AUTH_LDAP_BASE_DN,
    bindDN: envBlock.AUTH_LDAP_BIND_DN,
    bindPassword: envBlock.AUTH_LDAP_BIND_PASSWORD,
    userSearchBase: envBlock.AUTH_LDAP_USER_SEARCH_BASE,
    searchFilter: envBlock.AUTH_LDAP_SEARCH_FILTER,
    groupMappings: DEFAULT_GROUP_MAPPINGS.map((m) => ({ ...m })),
  });
  const putRes = await fetch(`${metisApiUrl}/api/admin/auth/providers/ldap`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    die(`LDAP provider PUT failed (${putRes.status}): ${text}`);
  }
  ok("METIS LDAP provider configured with group→role mappings (admin API)");
}

const DEFAULTS_API = "http://localhost:4000";

async function main() {
  const Client = await loadLdaptsClient();

  const url = trimSlash(process.env.LDAP_URL ?? DEFAULTS.url);
  const baseDN = process.env.LDAP_BASE_DN ?? DEFAULTS.baseDN;
  const bindDN = process.env.LDAP_BIND_DN ?? DEFAULTS.bindDN;
  const bindPassword = process.env.LDAP_BIND_PASSWORD ?? DEFAULTS.bindPassword;
  const userSearchBase = process.env.LDAP_USER_SEARCH_BASE ?? DEFAULTS.userSearchBase;

  // The exact AUTH_LDAP_* env block METIS will use (derived from provider source).
  const envBlock = buildLdapEnvBlock({ url, baseDN, bindDN, bindPassword, userSearchBase });
  const searchFilter = envBlock.AUTH_LDAP_SEARCH_FILTER;

  // 1. Service-account bind (the provider's step 1).
  log(`binding as service account ${bindDN} at ${url}`);
  const client = new Client({ url, timeout: DEFAULTS.connectionTimeout });
  try {
    await client.bind(bindDN, bindPassword);
  } catch (err) {
    await safeUnbind(client);
    die(
      `service-account bind failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Is the LDAP harness up? Run: docker compose -f docker-compose.ldap.yml up -d`,
    );
  }
  ok("service-account bind succeeded");

  // 2+3. For each seeded user: search → user bind → group→role assertion.
  for (const user of SEED_USERS) {
    const filter = searchFilter.replace(/\{\{username\}\}/g, user.uid);
    const { searchEntries } = await client.search(userSearchBase, {
      filter,
      scope: "sub",
      attributes: ["dn", "uid", "displayName", "mail", "memberOf"],
    });
    if (searchEntries.length !== 1) {
      await safeUnbind(client);
      die(`expected exactly 1 entry for '${user.uid}', got ${searchEntries.length}`);
    }
    const entry = searchEntries[0];

    // Bind as the user to verify the seeded password (provider step 3).
    const userClient = new Client({ url, timeout: DEFAULTS.connectionTimeout });
    try {
      await userClient.bind(entry.dn, user.password);
    } catch {
      await safeUnbind(client);
      die(`user bind failed for '${user.uid}' — seeded password mismatch?`);
    } finally {
      await safeUnbind(userClient);
    }

    // Group→role assertion (same memberOf → CN extraction the provider uses).
    const groups = extractGroupNames(entry.memberOf);
    const role = resolveRoleForGroups(
      groups,
      DEFAULT_GROUP_MAPPINGS.map((m) => ({ ...m })),
      DEFAULTS.defaultRole,
    );
    if (role !== user.expectedRole) {
      await safeUnbind(client);
      die(
        `group→role mismatch for '${user.uid}': groups=[${groups.join(", ")}] ` +
          `resolved '${role}', expected '${user.expectedRole}'`,
      );
    }
    ok(
      `'${user.uid}' binds, memberOf=[${groups.join(", ")}] → role '${role}' (expected '${user.expectedRole}')`,
    );
  }

  await safeUnbind(client);
  ok("LDAP directory smoke check passed — users, passwords and group→role all verified");

  if (process.argv.includes("--configure-metis")) {
    await configureMetis(envBlock);
  }

  // Print the env block the developer exports to point METIS at this directory.
  process.stdout.write("\n");
  ok("Export this AUTH_LDAP_* block, then start METIS to use LDAP login:");
  process.stdout.write("\n" + renderEnvExport(envBlock) + "\n\n");
  log("Test users (uid / password): alice / alicepass (admin), bob / bobpass (developer)");
  log("Log in at the METIS UI with the uid + password (POST /api/auth/login).");
  log(
    "Env-only login resolves everyone to defaultRole (reader); for mapped roles " +
      "run with --configure-metis (or set groupMappings via the admin UI).",
  );
}

/** @param {{unbind: () => Promise<void>}} client */
async function safeUnbind(client) {
  try {
    await client.unbind();
  } catch {
    /* ignore */
  }
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
