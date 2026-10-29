/**
 * #1559 — run the Entra-profile mock IdP (#1553, `mock-entra-saml-idp.mjs`)
 * next to a dev server, so an Entra sign-in can be clicked through by hand.
 *
 * `runEntraHarness` starts the mock on a fixed loopback port with an account
 * picker of preset users, then seeds METIS's SAML provider from the mock's
 * Federation Metadata through the admin API, as `scripts/seed-saml.mjs` does
 * for the generic harness. The runner `scripts/entra-idp.mjs` (`pnpm
 * saml:entra`, `make entra-up`) wires it to the process; everything else lives
 * here so it is unit-tested against a fake METIS.
 *
 * The tenant, user object ids and group object ids are fixed, so a restart
 * signs the same people in as the same METIS users (#1395 binds a username to
 * the IdP issuer and subject that first used it). The signing key is not: the
 * mock mints it at startup and keeps it in memory only, and every start
 * re-seeds METIS with the new certificate.
 *
 * Node built-ins + global fetch only (and the mock's `xml-crypto`).
 */
import { SIGNING_OPTIONS, startMockEntraSamlIdp } from "./mock-entra-saml-idp.mjs";
import { trimSlash } from "./saml-harness.mjs";

/** The admin and member groups' object ids, as Entra sends them in `groups`. */
export const ENTRA_GROUPS = Object.freeze({
  admins: "1559a0a0-0000-4000-8000-0000000000ad",
  members: "1559a0a0-0000-4000-8000-00000000006d",
});

export const ENTRA_HARNESS_DEFAULTS = Object.freeze({
  /** Loopback only; the mock is never reachable from another machine. */
  host: "127.0.0.1",
  /** Next to the generic harness (:4500), Keycloak (:4600) and OpenLDAP (:4400). */
  port: 4510,
  tenantId: "1559e17a-0000-4000-8000-000000000001",
  metisApiUrl: "http://localhost:4000",
  appUrl: "http://localhost:3000",
  /** What azure-ad.md tells an admin to choose; `assertion` reproduces Entra's default. */
  signing: /** @type {"both" | "assertion" | "response"} */ ("both"),
  providerName: "Microsoft Entra ID (mock)",
  /** A user in neither group, or one whose groups overflowed, lands here. */
  defaultRole: "reader",
});

/**
 * The accounts the mock's picker offers, and the METIS role each should land
 * with under the seeded group mappings.
 *
 * @type {ReadonlyArray<import("./mock-entra-saml-idp.mjs").EntraAccount & { expectedRole: string }>}
 */
export const PRESET_ACCOUNTS = Object.freeze([
  {
    user: {
      upn: "ada.admin@contoso.example",
      objectId: "1559ada0-0000-4000-8000-000000000001",
      displayName: "Ada Admin",
      groups: [ENTRA_GROUPS.admins],
    },
    profile: { mfa: true },
    note: "METIS Admins group, signed in with MFA",
    expectedRole: "admin",
  },
  {
    user: {
      upn: "max.member@contoso.example",
      objectId: "1559ada0-0000-4000-8000-000000000002",
      displayName: "Max Member",
      groups: [ENTRA_GROUPS.members],
    },
    profile: { mfa: false },
    note: "METIS Members group, password only",
    expectedRole: "developer",
  },
  {
    user: {
      upn: "olga.overage@contoso.example",
      objectId: "1559ada0-0000-4000-8000-000000000003",
      displayName: "Olga Overage",
      groups: [ENTRA_GROUPS.admins],
    },
    profile: { mfa: true, groupOverage: true },
    note: "in over 150 groups: Entra sends groups.link, not groups",
    expectedRole: ENTRA_HARNESS_DEFAULTS.defaultRole,
  },
]);

/**
 * METIS's SP endpoints. The API serves them under `/api/auth/saml`
 * (`server/src/app.ts` mounts the API router at `/api`).
 *
 * @param {string} metisApiUrl
 */
export function spEndpoints(metisApiUrl) {
  const base = `${trimSlash(metisApiUrl)}/api/auth/saml`;
  return { entityId: `${base}/metadata`, acsUrl: `${base}/acs`, loginUrl: `${base}/login` };
}

/** @param {string} value @returns {(typeof SIGNING_OPTIONS)[number][0]} */
function parseSigning(value) {
  const match = SIGNING_OPTIONS.find(([option]) => option === value);
  if (!match) {
    throw new Error(
      `unknown signing option '${value}': use ${SIGNING_OPTIONS.map(([o]) => o).join(", ")}`,
    );
  }
  return match[0];
}

/** @param {string} value */
function parsePort(value) {
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) {
    throw new Error(`invalid port '${value}': use a number from 0 to 65535`);
  }
  return Number(value);
}

/**
 * @typedef {object} EntraHarnessConfig
 * @property {string} host
 * @property {number} port
 * @property {string} tenantId
 * @property {string} metisApiUrl
 * @property {string} appUrl
 * @property {"both" | "assertion" | "response"} signing
 * @property {string} providerName
 * @property {string} adminUser
 * @property {string} adminPassword
 * @property {boolean} seed
 */

/**
 * The runner's settings from its environment and arguments; an argument wins
 * over the environment. Throws on a value it cannot use.
 *
 * Arguments: `--signing=<both|assertion|response>`, `--port=<n>`, `--no-seed`.
 * Environment: ENTRA_SIGNING, ENTRA_IDP_PORT, METIS_API_URL, METIS_APP_URL,
 * METIS_ADMIN_USER, METIS_ADMIN_PASSWORD, ENTRA_PROVIDER_NAME, SKIP_SEED=1.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string[]} argv
 * @returns {EntraHarnessConfig}
 */
export function resolveHarnessConfig(env, argv) {
  /** @type {Record<string, string>} */
  const args = {};
  let seed = env.SKIP_SEED !== "1";
  for (const arg of argv) {
    const match = /^--(signing|port)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
    else if (arg === "--no-seed") seed = false;
    else throw new Error(`unknown argument '${arg}': use --signing=, --port= or --no-seed`);
  }
  const d = ENTRA_HARNESS_DEFAULTS;
  return {
    host: d.host,
    port: parsePort(args.port ?? env.ENTRA_IDP_PORT ?? String(d.port)),
    tenantId: d.tenantId,
    metisApiUrl: trimSlash(env.METIS_API_URL || d.metisApiUrl),
    appUrl: trimSlash(env.METIS_APP_URL || d.appUrl),
    signing: parseSigning(args.signing ?? env.ENTRA_SIGNING ?? d.signing),
    providerName: env.ENTRA_PROVIDER_NAME || d.providerName,
    adminUser: env.METIS_ADMIN_USER || "admin",
    adminPassword: env.METIS_ADMIN_PASSWORD || "password",
    seed,
  };
}

/**
 * The body for `PUT /api/admin/auth/providers/saml`: what an admin pastes from
 * the enterprise app, with each preset group mapped to a role.
 *
 * @param {{ metadataXml: string, metisApiUrl: string, providerName: string }} input
 */
export function buildEntraProviderBody(input) {
  if (!input.metadataXml.includes("X509Certificate")) {
    throw new Error("the mock's Federation Metadata carries no signing certificate");
  }
  const sp = spEndpoints(input.metisApiUrl);
  return {
    name: input.providerName,
    enabled: true,
    entityId: sp.entityId,
    acsUrl: sp.acsUrl,
    idpMetadataXml: input.metadataXml,
    // Entra does not require a signed AuthnRequest unless the app asks for it.
    signRequests: false,
    // #520's secure default; the mock signs both unless told otherwise.
    requireSignedResponse: true,
    groupMappings: [
      { claimValue: ENTRA_GROUPS.admins, role: "admin" },
      { claimValue: ENTRA_GROUPS.members, role: "developer" },
    ],
    defaultRole: ENTRA_HARNESS_DEFAULTS.defaultRole,
  };
}

/**
 * Log in to METIS as the mock admin, PUT the SAML provider, and read it back.
 * Throws with the step that failed.
 *
 * @param {{
 *   fetchImpl: typeof fetch, metisApiUrl: string, adminUser: string,
 *   adminPassword: string, body: Record<string, unknown>,
 * }} input
 * @returns {Promise<{ name: string }>}
 */
export async function seedEntraProvider(input) {
  const api = trimSlash(input.metisApiUrl);
  const login = await input
    .fetchImpl(`${api}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: input.adminUser, password: input.adminPassword }),
    })
    .catch((/** @type {unknown} */ err) => {
      throw new Error(
        `could not reach METIS at ${api} (${err instanceof Error ? err.message : String(err)}). ` +
          "Start the dev server first, or set METIS_API_URL.",
      );
    });
  if (!login.ok) {
    throw new Error(
      `admin login at ${api} failed (${login.status}). Is the server up with AUTH_MODE=mock? ` +
        "Set METIS_ADMIN_USER / METIS_ADMIN_PASSWORD if you changed the mock credentials.",
    );
  }
  const token = /** @type {any} */ (await login.json())?.data?.accessToken;
  if (typeof token !== "string") throw new Error("the admin login returned no accessToken");
  const auth = { authorization: `Bearer ${token}` };

  const put = await input.fetchImpl(`${api}/api/admin/auth/providers/saml`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify(input.body),
  });
  if (!put.ok) {
    throw new Error(`the SAML provider PUT failed (${put.status}): ${await put.text()}`);
  }

  const list = await input.fetchImpl(`${api}/api/admin/auth/providers`, { headers: auth });
  if (!list.ok) throw new Error(`could not read the providers back (${list.status})`);
  const providers = /** @type {any} */ (await list.json())?.data?.providers ?? [];
  const saml = providers.find((/** @type {any} */ p) => p.mode === "saml");
  if (!saml?.enabled) throw new Error("the SAML provider is not enabled after the PUT");
  return { name: String(saml.name) };
}

/** The line `make entra-up` waits for. */
export const READY_LINE = "Mock Entra ID is up.";

/**
 * What the runner prints: where to sign in, who can, and how to change it.
 *
 * @param {{
 *   config: EntraHarnessConfig, metadataUrl: string, seeded: boolean,
 * }} input
 */
export function formatBanner(input) {
  const { config } = input;
  const sp = spEndpoints(config.metisApiUrl);
  const signingLabel = SIGNING_OPTIONS.find(([o]) => o === config.signing)?.[1];
  const users = PRESET_ACCOUNTS.map(
    (a) =>
      `    ${a.user.displayName.padEnd(13)} ${a.user.upn.padEnd(29)} -> ${a.expectedRole.padEnd(9)} ${a.note}`,
  );
  return [
    "",
    `Federation Metadata: ${input.metadataUrl}`,
    input.seeded
      ? `METIS SAML provider: '${config.providerName}' seeded at ${config.metisApiUrl}`
      : `METIS SAML provider: not seeded; paste the metadata in Admin -> Authentication -> SAML 2.0 ` +
        `(SP Entity ID ${sp.entityId}, ACS URL ${sp.acsUrl})`,
    "",
    `Sign in:   ${config.appUrl}/login, button '${config.providerName}'`,
    `           or ${sp.loginUrl}`,
    "Users (pick one on the mock's account picker; no password):",
    ...users,
    `Signing:   ${signingLabel} by default; the picker switches it per sign-in.`,
    "           'Sign SAML assertion' is Entra's default, which METIS refuses.",
    "Stop:      Ctrl-C, or make entra-down",
    "",
    READY_LINE,
    "",
  ].join("\n");
}

/**
 * Start the mock and seed METIS. On a seed failure the mock is closed before
 * the error is rethrown.
 *
 * @param {{
 *   config: EntraHarnessConfig, fetchImpl?: typeof fetch,
 *   log?: (line: string) => void,
 * }} input
 */
export async function runEntraHarness(input) {
  const { config } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const log = input.log ?? (() => {});
  const sp = spEndpoints(config.metisApiUrl);
  let idp;
  try {
    idp = await startMockEntraSamlIdp({
      spEntityId: sp.entityId,
      acsUrl: sp.acsUrl,
      user: PRESET_ACCOUNTS[0].user,
      accounts: [...PRESET_ACCOUNTS],
      tenantId: config.tenantId,
      host: config.host,
      port: config.port,
      profile: { signing: config.signing },
    });
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "EADDRINUSE") {
      throw new Error(
        `port ${config.port} is in use; is the mock already up? Run make entra-down, ` +
          "or pick another port with ENTRA_IDP_PORT.",
      );
    }
    throw err;
  }
  log(`mock Entra ID listening at ${idp.ssoUrl.replace(/\/[^/]+\/saml2$/, "")}`);
  if (config.seed) {
    try {
      const metadataXml = await (await fetchImpl(idp.metadataUrl)).text();
      log(`seeding the METIS SAML provider at ${config.metisApiUrl}`);
      await seedEntraProvider({
        fetchImpl,
        metisApiUrl: config.metisApiUrl,
        adminUser: config.adminUser,
        adminPassword: config.adminPassword,
        body: buildEntraProviderBody({
          metadataXml,
          metisApiUrl: config.metisApiUrl,
          providerName: config.providerName,
        }),
      });
    } catch (err) {
      await idp.close();
      throw err;
    }
  }
  return {
    idp,
    banner: formatBanner({ config, metadataUrl: idp.metadataUrl, seeded: config.seed }),
  };
}
