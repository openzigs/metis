/**
 * Tests for the LDAP TLS-skip production guard (Issue #529, Epic #517).
 *
 * `AUTH_LDAP_TLS_SKIP_VERIFY=true` disables LDAP TLS certificate verification.
 * That is acceptable for local dev (e.g. the #525 OpenLDAP harness), but in
 * production a silent downgrade enables MITM. The guard fails fast at
 * TLS-option resolution rather than silently proceeding.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveLDAPTlsOptions,
  assertLDAPTlsConfigSafe,
  getLDAPConfig,
  clearLDAPConfig,
  type LDAPConfig,
} from "./ldap-provider.js";

const baseConfig: LDAPConfig = {
  url: "ldaps://ldap.example.com:636",
  baseDN: "dc=example,dc=com",
  bindDN: "cn=admin,dc=example,dc=com",
  bindPassword: "secret",
  userSearchBase: "ou=users,dc=example,dc=com",
  searchFilter: "(uid={{username}})",
  groupMappings: [],
  defaultRole: "reader",
  tlsSkipVerify: false,
  connectionTimeout: 10000,
};

describe("LDAP TLS-skip production guard", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    clearLDAPConfig();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    clearLDAPConfig();
  });

  describe("resolveLDAPTlsOptions", () => {
    it("production + skip-verify=true → throws (no silent TLS bypass)", () => {
      process.env.NODE_ENV = "production";
      expect(() => resolveLDAPTlsOptions({ ...baseConfig, tlsSkipVerify: true })).toThrow(
        /AUTH_LDAP_TLS_SKIP_VERIFY/,
      );
      expect(() => resolveLDAPTlsOptions({ ...baseConfig, tlsSkipVerify: true })).toThrow(
        /production/i,
      );
    });

    it("production + skip-verify=false → returns secure options (no override)", () => {
      process.env.NODE_ENV = "production";
      expect(resolveLDAPTlsOptions({ ...baseConfig, tlsSkipVerify: false })).toBeUndefined();
    });

    it("non-production (development) + skip-verify=true → allowed (dev harness)", () => {
      process.env.NODE_ENV = "development";
      const opts = resolveLDAPTlsOptions({ ...baseConfig, tlsSkipVerify: true });
      expect(opts).toBeDefined();
      expect(opts?.rejectUnauthorized).toBe(false);
    });

    it("test env + skip-verify=true → allowed", () => {
      process.env.NODE_ENV = "test";
      const opts = resolveLDAPTlsOptions({ ...baseConfig, tlsSkipVerify: true });
      expect(opts).toBeDefined();
      expect(opts?.rejectUnauthorized).toBe(false);
    });

    it("NODE_ENV unset + skip-verify=true → allowed (not production)", () => {
      delete process.env.NODE_ENV;
      const opts = resolveLDAPTlsOptions({ ...baseConfig, tlsSkipVerify: true });
      expect(opts).toBeDefined();
      expect(opts?.rejectUnauthorized).toBe(false);
    });

    it("default config (skip-verify unset → false) → secure in production", () => {
      process.env.NODE_ENV = "production";
      expect(resolveLDAPTlsOptions(baseConfig)).toBeUndefined();
    });
  });

  describe("assertLDAPTlsConfigSafe", () => {
    it("throws in production when skip-verify=true", () => {
      process.env.NODE_ENV = "production";
      expect(() => assertLDAPTlsConfigSafe({ ...baseConfig, tlsSkipVerify: true })).toThrow(
        /AUTH_LDAP_TLS_SKIP_VERIFY/,
      );
    });

    it("does not throw in production when skip-verify=false", () => {
      process.env.NODE_ENV = "production";
      expect(() => assertLDAPTlsConfigSafe({ ...baseConfig, tlsSkipVerify: false })).not.toThrow();
    });

    it("does not throw in development when skip-verify=true", () => {
      process.env.NODE_ENV = "development";
      expect(() => assertLDAPTlsConfigSafe({ ...baseConfig, tlsSkipVerify: true })).not.toThrow();
    });

    it("reads from getLDAPConfig() when no config argument is passed", () => {
      process.env.NODE_ENV = "production";
      process.env.AUTH_LDAP_TLS_SKIP_VERIFY = "true";
      clearLDAPConfig();
      try {
        expect(() => assertLDAPTlsConfigSafe()).toThrow(/AUTH_LDAP_TLS_SKIP_VERIFY/);
      } finally {
        delete process.env.AUTH_LDAP_TLS_SKIP_VERIFY;
      }
    });
  });

  describe("getLDAPConfig env parsing of tlsSkipVerify", () => {
    it("parses AUTH_LDAP_TLS_SKIP_VERIFY=true → true", () => {
      process.env.AUTH_LDAP_TLS_SKIP_VERIFY = "true";
      clearLDAPConfig();
      try {
        expect(getLDAPConfig().tlsSkipVerify).toBe(true);
      } finally {
        delete process.env.AUTH_LDAP_TLS_SKIP_VERIFY;
      }
    });

    it("unset AUTH_LDAP_TLS_SKIP_VERIFY → false (secure default)", () => {
      delete process.env.AUTH_LDAP_TLS_SKIP_VERIFY;
      clearLDAPConfig();
      expect(getLDAPConfig().tlsSkipVerify).toBe(false);
    });
  });
});
