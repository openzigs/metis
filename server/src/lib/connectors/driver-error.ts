/**
 * Client-safe mapping for database-driver and connector allow-list errors.
 *
 * Driver error strings frequently leak usernames, resolved hostnames, ports,
 * database names, internal SQLSTATE, and connection-string fragments —
 * returning them verbatim is free reconnaissance for an attacker probing the
 * connector endpoints (OWASP A05). The allow-list errors are worse: they name
 * the private address the hostname resolved to.
 *
 * The raw message is kept in the server-side audit + log only.
 *
 * Extracted from `routes/suggested-connectors.ts` in #1084 so the DB connector
 * routes can reuse it instead of forwarding `ConnectorError.message`.
 */

/**
 * Codes whose message is built from driver output or resolved network detail.
 * Only these are rewritten — application-level codes (`*_NOT_FOUND`,
 * `VALIDATION_ERROR`, `VAULT_REF_INVALID`, SQL-validator rejections …) carry
 * no host detail and stay verbatim, because their text is the whole point.
 */
const DRIVER_DETAIL_CODES: ReadonlySet<string> = new Set([
  "DB_AUTH_FAILED",
  "DB_CONNECT_FAILED",
  "DB_NOT_FOUND",
  "DRIVER_UNSUPPORTED",
  "QUERY_TIMEOUT",
  "TLS_ERROR",
  "HOST_NOT_ALLOWED",
  "DNS_LOOKUP_FAILED",
  "DNS_LOOKUP_EMPTY",
]);

/** True when `code`'s message is driver/network-derived and must be rewritten. */
export function isDriverDetailCode(code: string): boolean {
  return DRIVER_DETAIL_CODES.has(code.toUpperCase());
}

/**
 * Map a raw driver / ConnectorError into a small, stable, client-safe
 * {errorCode, errorMessage} pair.
 */
export function sanitizeDriverError(
  code: string,
  rawMessage: string,
): { errorCode: string; errorMessage: string } {
  const upper = code.toUpperCase();
  // ConnectorError code mapping (drivers throw these via toConnectorError).
  switch (upper) {
    case "DB_AUTH_FAILED":
      return { errorCode: "auth_failed", errorMessage: "Authentication failed" };
    case "DB_CONNECT_FAILED":
      return { errorCode: "host_unreachable", errorMessage: "Could not reach database host" };
    case "QUERY_TIMEOUT":
      return { errorCode: "timeout", errorMessage: "Connection test timed out" };
    case "DB_NOT_FOUND":
      return { errorCode: "db_not_found", errorMessage: "Database not found" };
    case "TLS_ERROR":
      return { errorCode: "tls_error", errorMessage: "TLS handshake failed" };
    case "DRIVER_UNSUPPORTED":
      return { errorCode: "driver_unsupported", errorMessage: "Driver not supported" };
    case "HOST_NOT_ALLOWED":
      return {
        errorCode: "host_not_allowed",
        errorMessage:
          "Host is not on the connector allow-list. Add it to DB_ALLOWED_HOSTS (database) or REPO_ALLOWED_HOSTS (repository) in your environment config.",
      };
    case "DNS_LOOKUP_FAILED":
    case "DNS_LOOKUP_EMPTY":
      return { errorCode: "host_unreachable", errorMessage: "Could not reach database host" };
  }
  // Fall back to lightweight pattern matching on the raw message for cases
  // where the driver did not surface a ConnectorError. Matching is
  // intentionally narrow — anything ambiguous becomes "unknown".
  const m = rawMessage.toLowerCase();
  if (m.includes("password authentication") || m.includes("access denied")) {
    return { errorCode: "auth_failed", errorMessage: "Authentication failed" };
  }
  if (m.includes("njs-116") || m.includes("password verifier type")) {
    return {
      errorCode: "auth_failed",
      errorMessage:
        "Oracle password verifier not supported in thin mode. The database user's password must be reset to use a 12c+ verifier, or Oracle Instant Client must be installed for thick mode.",
    };
  }
  if (m.includes("host_not_allowed") || m.includes("not on allow-list")) {
    return {
      errorCode: "host_not_allowed",
      errorMessage:
        "Host is not on the connector allow-list. Add it to DB_ALLOWED_HOSTS (database) or REPO_ALLOWED_HOSTS (repository) in your environment config.",
    };
  }
  if (
    m.includes("econnrefused") ||
    m.includes("enotfound") ||
    m.includes("tns:no listener") ||
    m.includes("ehostunreach")
  ) {
    return { errorCode: "host_unreachable", errorMessage: "Could not reach database host" };
  }
  if (m.includes("etimedout") || m.includes("timeout")) {
    return { errorCode: "timeout", errorMessage: "Connection test timed out" };
  }
  if (m.includes("does not exist") && m.includes("database")) {
    return { errorCode: "db_not_found", errorMessage: "Database not found" };
  }
  if (m.includes("tls") || m.includes("ssl") || m.includes("certificate")) {
    return { errorCode: "tls_error", errorMessage: "TLS handshake failed" };
  }
  return { errorCode: "unknown", errorMessage: "Connection test failed" };
}
