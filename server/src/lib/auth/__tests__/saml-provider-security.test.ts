/**
 * Epic #517 (#520) — SAML hardening security tests.
 *
 * These drive the REAL node-saml validator (via `validateSAMLResponse`) with
 * REAL signed/unsigned SAML Responses to prove the #520 acceptance criteria,
 * one reject path per test:
 *   - a valid signed Response authenticates (no regression to valid login),
 *   - an UNSIGNED Response is rejected when response-signing is required,
 *   - an assertion-only-signed Response is accepted iff requireSignedResponse=false,
 *   - an expired assertion (NotOnOrAfter in the past) is rejected,
 *   - a REPLAYED Response (same InResponseTo consumed twice) is rejected,
 *   - an InResponseTo that was never issued / mismatched is rejected.
 *
 * The InResponseTo (replay) tests run the genuine two-leg flow: we call
 * `generateAuthnRequestUrl` (which saves the request id into the shared cache),
 * extract the generated request id from the AuthnRequest, and use it as the
 * Response's InResponseTo — proving the shared-cache wiring end to end.
 */
import { inflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetSAMLInstances,
  generateAuthnRequestUrl,
  validateSAMLResponse,
} from "../saml-provider.js";
import { __resetSamlRequestIdCache } from "../saml-request-id-cache.js";
import type { SAMLConfig } from "../sso-types.js";
import {
  buildSamlResponseXml,
  getTestSigningKey,
  signAssertion,
  signResponse,
  toBase64,
} from "./saml-test-helpers.js";

const key = getTestSigningKey();

const ENTITY_ID = "https://metis.example.com/saml/metadata";
const ACS_URL = "https://metis.example.com/auth/saml/acs";
const IDP_ISSUER = "https://idp.example.com/saml";
const IDP_SSO_URL = "https://idp.example.com/saml/sso";

function makeConfig(overrides: Partial<SAMLConfig> = {}): SAMLConfig {
  return {
    entityId: ENTITY_ID,
    acsUrl: ACS_URL,
    idpMetadataXml: "",
    idpSsoUrl: IDP_SSO_URL,
    idpCerts: [key.certificateBody], // metadata-parsed base64 body
    idpIssuer: IDP_ISSUER,
    signRequests: false,
    ...overrides,
  };
}

const responseDefaults = {
  audience: ENTITY_ID,
  recipient: ACS_URL,
  issuer: IDP_ISSUER,
  nameId: "alice@example.com",
};

/** Run the AuthnRequest leg and pull the generated request id from the URL. */
async function mintRequestId(config: SAMLConfig): Promise<string> {
  const url = await generateAuthnRequestUrl(config);
  const samlRequest = new URL(url).searchParams.get("SAMLRequest");
  if (!samlRequest) throw new Error("no SAMLRequest in AuthnRequest URL");
  const xml = inflateRawSync(Buffer.from(samlRequest, "base64")).toString("utf8");
  const id = xml.match(/ID="([^"]+)"/)?.[1];
  if (!id) throw new Error("no ID in AuthnRequest");
  return id;
}

beforeEach(() => {
  __resetSAMLInstances();
  __resetSamlRequestIdCache();
});
afterEach(() => {
  __resetSAMLInstances();
  __resetSamlRequestIdCache();
});

describe("validateSAMLResponse — valid login (no regression)", () => {
  it("authenticates a validly signed Response with a matching InResponseTo", async () => {
    const config = makeConfig();
    const inResponseTo = await mintRequestId(config);

    const xml = buildSamlResponseXml({
      ...responseDefaults,
      inResponseTo,
      attributes: { "http://schemas.xmlsoap.org/claims/Group": "engineering" },
    });
    const signed = signResponse(signAssertion(xml, key), key);

    const result = await validateSAMLResponse(toBase64(signed), config);

    expect(result.success).toBe(true);
    expect(result.user?.email).toBe("alice@example.com");
  });

  it("accepts assertion-only signing when requireSignedResponse=false", async () => {
    const config = makeConfig({ requireSignedResponse: false });
    const inResponseTo = await mintRequestId(config);

    const xml = buildSamlResponseXml({ ...responseDefaults, inResponseTo });
    const signed = signAssertion(xml, key); // assertion signed, envelope NOT

    const result = await validateSAMLResponse(toBase64(signed), config);

    expect(result.success).toBe(true);
    expect(result.user?.email).toBe("alice@example.com");
  });
});

describe("validateSAMLResponse — reject paths (#520)", () => {
  it("rejects an UNSIGNED response when response-signing is required (default)", async () => {
    const config = makeConfig(); // requireSignedResponse defaults to true
    const inResponseTo = await mintRequestId(config);

    // Assertion signed but the Response envelope is NOT — must be rejected
    // because wantAuthnResponseSigned is on by default.
    const xml = buildSamlResponseXml({ ...responseDefaults, inResponseTo });
    const signed = signAssertion(xml, key);

    const result = await validateSAMLResponse(toBase64(signed), config);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/document signature/i);
  });

  it("rejects a fully unsigned response", async () => {
    const config = makeConfig({ requireSignedResponse: false });
    const inResponseTo = await mintRequestId(config);

    const xml = buildSamlResponseXml({ ...responseDefaults, inResponseTo });
    // Neither assertion nor response signed -> assertion signature check fails.
    const result = await validateSAMLResponse(toBase64(xml), config);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/signature/i);
  });

  it("rejects an assertion past its NotOnOrAfter (expired window)", async () => {
    const config = makeConfig();
    const inResponseTo = await mintRequestId(config);

    const past = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
    const xml = buildSamlResponseXml({
      ...responseDefaults,
      inResponseTo,
      notBefore: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      notOnOrAfter: past,
    });
    const signed = signResponse(signAssertion(xml, key), key);

    const result = await validateSAMLResponse(toBase64(signed), config);

    expect(result.success).toBe(false);
    // node-saml enforces the assertion time window via the SubjectConfirmationData
    // NotOnOrAfter: once it is in the past, no confirmation is valid -> rejected.
    expect(result.error).toMatch(
      /not on or after|expired|conditions|too old|subject confirmation/i,
    );
  });

  it("tolerates minor clock skew within acceptedClockSkewMs (legit login not broken)", async () => {
    const config = makeConfig();
    const inResponseTo = await mintRequestId(config);

    // NotOnOrAfter 5s in the past — inside the 30s skew tolerance, so a slightly
    // fast SP clock must NOT reject a legitimate assertion.
    const xml = buildSamlResponseXml({
      ...responseDefaults,
      inResponseTo,
      notOnOrAfter: new Date(Date.now() - 5_000).toISOString(),
    });
    const signed = signResponse(signAssertion(xml, key), key);

    const result = await validateSAMLResponse(toBase64(signed), config);
    expect(result.success).toBe(true);
  });

  it("rejects a REPLAYED response (same InResponseTo consumed twice)", async () => {
    const config = makeConfig();
    const inResponseTo = await mintRequestId(config);

    const xml = buildSamlResponseXml({ ...responseDefaults, inResponseTo });
    const signed = signResponse(signAssertion(xml, key), key);
    const encoded = toBase64(signed);

    // First presentation: the id is in the cache -> accepted, then consumed.
    const first = await validateSAMLResponse(encoded, config);
    expect(first.success).toBe(true);

    // Replay: the id was removed on first use -> InResponseTo no longer valid.
    const replay = await validateSAMLResponse(encoded, config);
    expect(replay.success).toBe(false);
    expect(replay.error).toMatch(/inresponseto/i);
  });

  it("rejects an InResponseTo that was never issued (unknown id)", async () => {
    const config = makeConfig();
    // Do NOT mint a request id — the cache has no entry for this InResponseTo.
    const xml = buildSamlResponseXml({
      ...responseDefaults,
      inResponseTo: "_never-issued-request-id",
    });
    const signed = signResponse(signAssertion(xml, key), key);

    const result = await validateSAMLResponse(toBase64(signed), config);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inresponseto/i);
  });

  it("rejects an InResponseTo mismatch (response id != the issued request id)", async () => {
    const config = makeConfig();
    await mintRequestId(config); // issues SOME id, but the response uses another

    const xml = buildSamlResponseXml({
      ...responseDefaults,
      inResponseTo: "_different-id-than-issued",
    });
    const signed = signResponse(signAssertion(xml, key), key);

    const result = await validateSAMLResponse(toBase64(signed), config);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/inresponseto/i);
  });
});
