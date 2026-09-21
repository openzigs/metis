/**
 * LDAP / Active Directory authentication provider.
 *
 * Epic #748, Issue #853: Full LDAP bind+search authentication.
 * Service-account bind → user search by sAMAccountName → user bind to verify password.
 */
import { Client } from "ldapts";
import { createChildLogger } from "../logger.js";
import type { AuthProvider, AuthResult, AuthenticatedUser } from "./types.js";
import { resolveRoleFromGroups } from "./sso-config.js";
import type { RoleKey } from "@metis/shared";

const log = createChildLogger("ldap-auth");

/** LDAP configuration. */
export interface LDAPConfig {
  url: string;
  baseDN: string;
  bindDN: string;
  bindPassword: string;
  userSearchBase: string;
  searchFilter: string;
  groupMappings: Array<{ claimValue: string; role: RoleKey }>;
  defaultRole: RoleKey;
  tlsSkipVerify: boolean;
  connectionTimeout: number;
}

/** In-memory LDAP config (admin-configurable at runtime). */
let ldapConfig: LDAPConfig | null = null;

/** Get the current LDAP config — falls back to env vars if no admin override. */
export function getLDAPConfig(): LDAPConfig {
  if (ldapConfig) return ldapConfig;

  return {
    url: process.env.AUTH_LDAP_URL ?? "",
    baseDN: process.env.AUTH_LDAP_BASE_DN ?? "",
    bindDN: process.env.AUTH_LDAP_BIND_DN ?? "",
    bindPassword: process.env.AUTH_LDAP_BIND_PASSWORD ?? "",
    userSearchBase: process.env.AUTH_LDAP_USER_SEARCH_BASE ?? "",
    searchFilter:
      process.env.AUTH_LDAP_SEARCH_FILTER ?? "(&(objectClass=user)(sAMAccountName={{username}}))",
    groupMappings: [],
    defaultRole: "reader",
    tlsSkipVerify: process.env.AUTH_LDAP_TLS_SKIP_VERIFY === "true",
    connectionTimeout: parseInt(process.env.AUTH_LDAP_CONNECTION_TIMEOUT ?? "10000", 10),
  };
}

/**
 * Refuse to skip LDAP TLS certificate verification in production.
 *
 * Issue #529 (Epic #517): `AUTH_LDAP_TLS_SKIP_VERIFY=true` disables TLS cert
 * verification on the LDAP connection. That is a legitimate escape hatch for
 * local dev against a self-signed directory (e.g. the #525 OpenLDAP harness),
 * but in production it silently allows a man-in-the-middle on the auth channel.
 *
 * We FAIL FAST rather than silently forcing verification on: if an operator set
 * the flag in production they have made an explicit (mistaken) decision, and a
 * silent override could mask a deployment that the operator believes is talking
 * to a verified directory when it is not. A loud failure forces them to either
 * fix the LDAP server's certificate or consciously remove the flag — which is
 * exactly the "no silent downgrade" property this guard exists to provide.
 *
 * Throws when `NODE_ENV==='production'` AND `tlsSkipVerify===true`. No-op
 * otherwise (dev/test may still skip for self-signed harness directories).
 */
export function assertLDAPTlsConfigSafe(config?: LDAPConfig): void {
  const cfg = config ?? getLDAPConfig();
  if (cfg.tlsSkipVerify && process.env.NODE_ENV === "production") {
    log.error(
      "Refusing to start LDAP TLS connection: AUTH_LDAP_TLS_SKIP_VERIFY is enabled in production",
    );
    throw new Error(
      "AUTH_LDAP_TLS_SKIP_VERIFY=true is not permitted in production: disabling LDAP TLS " +
        "certificate verification allows man-in-the-middle attacks on the authentication " +
        "channel. Provide a valid/trusted certificate for the LDAP server and remove the flag. " +
        "(This flag is for local development only — e.g. the self-signed LDAP test harness.)",
    );
  }
}

/**
 * Resolve the `ldapts` `tlsOptions` for a connection, enforcing the production
 * guard. Returns `undefined` for secure (default) verification, or
 * `{ rejectUnauthorized: false }` when skip-verify is explicitly enabled in a
 * non-production environment. Throws in production via {@link assertLDAPTlsConfigSafe}.
 */
export function resolveLDAPTlsOptions(
  config: LDAPConfig,
): { rejectUnauthorized: false } | undefined {
  assertLDAPTlsConfigSafe(config);
  // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- TLS verification is only disabled when an administrator explicitly opts in via the `tlsSkipVerify` config flag in a NON-production environment (assertLDAPTlsConfigSafe throws in prod); intentional escape hatch for self-signed enterprise LDAP in local dev.
  return config.tlsSkipVerify ? { rejectUnauthorized: false } : undefined;
}

/** Set LDAP config from the admin UI. */
export function setLDAPConfig(config: LDAPConfig): void {
  ldapConfig = config;
  log.info("LDAP config updated via admin UI", { url: config.url, baseDN: config.baseDN });
}

/** Clear LDAP config (revert to env-based). Used in tests. */
export function clearLDAPConfig(): void {
  ldapConfig = null;
}

/** Get the sanitized config for the admin UI (no password). */
export function getLDAPConfigForUI(): Omit<LDAPConfig, "bindPassword"> & { configured: boolean } {
  const cfg = getLDAPConfig();
  const { bindPassword: _, ...safe } = cfg;
  return { ...safe, configured: !!cfg.url && !!cfg.bindDN && !!cfg.bindPassword };
}

/**
 * Test LDAP connectivity using a service-account bind.
 * Returns null on success, or an error message on failure.
 */
export async function testLDAPConnection(config?: LDAPConfig): Promise<string | null> {
  const cfg = config ?? getLDAPConfig();
  if (!cfg.url || !cfg.bindDN || !cfg.bindPassword) {
    return "LDAP URL, Bind DN, and Bind Password are required";
  }

  const client = new Client({
    url: cfg.url,
    timeout: cfg.connectionTimeout,
    connectTimeout: cfg.connectionTimeout,
    tlsOptions: resolveLDAPTlsOptions(cfg),
  });

  try {
    await client.bind(cfg.bindDN, cfg.bindPassword);
    log.info("LDAP connection test successful", { url: cfg.url });
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("LDAP connection test failed", { url: cfg.url, error: msg });
    return `LDAP connection failed: ${msg}`;
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore unbind errors */
    }
  }
}

/**
 * Extract CN group names from full LDAP DNs.
 * e.g. "CN=DevOps,OU=Groups,DC=ad,DC=example,DC=com" → "DevOps"
 */
function extractGroupNames(memberOf: string | string[] | undefined): string[] {
  if (!memberOf) return [];
  const dns = Array.isArray(memberOf) ? memberOf : [memberOf];
  return dns.map((dn) => {
    const match = dn.match(/^CN=([^,]+)/i);
    return match ? match[1] : dn;
  });
}

export class LDAPAuthProvider implements AuthProvider {
  readonly name = "ldap";

  async authenticate(username: string, password: string): Promise<AuthResult> {
    const config = getLDAPConfig();

    if (!config.url || !config.bindDN || !config.bindPassword) {
      log.warn("LDAP provider not configured", { url: config.url });
      return {
        success: false,
        error: "LDAP authentication is not configured. Contact your administrator.",
      };
    }

    const client = new Client({
      url: config.url,
      timeout: config.connectionTimeout,
      connectTimeout: config.connectionTimeout,
      tlsOptions: resolveLDAPTlsOptions(config),
    });

    try {
      // Step 1: Bind with service account to search for the user
      await client.bind(config.bindDN, config.bindPassword);
      log.debug("LDAP service account bind successful", { url: config.url });

      // Step 2: Search for the user by username
      const filter = config.searchFilter.replace(/\{\{username\}\}/g, escapeLDAPFilter(username));
      const searchBase = config.userSearchBase || config.baseDN;

      const { searchEntries } = await client.search(searchBase, {
        filter,
        scope: "sub",
        attributes: ["dn", "sAMAccountName", "displayName", "mail", "givenName", "sn", "memberOf"],
        sizeLimit: 1,
        timeLimit: 10,
      });

      if (searchEntries.length === 0) {
        log.info("LDAP user not found", { username });
        return { success: false, error: "Invalid username or password" };
      }

      const entry = searchEntries[0];
      const userDN = entry.dn;

      // Step 3: Unbind service account and bind as the user to verify password
      await client.unbind();

      const userClient = new Client({
        url: config.url,
        timeout: config.connectionTimeout,
        connectTimeout: config.connectionTimeout,
        tlsOptions: resolveLDAPTlsOptions(config),
      });

      try {
        await userClient.bind(userDN, password);
      } catch {
        log.info("LDAP authentication failed — invalid credentials", { username });
        return { success: false, error: "Invalid username or password" };
      } finally {
        try {
          await userClient.unbind();
        } catch {
          /* ignore */
        }
      }

      // Step 4: Build authenticated user from LDAP attributes
      const displayName =
        getStringAttr(entry.displayName) ||
        [getStringAttr(entry.givenName), getStringAttr(entry.sn)].filter(Boolean).join(" ") ||
        username;
      const email = getStringAttr(entry.mail) ?? "";
      const groups = extractGroupNames(entry.memberOf as string | string[] | undefined);

      // Resolve role from group mappings
      const role = resolveRoleFromGroups(groups, config.groupMappings, config.defaultRole);

      const user: AuthenticatedUser = {
        username,
        displayName,
        email,
        role,
        groups,
      };

      log.info("LDAP authentication successful", { username, groups: groups.length });
      return { success: true, user };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED")) {
        log.error("LDAP server connection refused", { url: config.url });
        return { success: false, error: "Authentication service unavailable" };
      }
      if (msg.includes("ETIMEDOUT")) {
        log.error("LDAP server connection timeout", { url: config.url });
        return { success: false, error: "Authentication service unavailable" };
      }
      log.error("LDAP authentication error", { username, error: msg });
      return { success: false, error: "Authentication service error" };
    } finally {
      try {
        await client.unbind();
      } catch {
        /* ignore — may already be unbound */
      }
    }
  }
}

/** Safely extract a string attribute (LDAP may return arrays). */
function getStringAttr(val: unknown): string | undefined {
  if (!val) return undefined;
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length > 0) return String(val[0]);
  return String(val);
}

/** Escape special characters in LDAP filter values (RFC 4515). */
function escapeLDAPFilter(value: string): string {
  return value.replace(/[\\*()\0/]/g, (ch) => {
    return "\\" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  });
}
