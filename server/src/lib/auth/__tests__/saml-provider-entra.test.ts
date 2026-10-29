/**
 * #1552 — Microsoft Entra ID SAML compatibility, against the REAL node-saml
 * validator with REAL signed Responses in Entra's shape
 * (`entra-saml-fixtures.ts` cites the Microsoft Learn page behind each shape).
 *
 *   1. group and app-role claims are read from Entra's claim URIs;
 *   2. the groups overage claim is flagged and logged, not silently ignored;
 *   3. a password-only sign-in is not MFA; `multipleauthn` (or an MFA class
 *      ref) is;
 *   4. Entra's default "Sign SAML assertion" is refused with a message naming
 *      the setting to choose;
 *   5. Entra's Federation Metadata XML parses to the right SSO URL, issuer and
 *      token-signing certificate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ warn: [] as Array<[string, unknown]> }));
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({
    warn: (msg: string, meta: unknown) => logged.warn.push([msg, meta]),
    error: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  }),
}));

import {
  __resetSAMLInstances,
  ENTRA_GROUPS_OVERAGE_CLAIM,
  parseIdPMetadata,
  UNSIGNED_RESPONSE_MESSAGE,
  validateSAMLResponse,
} from "../saml-provider.js";
import { __resetSamlRequestIdCache } from "../saml-request-id-cache.js";
import type { SAMLConfig } from "../sso-types.js";
import {
  buildEntraFederationMetadata,
  ENTRA_CLASS_REF,
  ENTRA_CLAIM,
  ENTRA_GROUP,
  ENTRA_ISSUER,
  ENTRA_SSO_URL,
  entraAttributes,
  type EntraUser,
} from "./entra-saml-fixtures.js";
import {
  buildSamlResponseXml,
  getTestSigningKey,
  signAssertion,
  signResponse,
  toBase64,
} from "./saml-test-helpers.js";

const key = getTestSigningKey();
const ENTITY_ID = "https://metis.example.com/api/auth/saml/metadata";
const ACS_URL = "https://metis.example.com/api/auth/saml/acs";

const config: SAMLConfig = {
  entityId: ENTITY_ID,
  acsUrl: ACS_URL,
  idpMetadataXml: "",
  idpSsoUrl: ENTRA_SSO_URL,
  idpCerts: [key.certificateBody],
  idpIssuer: ENTRA_ISSUER,
  signRequests: false,
};

const alice: EntraUser = {
  upn: "alice@contoso.example",
  objectId: "a11ce000-1552-4000-8000-000000000001",
  displayName: "Alice Admin",
  groups: [ENTRA_GROUP.unrelated, ENTRA_GROUP.metisAdmins],
};

/** An Entra Response for `user`, signed both ways unless `signing` says otherwise. */
function entraResponse(
  user: EntraUser,
  opts: { classRef?: string; signing?: "assertion" | "both"; extra?: Record<string, string> } = {},
): string {
  const xml = buildSamlResponseXml({
    audience: ENTITY_ID,
    recipient: ACS_URL,
    issuer: ENTRA_ISSUER,
    nameId: user.upn,
    authnContextClassRef: opts.classRef ?? ENTRA_CLASS_REF.password,
    attributes: { ...entraAttributes(user), ...opts.extra },
  });
  const assertionSigned = signAssertion(xml, key);
  return toBase64(
    opts.signing === "assertion" ? assertionSigned : signResponse(assertionSigned, key),
  );
}

beforeEach(() => {
  __resetSAMLInstances();
  __resetSamlRequestIdCache();
  logged.warn.length = 0;
});
afterEach(() => {
  __resetSAMLInstances();
  __resetSamlRequestIdCache();
});

describe("#1552 Entra group and app-role claims", () => {
  it("reads every group object id from Entra's groups claim URI", async () => {
    const result = await validateSAMLResponse(entraResponse(alice), config);

    expect(result.success).toBe(true);
    expect(result.user?.groups).toEqual([ENTRA_GROUP.unrelated, ENTRA_GROUP.metisAdmins]);
    expect(result.user?.email).toBe("alice@contoso.example");
    expect(result.user?.groupOverage).toBeUndefined();
  });

  it("pools app roles from Entra's role claim with the groups", async () => {
    const result = await validateSAMLResponse(
      entraResponse({ ...alice, groups: [ENTRA_GROUP.metisMembers], roles: ["METIS.Admin"] }),
      config,
    );

    expect(result.user?.groups).toEqual([ENTRA_GROUP.metisMembers, "METIS.Admin"]);
  });

  it("still reads the ADFS Group claim, once per value", async () => {
    const result = await validateSAMLResponse(
      entraResponse(
        { ...alice, groups: ["engineering"] },
        { extra: { "http://schemas.xmlsoap.org/claims/Group": "engineering" } },
      ),
      config,
    );

    expect(result.user?.groups).toEqual(["engineering"]);
  });
});

describe("#1552 Entra group overage", () => {
  it("flags and logs a groups.link overage claim", async () => {
    const result = await validateSAMLResponse(
      entraResponse({ ...alice, groupOverage: true }),
      config,
    );

    expect(result.success).toBe(true);
    expect(result.user?.groups).toEqual([]);
    expect(result.user?.groupOverage).toBe(true);
    expect(result.user?.rawClaims[ENTRA_GROUPS_OVERAGE_CLAIM]).toMatch(/getMemberObjects$/);
    expect(logged.warn).toHaveLength(1);
    expect(logged.warn[0][0]).toMatch(/group overage.*Groups assigned to the application/i);
    expect(logged.warn[0][1]).toEqual({ username: "alice" });
  });
});

describe("#1552 MFA detection", () => {
  it("a password-only Entra sign-in is not MFA", async () => {
    const result = await validateSAMLResponse(entraResponse({ ...alice, mfa: false }), config);
    expect(result.user?.mfaPassed).toBe(false);
  });

  it("authnmethodsreferences containing multipleauthn is MFA", async () => {
    const result = await validateSAMLResponse(entraResponse({ ...alice, mfa: true }), config);
    expect(result.user?.mfaPassed).toBe(true);
  });

  it("Entra's MobileTwoFactorContract class ref is MFA without the amr claim", async () => {
    const xml = buildSamlResponseXml({
      audience: ENTITY_ID,
      recipient: ACS_URL,
      issuer: ENTRA_ISSUER,
      nameId: alice.upn,
      authnContextClassRef: ENTRA_CLASS_REF.mobileTwoFactorContract,
    });
    const result = await validateSAMLResponse(
      toBase64(signResponse(signAssertion(xml, key), key)),
      config,
    );
    expect(result.user?.mfaPassed).toBe(true);
  });

  it.each([
    [
      "PasswordProtectedTransport (password over TLS)",
      "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
    ],
    ["X509 (single-factor certificate)", ENTRA_CLASS_REF.x509],
  ])("the class ref %s is not MFA", async (_label, classRef) => {
    const result = await validateSAMLResponse(entraResponse(alice, { classRef }), config);
    expect(result.user?.mfaPassed).toBe(false);
  });

  it("an ADFS authnclassreference claim of PasswordProtectedTransport is not MFA", async () => {
    const result = await validateSAMLResponse(
      entraResponse(alice, {
        extra: {
          "http://schemas.microsoft.com/claims/authnclassreference":
            "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
        },
      }),
      config,
    );
    expect(result.user?.mfaPassed).toBe(false);
  });

  it("an ADFS authnclassreference claim of multipleauthn is MFA", async () => {
    const result = await validateSAMLResponse(
      entraResponse(alice, {
        extra: {
          "http://schemas.microsoft.com/claims/authnclassreference":
            "http://schemas.microsoft.com/claims/multipleauthn",
        },
      }),
      config,
    );
    expect(result.user?.mfaPassed).toBe(true);
  });

  it("a claim value merely containing 'mfa' is not MFA", async () => {
    const result = await validateSAMLResponse(
      entraResponse(alice, {
        extra: { "http://schemas.microsoft.com/claims/authnclassreference": "urn:example:nomfa" },
      }),
      config,
    );
    expect(result.user?.mfaPassed).toBe(false);
  });
});

describe("#1552 Entra's default signing option", () => {
  it("refuses an assertion-only Response with a message naming the Entra setting", async () => {
    const result = await validateSAMLResponse(
      entraResponse(alice, { signing: "assertion" }),
      config,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe(UNSIGNED_RESPONSE_MESSAGE);
    expect(result.error).toContain('"Sign SAML response and assertion"');
  });

  it("leaves other validation errors as node-saml worded them", async () => {
    const result = await validateSAMLResponse(entraResponse(alice), {
      ...config,
      entityId: "https://another-sp.example.com/metadata",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/audience/i);
  });
});

describe("#1552 Entra Federation Metadata XML", () => {
  const metadata = buildEntraFederationMetadata(key);

  it("is Entra-shaped: signed, RoleDescriptors before the IDPSSODescriptor", () => {
    expect(metadata).toMatch(/^<\?xml[^>]*\?><EntityDescriptor[^>]*><ds:Signature /);
    expect(metadata.indexOf('xsi:type="fed:SecurityTokenServiceType"')).toBeLessThan(
      metadata.indexOf('xsi:type="fed:ApplicationServiceType"'),
    );
    expect(metadata.indexOf("fed:ApplicationServiceType")).toBeLessThan(
      metadata.indexOf("<IDPSSODescriptor"),
    );
  });

  it.each([
    ["as downloaded", ""],
    ["after a BOM and whitespace", "﻿\r\n  "],
  ])("parses SSO URL, issuer and the one signing certificate %s", (_label, prefix) => {
    expect(parseIdPMetadata(`${prefix}${metadata}`)).toEqual({
      issuer: ENTRA_ISSUER,
      ssoUrl: ENTRA_SSO_URL,
      certs: [key.certificateBody],
    });
  });

  it("does not trust the metadata signature's own certificate for tokens", () => {
    const parsed = parseIdPMetadata(buildEntraFederationMetadata(key, "TUVUQURBVEFTSUdORVI="));
    expect(parsed.certs).toEqual([key.certificateBody]);
  });

  it("reads token-signing certificates from the IDPSSODescriptor, not the WS-Federation RoleDescriptors", () => {
    const xml = metadata.replace(
      'protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706"><KeyDescriptor use="signing">',
      'protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706"><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>V1NGRURPTkxZ</X509Certificate></X509Data></KeyInfo></KeyDescriptor><KeyDescriptor use="signing">',
    );
    expect(xml).toContain("V1NGRURPTkxZ");
    expect(parseIdPMetadata(xml).certs).toEqual([key.certificateBody]);
  });

  it("skips an encryption-only KeyDescriptor", () => {
    const xml = metadata.replace(
      '<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
      '<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><KeyDescriptor use="encryption"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>RU5DUllQVA==</X509Certificate></X509Data></KeyInfo></KeyDescriptor>',
    );
    expect(parseIdPMetadata(xml).certs).toEqual([key.certificateBody]);
  });

  it("the parsed certificate validates an Entra Response", async () => {
    const parsed = parseIdPMetadata(metadata);
    const result = await validateSAMLResponse(entraResponse(alice), {
      ...config,
      idpSsoUrl: parsed.ssoUrl,
      idpCerts: parsed.certs,
      idpIssuer: parsed.issuer,
    });
    expect(result.success).toBe(true);
    expect(result.user?.rawClaims[ENTRA_CLAIM.tenantId]).toBe(ENTRA_ISSUER.split("/")[3]);
  });
});
