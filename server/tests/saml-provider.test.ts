/**
 * Tests for SAML 2.0 provider.
 * Epic #748, Issue #749.
 */
import { describe, expect, it } from "vitest";
import {
  parseIdPMetadata,
  generateSPMetadata,
  SAML_METADATA_MAX_CHARS,
} from "../src/lib/auth/saml-provider.js";
import { AppError } from "../src/middleware/error-handler.js";
import type { SAMLConfig } from "../src/lib/auth/sso-types.js";

const MD_NS = "urn:oasis:names:tc:SAML:2.0:metadata";

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
      const noCert = `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="https://x.com">
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
      const postOnly = `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="https://y.com">
        <md:IDPSSODescriptor>
          <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://y.com/post"/>
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>`;
      const result = parseIdPMetadata(postOnly);
      expect(result.ssoUrl).toBe("https://y.com/post");
    });

    // #1540 — parsed as XML, not with polynomial regexes.
    it("reads Location before Binding, unprefixed elements and several certs", () => {
      const xml = `<EntityDescriptor xmlns="${MD_NS}" entityID="https://z.com">
        <IDPSSODescriptor>
          <KeyDescriptor><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data>
            <X509Certificate>
              AAAA
              BBBB
            </X509Certificate>
          </X509Data></KeyInfo></KeyDescriptor>
          <KeyDescriptor><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data>
            <X509Certificate>CCCC</X509Certificate>
          </X509Data></KeyInfo></KeyDescriptor>
          <SingleSignOnService Location="https://z.com/post" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"/>
          <SingleSignOnService Location="https://z.com/redirect" Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"/>
        </IDPSSODescriptor>
      </EntityDescriptor>`;
      expect(parseIdPMetadata(xml)).toEqual({
        issuer: "https://z.com",
        ssoUrl: "https://z.com/redirect",
        certs: ["AAAABBBB", "CCCC"],
      });
    });

    it("ignores a SingleSignOnService with an unknown binding", () => {
      const xml = `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="https://u.com">
        <md:IDPSSODescriptor>
          <md:SingleSignOnService Binding="urn:example:artifact" Location="https://u.com/a"/>
        </md:IDPSSODescriptor>
      </md:EntityDescriptor>`;
      expect(parseIdPMetadata(xml).ssoUrl).toBe("");
    });

    it("returns empty values for XML that is not well formed", () => {
      expect(parseIdPMetadata("<md:EntityDescriptor entityID='x'><oops>")).toEqual({
        issuer: "",
        ssoUrl: "",
        certs: [],
      });
    });

    it("does not expand a DTD-declared entity into the parsed values", () => {
      const xml = `<!DOCTYPE md:EntityDescriptor [<!ENTITY e "https://evil.example">]>
        <md:EntityDescriptor xmlns:md="${MD_NS}" entityID="&e;"/>`;
      expect(parseIdPMetadata(xml).issuer).not.toContain("evil");
    });

    it("rejects metadata over the size cap with a 400", () => {
      const xml = `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="https://x.com">${" ".repeat(
        SAML_METADATA_MAX_CHARS,
      )}</md:EntityDescriptor>`;
      let caught: unknown;
      try {
        parseIdPMetadata(xml);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).statusCode).toBe(400);
    });

    it("parses adversarial metadata just under the cap in under 250 ms", () => {
      // 380 KB took 2.7 s under the old `SingleSignOnService[^>]+…` regexes.
      const open = `<md:EntityDescriptor xmlns:md="${MD_NS}" entityID="https://x.com"><md:SingleSignOnService a="`;
      const filler = "SingleSignOnService ".repeat(
        Math.floor((SAML_METADATA_MAX_CHARS - open.length - 64) / 20),
      );
      const xml = `${open}${filler}"/></md:EntityDescriptor>`;
      expect(xml.length).toBeLessThanOrEqual(SAML_METADATA_MAX_CHARS);
      const started = performance.now();
      parseIdPMetadata(xml);
      expect(performance.now() - started).toBeLessThan(250);
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
