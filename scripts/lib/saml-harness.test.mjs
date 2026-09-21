import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  idpMetadataUrl,
  idpSsoUrl,
  spAcsUrl,
  spEntityId,
  buildSamlProviderBody,
  trimSlash,
} from "./saml-harness.mjs";

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

  it("derives the METIS SP ACS URL (matches server/src/routes/sso.ts)", () => {
    expect(spAcsUrl("http://localhost:4000")).toBe("http://localhost:4000/auth/saml/acs");
  });

  it("derives the METIS SP entity id / metadata URL", () => {
    expect(spEntityId("http://localhost:4000")).toBe("http://localhost:4000/auth/saml/metadata");
  });
});

describe("buildSamlProviderBody", () => {
  const META = "<EntityDescriptor>...</EntityDescriptor>";

  it("builds a body with #520 secure defaults", () => {
    const body = buildSamlProviderBody({ idpMetadataXml: META });
    expect(body).toMatchObject({
      name: DEFAULTS.providerName,
      enabled: true,
      entityId: "http://localhost:4000/auth/saml/metadata",
      acsUrl: "http://localhost:4000/auth/saml/acs",
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
    expect(body.acsUrl).toBe("https://metis.test:9000/auth/saml/acs");
    expect(body.entityId).toBe("https://metis.test:9000/auth/saml/metadata");
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
