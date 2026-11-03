/**
 * Tests for OIDC provider.
 * Epic #748, Issue #750.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  MAX_AUTH_AGE_SECONDS,
  __clearDiscoveryCache,
  amrProvesMfa,
} from "../src/lib/auth/oidc-provider.js";

describe("OIDC Provider", () => {
  beforeEach(() => {
    __clearDiscoveryCache();
  });

  describe("MAX_AUTH_AGE_SECONDS", () => {
    it("replay attack window is ≤30 seconds", () => {
      expect(MAX_AUTH_AGE_SECONDS).toBeLessThanOrEqual(30);
    });
  });

  describe("discovery cache", () => {
    it("__clearDiscoveryCache clears cached configs", () => {
      // Just verifying the function exists and doesn't throw
      expect(() => __clearDiscoveryCache()).not.toThrow();
    });
  });

  // Note: Full OIDC flow tests require a mock IdP server. The key behaviors
  // (PKCE, token rotation, amr claim inspection) are tested via the SSO routes
  // integration tests which mock the openid-client library.
});

// #1564 — a lone second-factor-looking `amr` value is one factor, not MFA.
describe("amrProvesMfa", () => {
  it.each([
    [["mfa"]],
    [["pwd", "mfa"]],
    [["rsa", "ngcmfa"]],
    [["pwd", "otp"]],
    [["pwd", "sms"]],
    [["hwk", "pin"]],
    [["hwk", "fpt"]],
    [["swk", "face"]],
  ])("%j is MFA", (amr) => {
    expect(amrProvesMfa(amr)).toBe(true);
  });

  it.each([
    [undefined],
    ["mfa"],
    [[]],
    [["pwd"]],
    [["otp"]],
    [["sms"]],
    [["hwk"]],
    [["swk"]],
    [["fpt"]],
    [["otp", "sms"]],
    [["pwd", "pin"]],
    [["pwd", "x509"]],
  ])("%j is not MFA", (amr) => {
    expect(amrProvesMfa(amr)).toBe(false);
  });
});
