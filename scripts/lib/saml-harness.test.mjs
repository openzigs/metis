import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  idpMetadataUrl,
  idpSsoUrl,
  spAcsUrl,
  spEntityId,
  spLoginUrl,
  buildSamlProviderBody,
  trimSlash,
} from "./saml-harness.mjs";
import { spEndpoints } from "./entra-idp-harness.mjs";

describe("trimSlash", () => {
  it("removes a single trailing slash", () => {
    expect(trimSlash("http://localhost:4000/")).toBe("http://localhost:4000");
  });

  it("removes multiple trailing slashes", () => {
    expect(trimSlash("http://localhost:4000///")).toBe("http://localhost:4000");
  });

  it("leaves a URL without a trailing slash unchanged", () => {
    expect(trimSlash("http://localhost:4000")).toBe("http://localhost:4000");
  });

  it("throws on a non-string", () => {
    expect(() => trimSlash(undefined)).toThrow(TypeError);
  });
});

describe("URL builders", () => {
  it("derives the mock IdP metadata URL", () => {
    expect(idpMetadataUrl("http://localhost:4500")).toBe("http://localhost:4500/api/saml/metadata");
  });

  it("derives the mock IdP SSO URL and tolerates a trailing slash", () => {
    expect(idpSsoUrl("http://localhost:4500/")).toBe("http://localhost:4500/api/saml/sso");
  });

  it("derives the METIS SP ACS URL under the /api mount (server/src/app.ts, routes/sso.ts)", () => {
    expect(spAcsUrl("http://localhost:4000")).toBe("http://localhost:4000/api/auth/saml/acs");
  });

  it("derives the METIS SP entity id / metadata URL", () => {
    expect(spEntityId("http://localhost:4000")).toBe(
      "http://localhost:4000/api/auth/saml/metadata",
    );
  });

  it("derives the METIS SAML login URL the seed prints", () => {
    expect(spLoginUrl("http://localhost:4000/")).toBe("http://localhost:4000/api/auth/saml/login");
  });

  // #1562 — the generic harness named /auth/saml/... while the API serves
  // /api/auth/saml/...; the Entra harness's endpoints are proven against the
  // real routes (server/tests/saml-entra-local-harness-1559.sqlite.test.ts).
  it("names the same SP endpoints as the Entra harness, and DEFAULTS agrees", () => {
    const api = "http://localhost:4000";
    expect({ entityId: spEntityId(api), acsUrl: spAcsUrl(api), loginUrl: spLoginUrl(api) }).toEqual(
      spEndpoints(api),
    );
    expect(DEFAULTS.spEntityId).toBe(spEntityId(DEFAULTS.metisApiUrl));
  });
});

describe("buildSamlProviderBody", () => {
  const META = "<EntityDescriptor>...</EntityDescriptor>";

  it("builds a body with #520 secure defaults", () => {
    const body = buildSamlProviderBody({ idpMetadataXml: META });
    expect(body).toMatchObject({
      name: DEFAULTS.providerName,
      enabled: true,
      entityId: "http://localhost:4000/api/auth/saml/metadata",
      acsUrl: "http://localhost:4000/api/auth/saml/acs",
      idpMetadataXml: META,
      signRequests: false,
      requireSignedResponse: true,
      defaultRole: DEFAULTS.defaultRole,
      groupMappings: [],
    });
  });

  it("honours a custom metisApiUrl, name, defaultRole and enabled flag", () => {
    const body = buildSamlProviderBody({
      idpMetadataXml: META,
      metisApiUrl: "https://metis.test:9000/",
      name: "Corp IdP",
      defaultRole: "reader",
      enabled: false,
    });
    expect(body.acsUrl).toBe("https://metis.test:9000/api/auth/saml/acs");
    expect(body.entityId).toBe("https://metis.test:9000/api/auth/saml/metadata");
    expect(body.name).toBe("Corp IdP");
    expect(body.defaultRole).toBe("reader");
    expect(body.enabled).toBe(false);
  });

  it("allows opting out of response signing for an IdP that cannot sign the envelope", () => {
    const body = buildSamlProviderBody({ idpMetadataXml: META, requireSignedResponse: false });
    expect(body.requireSignedResponse).toBe(false);
  });

  it("throws when metadata is missing", () => {
    expect(() => buildSamlProviderBody({})).toThrow(/idpMetadataXml is required/);
  });

  it("throws when metadata is blank", () => {
    expect(() => buildSamlProviderBody({ idpMetadataXml: "   " })).toThrow(/idpMetadataXml/);
  });

  it("throws when input is null", () => {
    expect(() => buildSamlProviderBody(null)).toThrow(/idpMetadataXml/);
  });
});
