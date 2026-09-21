/**
 * Tests for SAML 2.0 provider.
 * Epic #748, Issue #749.
 */
import { describe, expect, it } from "vitest";
import { parseIdPMetadata, generateSPMetadata } from "../src/lib/auth/saml-provider.js";
import type { SAMLConfig } from "../src/lib/auth/sso-types.js";

const SAMPLE_IDP_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://idp.example.com/saml">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>MIICpDCCAYwCCQDU+pQ4pHgSpDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="https://idp.example.com/sso/saml"/>
    <md:SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://idp.example.com/sso/saml/post"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe("SAML Provider", () => {
  describe("parseIdPMetadata", () => {
    it("extracts entityID as issuer", () => {
      const result = parseIdPMetadata(SAMPLE_IDP_METADATA);
      expect(result.issuer).toBe("https://idp.example.com/saml");
    });

    it("extracts HTTP-Redirect SSO URL preferentially", () => {
      const result = parseIdPMetadata(SAMPLE_IDP_METADATA);
      expect(result.ssoUrl).toBe("https://idp.example.com/sso/saml");
    });

    it("extracts X509 certificates", () => {
      const result = parseIdPMetadata(SAMPLE_IDP_METADATA);
      expect(result.certs).toHaveLength(1);
      expect(result.certs[0]).toContain("MIICpDCCAYwCCQDU");
    });

    it("handles metadata with no certificates gracefully", () => {
      const noCert = `<md:EntityDescriptor entityID="https://x.com">
        <md:IDPSSODescriptor>
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://x.com/sso"/>
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>`;
      const result = parseIdPMetadata(noCert);
      expect(result.certs).toHaveLength(0);
      expect(result.ssoUrl).toBe("https://x.com/sso");
    });

    it("handles empty/malformed XML gracefully", () => {
      const result = parseIdPMetadata("");
      expect(result.issuer).toBe("");
      expect(result.ssoUrl).toBe("");
      expect(result.certs).toHaveLength(0);
    });

    it("falls back to POST binding if no Redirect binding", () => {
      const postOnly = `<md:EntityDescriptor entityID="https://y.com">
        <md:IDPSSODescriptor>
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://y.com/post"/>
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>`;
      const result = parseIdPMetadata(postOnly);
      expect(result.ssoUrl).toBe("https://y.com/post");
    });
  });

  describe("generateSPMetadata", () => {
    const config: SAMLConfig = {
      entityId: "https://metis.example.com/sp",
      acsUrl: "https://metis.example.com/auth/saml/acs",
      idpMetadataXml: "",
      idpSsoUrl: "https://idp.example.com/sso",
      idpCerts: [],
      idpIssuer: "https://idp.example.com",
      signRequests: false,
    };

    it("generates valid XML with entity ID", () => {
      const xml = generateSPMetadata(config);
      expect(xml).toContain('entityID="https://metis.example.com/sp"');
    });

    it("includes ACS URL", () => {
      const xml = generateSPMetadata(config);
      expect(xml).toContain('Location="https://metis.example.com/auth/saml/acs"');
    });

    it("sets AuthnRequestsSigned based on config", () => {
      const xml = generateSPMetadata(config);
      expect(xml).toContain('AuthnRequestsSigned="false"');

      const signedConfig = { ...config, signRequests: true };
      const signedXml = generateSPMetadata(signedConfig);
      expect(signedXml).toContain('AuthnRequestsSigned="true"');
    });

    it("includes signing certificate when provided", () => {
      const withCert = {
        ...config,
        spCert: "-----BEGIN CERTIFICATE-----\nMIIBxTCCAW\n-----END CERTIFICATE-----",
      };
      const xml = generateSPMetadata(withCert);
      expect(xml).toContain("X509Certificate");
      expect(xml).toContain("MIIBxTCCAW");
    });

    it("escapes XML special characters in entityId", () => {
      const special = { ...config, entityId: "https://test.com/sp&app" };
      const xml = generateSPMetadata(special);
      expect(xml).toContain("&amp;app");
      expect(xml).not.toContain("&app");
    });

    it("includes NameIDFormat", () => {
      const xml = generateSPMetadata(config);
      expect(xml).toContain("nameid-format:emailAddress");
    });
  });
});
