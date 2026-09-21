/**
 * Issue #1084 — `sanitizeDriverError` is the only thing standing between a raw
 * driver string (host, port, database, username, SQLSTATE, and occasionally a
 * credential fragment) and the API client. Every branch is pinned here because
 * the fallback matchers are what catch drivers that never raised a
 * `ConnectorError`.
 */
import { describe, expect, it } from "vitest";
import {
  isDriverDetailCode,
  sanitizeDriverError,
} from "../../../src/lib/connectors/driver-error.js";

describe("isDriverDetailCode", () => {
  it("selects driver + resolved-network codes, and nothing else", () => {
    for (const code of [
      "DB_AUTH_FAILED",
      "DB_CONNECT_FAILED",
      "DB_NOT_FOUND",
      "DRIVER_UNSUPPORTED",
      "QUERY_TIMEOUT",
      "TLS_ERROR",
      "HOST_NOT_ALLOWED",
      "DNS_LOOKUP_FAILED",
      "DNS_LOOKUP_EMPTY",
    ]) {
      expect(isDriverDetailCode(code)).toBe(true);
      expect(isDriverDetailCode(code.toLowerCase())).toBe(true);
    }
    for (const code of [
      "CONNECTOR_NOT_FOUND",
      "VALIDATION_ERROR",
      "VAULT_REF_INVALID",
      "SQL_NOT_ALLOWED",
      "INTERNAL",
    ]) {
      expect(isDriverDetailCode(code)).toBe(false);
    }
  });
});

describe("sanitizeDriverError — code mapping", () => {
  const cases: Array<[string, string, string]> = [
    ["DB_AUTH_FAILED", "auth_failed", "Authentication failed"],
    ["DB_CONNECT_FAILED", "host_unreachable", "Could not reach database host"],
    ["QUERY_TIMEOUT", "timeout", "Connection test timed out"],
    ["DB_NOT_FOUND", "db_not_found", "Database not found"],
    ["TLS_ERROR", "tls_error", "TLS handshake failed"],
    ["DRIVER_UNSUPPORTED", "driver_unsupported", "Driver not supported"],
    ["DNS_LOOKUP_FAILED", "host_unreachable", "Could not reach database host"],
    ["DNS_LOOKUP_EMPTY", "host_unreachable", "Could not reach database host"],
  ];
  it.each(cases)("%s → %s", (code, errorCode, errorMessage) => {
    // The raw message is deliberately hostile: none of it may survive.
    const raw = `db host internal.corp resolves to 10.1.2.3:5432 (user=svc password=hunter2)`;
    expect(sanitizeDriverError(code, raw)).toEqual({ errorCode, errorMessage });
  });

  it("HOST_NOT_ALLOWED keeps the remediation hint but not the address", () => {
    const out = sanitizeDriverError(
      "HOST_NOT_ALLOWED",
      "db host internal.corp resolves to private/loopback address 10.1.2.3 — not on allow-list",
    );
    expect(out.errorCode).toBe("host_not_allowed");
    expect(out.errorMessage).toContain("DB_ALLOWED_HOSTS");
    expect(out.errorMessage).toContain("REPO_ALLOWED_HOSTS");
    expect(out.errorMessage).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    expect(out.errorMessage).not.toContain("internal.corp");
  });

  it("matches case-insensitively on the code", () => {
    expect(sanitizeDriverError("db_auth_failed", "x").errorCode).toBe("auth_failed");
  });
});

describe("sanitizeDriverError — raw-message fallbacks", () => {
  const cases: Array<[string, string]> = [
    ['password authentication failed for user "svc"', "auth_failed"],
    ["Access denied for user 'svc'@'10.1.2.3'", "auth_failed"],
    ["NJS-116: password verifier type is not supported", "auth_failed"],
    ["host_not_allowed: 10.1.2.3", "host_not_allowed"],
    ["db.internal is not on allow-list", "host_not_allowed"],
    ["connect ECONNREFUSED 10.1.2.3:5432", "host_unreachable"],
    ["getaddrinfo ENOTFOUND db.internal", "host_unreachable"],
    ["ORA-12541: TNS:no listener", "host_unreachable"],
    ["connect EHOSTUNREACH 10.1.2.3", "host_unreachable"],
    ["connect ETIMEDOUT 10.1.2.3:5432", "timeout"],
    ["query timeout exceeded", "timeout"],
    ['database "payments" does not exist', "db_not_found"],
    ["self signed certificate in certificate chain", "tls_error"],
    ["SSL SYSCALL error", "tls_error"],
    ["something entirely unexpected", "unknown"],
  ];
  it.each(cases)("%s → %s", (raw, errorCode) => {
    const out = sanitizeDriverError("INTERNAL", raw);
    expect(out.errorCode).toBe(errorCode);
    // Whatever the branch, the raw string never survives into the message.
    expect(out.errorMessage).not.toContain(raw);
    expect(out.errorMessage).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
  });

  it("never echoes a credential fragment", () => {
    const out = sanitizeDriverError("INTERNAL", "connection to db failed: password=hunter2");
    expect(out.errorMessage).not.toContain("hunter2");
  });
});
