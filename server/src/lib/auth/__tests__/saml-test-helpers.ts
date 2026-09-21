/**
 * Epic #517 (#520) — test helpers that mint REAL signed SAML Responses so the
 * provider's security posture is exercised against the actual node-saml
 * validator (not a mock). We sign with `xml-crypto` using the SAME enveloped +
 * exclusive-c14n + sha256 shape node-saml's own `signXml` uses, so the resulting
 * signatures pass node-saml's `getVerifiedXml`.
 *
 * The helpers let a test toggle exactly one variable at a time — sign the
 * assertion vs. the response, set `InResponseTo`, move `NotOnOrAfter` into the
 * past — so each reject path (#520 acceptance criteria) is proven in isolation.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SignedXml } from "xml-crypto";

/** A throwaway IdP signing identity: an RSA key + matching self-signed cert. */
export interface TestSigningKey {
  privateKey: string;
  /** PEM certificate (what the provider config stores as an IdP cert). */
  certificatePem: string;
  /** Base64 body of the cert (no PEM header/footer) — the metadata-parsed form. */
  certificateBody: string;
}

let cached: TestSigningKey | undefined;

/**
 * Generate a throwaway self-signed X.509 cert + RSA key at RUNTIME (cached once
 * per process) into an OS temp dir that is deleted immediately after reading.
 *
 * Why generated, not committed: a committed private-key PEM trips the repo's
 * Semgrep secret-detection gate (and is bad hygiene), so we mint it on the fly.
 * Why a real X.509 cert (via `openssl`) and not a bare public key: node-saml
 * wraps the stored base64 in `-----BEGIN CERTIFICATE-----` and verifies it as an
 * X.509 certificate, so a SPKI public key would fail that parse — and node's
 * `crypto` cannot mint an X.509 cert directly, hence the one `openssl` call
 * (present on the CI Linux runners and on macOS). It is a test-only identity.
 */
export function getTestSigningKey(): TestSigningKey {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "metis-saml-test-"));
  try {
    const keyPath = join(dir, "idp.key.pem");
    const certPath = join(dir, "idp.cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=metis-saml-test-idp",
        "-sha256",
      ],
      { stdio: "ignore" },
    );
    const privateKey = readFileSync(keyPath, "utf8");
    const certificatePem = readFileSync(certPath, "utf8");
    const certificateBody = certificatePem
      .replace(/-----BEGIN CERTIFICATE-----/, "")
      .replace(/-----END CERTIFICATE-----/, "")
      .replace(/\s/g, "");
    cached = { privateKey, certificatePem, certificateBody };
    return cached;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface SamlResponseOptions {
  /** SP entity id (audience) — must match the provider config's entityId. */
  audience: string;
  /** ACS URL (SubjectConfirmationData Recipient). */
  recipient: string;
  /** IdP issuer. */
  issuer: string;
  /** Subject NameID (email). */
  nameId: string;
  /** InResponseTo to embed in the Response + SubjectConfirmationData. */
  inResponseTo?: string;
  /** Assertion NotOnOrAfter as an ISO string. Defaults to +5min. */
  notOnOrAfter?: string;
  /** NotBefore as an ISO string. Defaults to -1min. */
  notBefore?: string;
  /** Extra attributes to embed (claim name -> value). */
  attributes?: Record<string, string>;
}

const ASSERTION_ID = "_assertion_id_1234567890";
const RESPONSE_ID = "_response_id_1234567890";

/** Build an unsigned SAML Response XML string. */
export function buildSamlResponseXml(opts: SamlResponseOptions): string {
  const now = Date.now();
  const notBefore = opts.notBefore ?? new Date(now - 60_000).toISOString();
  const notOnOrAfter = opts.notOnOrAfter ?? new Date(now + 5 * 60_000).toISOString();
  const issueInstant = new Date(now).toISOString();
  const inResponseToAttr = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : "";
  const subjectInResponseTo = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : "";
  const attrs = Object.entries(opts.attributes ?? {})
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${name}"><saml:AttributeValue>${value}</saml:AttributeValue></saml:Attribute>`,
    )
    .join("");
  const attrStatement = attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : "";

  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${RESPONSE_ID}" Version="2.0" IssueInstant="${issueInstant}"${inResponseToAttr} Destination="${opts.recipient}"><saml:Issuer>${opts.issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${ASSERTION_ID}" Version="2.0" IssueInstant="${issueInstant}"><saml:Issuer>${opts.issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${subjectInResponseTo} NotOnOrAfter="${notOnOrAfter}" Recipient="${opts.recipient}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issueInstant}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>${attrStatement}</saml:Assertion></samlp:Response>`;
}

/**
 * Sign an element identified by `id` with an enveloped signature, matching
 * node-saml's `signXml` output (enveloped + exclusive-c14n transforms, sha256
 * digest + signature, KeyInfo carrying the cert). The signature is inserted as
 * the last child of the referenced element (`action: "append"`), which for an
 * Assertion places it after Issuer per the SAML schema.
 */
export function signElementById(
  xml: string,
  id: string,
  key: TestSigningKey,
  locationXpath: string,
): string {
  const sig = new SignedXml({
    privateKey: key.privateKey,
    publicCert: key.certificatePem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${key.certificateBody}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: `//*[@ID='${id}']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, {
    location: { reference: locationXpath, action: "append" },
  });
  return sig.getSignedXml();
}

/** Sign just the Assertion (response envelope stays unsigned). */
export function signAssertion(xml: string, key: TestSigningKey): string {
  return signElementById(
    xml,
    ASSERTION_ID,
    key,
    `//*[local-name(.)='Assertion' and @ID='${ASSERTION_ID}']`,
  );
}

/** Sign the whole Response envelope. */
export function signResponse(xml: string, key: TestSigningKey): string {
  return signElementById(
    xml,
    RESPONSE_ID,
    key,
    `//*[local-name(.)='Response' and @ID='${RESPONSE_ID}']`,
  );
}

/** Base64-encode for the ACS SAMLResponse form field. */
export function toBase64(xml: string): string {
  return Buffer.from(xml, "utf8").toString("base64");
}

export { ASSERTION_ID, RESPONSE_ID };
