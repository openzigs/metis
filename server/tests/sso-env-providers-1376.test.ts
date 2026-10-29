/**
 * #1376 — OIDC / SAML providers from the environment, so an SSO-only install can
 * sign anyone in (and so bootstrap its first admin) without the admin API.
 */
import { afterEach, describe, expect, it } from "vitest";
import { parseGroupMappings, seedSsoProvidersFromEnv } from "../src/lib/auth/sso-env-providers.js";
import { __resetProviders, getProviderByMode } from "../src/lib/auth/sso-config.js";

afterEach(() => __resetProviders());

const OIDC = {
  AUTH_OIDC_DISCOVERY_URL: "https://idp.example.test/.well-known/openid-configuration",
  AUTH_OIDC_CLIENT_ID: "metis",
  AUTH_OIDC_CLIENT_SECRET: "s3cret",
  AUTH_OIDC_REDIRECT_URI: "https://metis.example.test/api/auth/oidc/callback",
};

const METADATA = `<EntityDescriptor entityID="https://idp.example.test/saml"><IDPSSODescriptor><KeyDescriptor><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>MIIBcert</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.test/sso"/></IDPSSODescriptor></EntityDescriptor>`;
const SAML = {
  AUTH_SAML_ENTITY_ID: "https://metis.example.test/api/auth/saml/metadata",
  AUTH_SAML_ACS_URL: "https://metis.example.test/api/auth/saml/acs",
  AUTH_SAML_IDP_METADATA_XML: METADATA,
};

describe("seedSsoProvidersFromEnv", () => {
  it("does nothing when no AUTH_OIDC_* / AUTH_SAML_* is set", () => {
    expect(seedSsoProvidersFromEnv({})).toEqual([]);
    expect(getProviderByMode("oidc")).toBeUndefined();
  });

  it("seeds an enabled OIDC provider with PKCE and the default scopes", () => {
    expect(seedSsoProvidersFromEnv(OIDC)).toEqual(["oidc"]);
    expect(getProviderByMode("oidc")).toMatchObject({
      enabled: true,
      defaultRole: "reader",
      groupMappings: [],
      oidc: {
        clientId: "metis",
        clientSecret: "s3cret",
        scopes: ["openid", "profile", "email"],
        pkceEnabled: true,
      },
    });
  });

  it("reads optional name, scopes, group mappings and default role", () => {
    seedSsoProvidersFromEnv({
      ...OIDC,
      AUTH_OIDC_NAME: "Okta",
      AUTH_OIDC_SCOPES: "openid email groups",
      AUTH_OIDC_GROUP_MAPPINGS: "metis-admins=admin, eng=developer",
      AUTH_OIDC_DEFAULT_ROLE: "developer",
    });
    expect(getProviderByMode("oidc")).toMatchObject({
      name: "Okta",
      defaultRole: "developer",
      groupMappings: [
        { claimValue: "metis-admins", role: "admin" },
        { claimValue: "eng", role: "developer" },
      ],
      oidc: { scopes: ["openid", "email", "groups"] },
    });
  });

  it("fails the boot on a half-configured provider, naming what is missing", () => {
    const { AUTH_OIDC_CLIENT_SECRET: _omit, ...partial } = OIDC;
    expect(() => seedSsoProvidersFromEnv(partial)).toThrow(/AUTH_OIDC_CLIENT_SECRET/);
    expect(() => seedSsoProvidersFromEnv({ AUTH_SAML_ACS_URL: "x" })).toThrow(/half-configured/);
  });

  it("fails on an unknown default role or a malformed discovery URL", () => {
    expect(() => seedSsoProvidersFromEnv({ ...OIDC, AUTH_OIDC_DEFAULT_ROLE: "root" })).toThrow(
      /not a METIS role/,
    );
    expect(() =>
      seedSsoProvidersFromEnv({ ...OIDC, AUTH_OIDC_DISCOVERY_URL: "not a url" }),
    ).toThrow();
  });

  it("seeds SAML from IdP metadata, requiring a signed Response unless told otherwise", () => {
    expect(seedSsoProvidersFromEnv(SAML)).toEqual(["saml"]);
    expect(getProviderByMode("saml")?.saml).toMatchObject({
      idpSsoUrl: "https://idp.example.test/sso",
      idpCerts: ["MIIBcert"],
      idpIssuer: "https://idp.example.test/saml",
      requireSignedResponse: true,
    });
    seedSsoProvidersFromEnv({ ...SAML, AUTH_SAML_REQUIRE_SIGNED_RESPONSE: "false" });
    expect(getProviderByMode("saml")?.saml?.requireSignedResponse).toBe(false);
  });

  it("refuses SAML metadata with no SSO URL or certificate", () => {
    expect(() =>
      seedSsoProvidersFromEnv({ ...SAML, AUTH_SAML_IDP_METADATA_XML: "<EntityDescriptor/>" }),
    ).toThrow(/SingleSignOnService/);
  });

  it("seeds both when both are configured", () => {
    expect(seedSsoProvidersFromEnv({ ...OIDC, ...SAML })).toEqual(["oidc", "saml"]);
  });
});

describe("parseGroupMappings", () => {
  it("parses group=role pairs and keeps an '=' inside the group name", () => {
    expect(parseGroupMappings("role=metis-admin=admin, eng=developer")).toEqual([
      { claimValue: "role=metis-admin", role: "admin" },
      { claimValue: "eng", role: "developer" },
    ]);
    expect(parseGroupMappings("")).toEqual([]);
  });

  it("refuses a pair without a METIS role, and mappings with no admin", () => {
    expect(() => parseGroupMappings("admins")).toThrow(/group=role/);
    expect(() => parseGroupMappings("admins=superuser")).toThrow(/group=role/);
    expect(() => parseGroupMappings("eng=developer")).toThrow(/admin/);
  });
});
