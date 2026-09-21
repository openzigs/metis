/**
 * Tests for OIDC provider.
 * Epic #748, Issue #750.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { MAX_AUTH_AGE_SECONDS, __clearDiscoveryCache } from "../src/lib/auth/oidc-provider.js";

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
