/**
 * #344 — does a connector write change WHERE its vault secret is sent?
 *
 * Used with `assertSecretBindingAllowed` (lib/vault/secret-binding.ts): a caller
 * without `vault.reveal` may not move a connector that holds a secret they did
 * not create. Only the fields a request actually names are compared, and an
 * unchanged value re-sent by a full-form save is not a change.
 */
import { isDeepStrictEqual } from "node:util";

/**
 * DB driver `options` keys that never choose the destination. `allowList` is
 * the #882 per-connector table/column allow-list, read by the SQL validator.
 * Every other key reaches the driver (mysql spreads `options` over host/port,
 * Oracle's `tnsAlias` becomes the whole connect string), so it counts.
 */
const DB_OPTION_KEYS_NOT_DESTINATION = new Set(["allowList"]);

/** The destination-bearing part of a DB `options` value (JSON string or object). */
export function dbDestinationOptions(options: unknown): unknown {
  let value = options;
  if (typeof value === "string") {
    if (value.trim() === "") return {};
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([k]) => !DB_OPTION_KEYS_NOT_DESTINATION.has(k),
    ),
  );
}

/** True when `options` carries any key that can redirect a driver. */
export function hasDbDestinationOptions(options: unknown): boolean {
  const d = dbDestinationOptions(options);
  if (d !== null && typeof d === "object" && !Array.isArray(d)) {
    return Object.keys(d).length > 0;
  }
  return true;
}

const blank = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const portOf = (v: number | null | undefined) => (v ? v : null);

/**
 * Oracle's driver builds its connect string as `host:port/<serviceName>`, and
 * the service name falls back to the connector's free-text `databaseName`.
 * Easy Connect Plus accepts `?param=` options there, so for Oracle the
 * database name is part of the destination. For every other driver it names a
 * database on the same server and is not. True when the two name the same
 * Oracle service (or the driver is not Oracle).
 */
export function sameOracleService(
  driver: string | null | undefined,
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return driver !== "oracle" || blank(a) === blank(b);
}

export function dbDestinationChanged(
  existing: {
    driver: string;
    host: string | null;
    port: number | null;
    options: string | null;
    databaseName?: string | null;
  },
  patch: {
    driver?: string | null;
    host?: string | null;
    port?: number | null;
    options?: string | null;
    databaseName?: string | null;
  },
): boolean {
  if (patch.driver !== undefined && patch.driver !== existing.driver) return true;
  if (
    patch.databaseName !== undefined &&
    !sameOracleService(existing.driver, patch.databaseName, existing.databaseName)
  ) {
    return true;
  }
  if (patch.host !== undefined && blank(patch.host) !== blank(existing.host)) return true;
  if (patch.port !== undefined && portOf(patch.port) !== portOf(existing.port)) return true;
  if (
    patch.options !== undefined &&
    !isDeepStrictEqual(dbDestinationOptions(patch.options), dbDestinationOptions(existing.options))
  ) {
    return true;
  }
  return false;
}

/**
 * The token only ever goes to `apiBaseUrl` (the provider's default when
 * unset), so `ownerOrOrg` / `repoName` are deliberately NOT a destination:
 * changing them cannot send the secret anywhere new. They do choose WHICH repo
 * the token reads, so a coordinator can repoint a connector holding an admin's
 * token at another repo that token can read and ingest it (without seeing the
 * token). That is an authorization question, not exfiltration of the secret,
 * and is out of scope for the #344 binding (PR #359 review; tracked in #358).
 */
export function repoDestinationChanged(
  existing: { provider: string; apiBaseUrl: string | null },
  patch: { provider?: string | null; apiBaseUrl?: string | null },
): boolean {
  if (patch.provider !== undefined && patch.provider !== existing.provider) return true;
  if (patch.apiBaseUrl !== undefined && blank(patch.apiBaseUrl) !== blank(existing.apiBaseUrl)) {
    return true;
  }
  return false;
}

/**
 * #358 — does a Jira connection PATCH change where its API token is sent?
 * The base URL and proxy choose the peer; turning off certificate checks or
 * supplying a new CA lets a peer on the path impersonate the host. Edition and
 * username change how the token is presented, not to whom. Removing a CA is a
 * stricter check, not a new destination.
 */
export function jiraDestinationChanged(
  existing: { baseUrl: string; proxyUrl: string | null; tlsRejectUnauthorized: boolean },
  input: {
    baseUrl?: string;
    proxyUrl?: string | null;
    tlsRejectUnauthorized?: boolean;
    tlsCaCert?: string | null;
  },
): boolean {
  return (
    (input.baseUrl !== undefined && input.baseUrl !== existing.baseUrl) ||
    (input.proxyUrl !== undefined && (input.proxyUrl ?? null) !== existing.proxyUrl) ||
    (input.tlsRejectUnauthorized !== undefined &&
      input.tlsRejectUnauthorized !== existing.tlsRejectUnauthorized) ||
    Boolean(input.tlsCaCert)
  );
}

/** The test-management counterpart of {@link jiraDestinationChanged}. */
export function testMgmtDestinationChanged(
  existing: { baseUrl: string; proxyConfigJson: string | null; tlsConfigJson: string | null },
  input: {
    baseUrl?: string;
    proxyConfig?: { url: string } | null;
    tlsConfig?: { rejectUnauthorized?: boolean; caCert?: string | null } | null;
  },
): boolean {
  if (input.baseUrl !== undefined && input.baseUrl !== existing.baseUrl) return true;
  if (input.proxyConfig !== undefined) {
    const before = existing.proxyConfigJson ? parseOrNull(existing.proxyConfigJson) : null;
    if (!isDeepStrictEqual(input.proxyConfig ?? null, before)) return true;
  }
  if (input.tlsConfig !== undefined) {
    if (input.tlsConfig?.caCert) return true;
    const before = existing.tlsConfigJson
      ? (parseOrNull(existing.tlsConfigJson) as { rejectUnauthorized?: boolean } | null)
      : null;
    const rejectBefore = before?.rejectUnauthorized ?? true;
    const rejectAfter = input.tlsConfig?.rejectUnauthorized ?? true;
    if (rejectBefore !== rejectAfter) return true;
  }
  return false;
}

function parseOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
