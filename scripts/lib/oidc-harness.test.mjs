import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  DEFAULT_GROUP_MAPPINGS,
  DEFAULT_SCOPES,
  discoveryUrl,
  oidcCallbackUrl,
  buildOidcProviderBody,
  trimSlash,
} from "./oidc-harness.mjs";

describe("trimSlash", () => {
  it("removes a single trailing slash", () => {
    expect(trimSlash("http://localhost:4600/")).toBe("http://localhost:4600");
  });

  it("removes multiple trailing slashes", () => {
    expect(trimSlash("http://localhost:4600///")).toBe("http://localhost:4600");
  });

  it("leaves a URL without a trailing slash unchanged", () => {
    expect(trimSlash("http://localhost:4600")).toBe("http://localhost:4600");
  });

  it("throws on a non-string", () => {
    expect(() => trimSlash(undefined)).toThrow(TypeError);
  });
});

describe("discoveryUrl", () => {
  it("derives the Keycloak well-known discovery URL for a realm", () => {
    expect(discoveryUrl("http://localhost:4600", "metis")).toBe(
      "http://localhost:4600/realms/metis/.well-known/openid-configuration",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(discoveryUrl("http://localhost:4600/", "metis")).toBe(
      "http://localhost:4600/realms/metis/.well-known/openid-configuration",
    );
  });

  it("throws when realm is missing", () => {
    expect(() => discoveryUrl("http://localhost:4600", "")).toThrow(/realm is required/);
    expect(() => discoveryUrl("http://localhost:4600", undefined)).toThrow(/realm is required/);
  });
});

describe("oidcCallbackUrl", () => {
  it("derives the METIS callback URL (matches /api + /auth + /oidc/callback mounts)", () => {
    expect(oidcCallbackUrl("http://localhost:4000")).toBe(
      "http://localhost:4000/api/auth/oidc/callback",
    );
  });

  it("tolerates a trailing slash", () => {
    expect(oidcCallbackUrl("http://localhost:4000/")).toBe(
      "http://localhost:4000/api/auth/oidc/callback",
    );
  });
});

describe("buildOidcProviderBody", () => {
  it("builds a body with sensible local defaults", () => {
    const body = buildOidcProviderBody();
    expect(body).toMatchObject({
      name: DEFAULTS.providerName,
      enabled: true,
      discoveryUrl: "http://localhost:4600/realms/metis/.well-known/openid-configuration",
      clientId: DEFAULTS.clientId,
      clientSecret: DEFAULTS.clientSecret,
      redirectUri: "http://localhost:4000/api/auth/oidc/callback",
      scopes: [...DEFAULT_SCOPES],
      defaultRole: DEFAULTS.defaultRole,
    });
    // Default mappings line up with the Keycloak group NAMES (Full path OFF).
    expect(body.groupMappings).toEqual([
      { claimValue: "metis-admins", role: "admin" },
      { claimValue: "metis-developers", role: "developer" },
    ]);
  });

  it("works with no argument (defaults to {})", () => {
    expect(() => buildOidcProviderBody()).not.toThrow();
    expect(buildOidcProviderBody().clientId).toBe(DEFAULTS.clientId);
  });

  it("honours custom idpBaseUrl, realm, metisApiUrl, name, clientId and enabled", () => {
    const body = buildOidcProviderBody({
      idpBaseUrl: "https://kc.test:8443/",
      realm: "corp",
      metisApiUrl: "https://metis.test:9000/",
      name: "Corp IdP",
      clientId: "corp-metis",
      enabled: false,
    });
    expect(body.discoveryUrl).toBe(
      "https://kc.test:8443/realms/corp/.well-known/openid-configuration",
    );
    expect(body.redirectUri).toBe("https://metis.test:9000/api/auth/oidc/callback");
    expect(body.name).toBe("Corp IdP");
    expect(body.clientId).toBe("corp-metis");
    expect(body.enabled).toBe(false);
  });

  it("honours a custom client secret, scopes and default role", () => {
    const body = buildOidcProviderBody({
      clientSecret: "another-secret",
      scopes: ["openid", "profile", "email", "offline_access"],
      defaultRole: "developer",
    });
    expect(body.clientSecret).toBe("another-secret");
    expect(body.scopes).toContain("offline_access");
    expect(body.defaultRole).toBe("developer");
  });

  it("honours custom group mappings (as long as one is admin)", () => {
    const mappings = [
      { claimValue: "ops", role: "admin" },
      { claimValue: "readers", role: "reader" },
    ];
    const body = buildOidcProviderBody({ groupMappings: mappings });
    expect(body.groupMappings).toEqual(mappings);
  });

  it("throws when an explicit client secret is blank", () => {
    expect(() => buildOidcProviderBody({ clientSecret: "" })).toThrow(/clientSecret is required/);
    expect(() => buildOidcProviderBody({ clientSecret: "   " })).toThrow(/clientSecret/);
  });

  it("falls back to the default secret when clientSecret is null/undefined", () => {
    // `null`/`undefined` are NOT an explicit blank — they mean "use the default".
    expect(buildOidcProviderBody({ clientSecret: null }).clientSecret).toBe(DEFAULTS.clientSecret);
    expect(buildOidcProviderBody({ clientSecret: undefined }).clientSecret).toBe(
      DEFAULTS.clientSecret,
    );
  });

  it("throws when no group mapping resolves to admin (mirrors server guard)", () => {
    expect(() =>
      buildOidcProviderBody({ groupMappings: [{ claimValue: "readers", role: "reader" }] }),
    ).toThrow(/at least one mapping with role 'admin'/);
  });

  it("exposes frozen defaults that callers cannot mutate", () => {
    expect(Object.isFrozen(DEFAULT_GROUP_MAPPINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    // The default mappings returned in the body are CLONES, not the frozen source.
    const body = buildOidcProviderBody();
    body.groupMappings[0].role = "reader";
    expect(DEFAULT_GROUP_MAPPINGS[0].role).toBe("admin");
  });
});
