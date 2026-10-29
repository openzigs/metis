/**
 * #1553 — an in-process SAML identity provider that behaves like Microsoft
 * Entra ID, for tests.
 *
 * The generic harness (`docker-compose.saml.yml`, boxyhq/mock-saml) cannot
 * reproduce what Entra sends, so this mock reproduces it, on loopback, with no
 * container and no external network. It serves:
 *   - Federation Metadata XML  GET /<tenant>/federationmetadata/2007-06/federationmetadata.xml
 *     signed, with WS-Federation `RoleDescriptor`s before the `IDPSSODescriptor`
 *     and the entityID `https://sts.windows.net/<tenant>/`;
 *   - the SAML endpoint        GET /<tenant>/saml2?SAMLRequest=…  (HTTP-Redirect)
 *     checks the SP-initiated AuthnRequest as Entra does (a known Issuer, the
 *     registered ACS URL), signs the configured user in at once, and answers
 *     with Entra's auto-posting form carrying the SAML Response (HTTP-POST).
 *     Given `accounts` (#1559, `scripts/entra-idp.mjs`), it shows an account
 *     picker instead, which POSTs back with the account and signing option.
 *
 * The Response is Entra-shaped: Issuer `https://sts.windows.net/<tenant>/`, the
 * user's UPN as an e-mail NameID, and Entra's claim URIs (`objectidentifier`,
 * `tenantid`, `displayname`, `emailaddress`, `name`, `groups` as object ids,
 * `role`, `authnmethodsreferences`). A profile, changeable between sign-ins,
 * selects the signing option (Entra's default "Sign SAML assertion", "Sign
 * SAML response", or both), MFA or password-only — or a named Entra
 * authentication method (#1554: passwordless phone sign-in, FIDO2, passkeys,
 * Windows Hello for Business, certificate-based authentication) and which of
 * the two MFA signals the Response carries — a groups overage
 * (`groups.link` instead of `groups`), an expired or wrong-audience
 * assertion, and another Issuer signed with the same key (#1555). Every shape
 * is cited from Microsoft Learn in
 * docs/auth/saml-local-testing.md.
 *
 * The signing key and its self-signed certificate are generated at startup
 * with `openssl` into a temp directory that is deleted at once: nothing is
 * committed. Signatures are made with `xml-crypto` (enveloped, exclusive c14n,
 * RSA-SHA256), the algorithms Entra uses.
 *
 * Used by `server/tests/saml-entra-mock-idp-1553.sqlite.test.ts`, the
 * Playwright spec `e2e/tests/sso-saml-entra.spec.ts`, and the local runner
 * `scripts/entra-idp.mjs` (`make entra-up`, #1559).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

export const ENTRA_CLAIM = Object.freeze({
  objectId: "http://schemas.microsoft.com/identity/claims/objectidentifier",
  tenantId: "http://schemas.microsoft.com/identity/claims/tenantid",
  identityProvider: "http://schemas.microsoft.com/identity/claims/identityprovider",
  displayName: "http://schemas.microsoft.com/identity/claims/displayname",
  emailAddress: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  groups: "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  role: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  groupsLink: "http://schemas.microsoft.com/claims/groups.link",
  authnMethodsReferences: "http://schemas.microsoft.com/claims/authnmethodsreferences",
});

const AMR_METHOD_NS = "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/";
const AMR_MULTIPLE_AUTHN = "http://schemas.microsoft.com/claims/multipleauthn";
const CLASS_NS = "urn:oasis:names:tc:SAML:2.0:ac:classes:";

/**
 * #1554 — what Entra reports for each authentication method: the
 * `authnmethodsreferences` values (each under the `authenticationmethod/`
 * namespace, except `multipleauthn`) and the AuthnContextClassRef class name.
 * Source: Microsoft Learn, "Single sign-on SAML protocol", the AuthnStatement
 * and authnmethodsreferences tables. `passwordAndMfa` is a password plus a
 * second factor, as in that page's sample Response; `mfa: true` selects it.
 */
export const ENTRA_AUTH_METHODS = Object.freeze({
  password: { amr: ["password"], classRef: "Password", mfa: false },
  passwordAndMfa: {
    amr: ["password", "multipleauthn"],
    classRef: "MobileTwoFactorContract",
    mfa: true,
  },
  phoneSignIn: { amr: ["swk", "multipleauthn"], classRef: "MobileTwoFactorContract", mfa: true },
  fido2SecurityKey: { amr: ["fido", "multipleauthn"], classRef: "SmartcardPKI", mfa: true },
  passkeyDeviceBound: { amr: ["fido", "multipleauthn"], classRef: "SmartcardPKI", mfa: true },
  passkeySynced: { amr: ["fido", "multipleauthn"], classRef: "SoftwarePKI", mfa: true },
  windowsHelloForBusiness: { amr: ["hwk", "multipleauthn"], classRef: "SmartcardPKI", mfa: true },
  certificateMultiFactor: { amr: ["x509", "multipleauthn"], classRef: "SmartcardPKI", mfa: true },
  certificateSingleFactor: { amr: ["x509"], classRef: "X509", mfa: false },
});

/** @param {string} value  an `authnmethodsreferences` value from the table */
function amrUri(value) {
  return value === "multipleauthn" ? AMR_MULTIPLE_AUTHN : `${AMR_METHOD_NS}${value}`;
}
const BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const DSIG = {
  signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  transforms: [
    "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
    "http://www.w3.org/2001/10/xml-exc-c14n#",
  ],
};

/**
 * @typedef {object} EntraUser
 * @property {string} upn          user principal name; also the NameID and e-mail
 * @property {string} objectId     the user's object id
 * @property {string} displayName
 * @property {string[]} [groups]   group object ids
 * @property {string[]} [roles]    app role values
 */

/**
 * @typedef {object} EntraProfile
 * @property {"assertion" | "response" | "both"} signing
 *   Entra's "Signing Option": "Sign SAML assertion" (Entra's default), "Sign
 *   SAML response", or "Sign SAML response and assertion".
 * @property {boolean} mfa            the user completed MFA (a password and a second factor)
 * @property {keyof typeof ENTRA_AUTH_METHODS} [method]
 *   the authentication method; overrides `mfa` when set
 * @property {"both" | "amr" | "classRef"} mfaSignals
 *   which signals the Response carries: both (default); `amr` alone, with the
 *   class ref `Password` as in Microsoft's sample Response; or `classRef` alone,
 *   with no `authnmethodsreferences` claim, as for an app that has not added the
 *   optional `amr` claim
 * @property {boolean} groupOverage   send `groups.link` instead of `groups`
 * @property {boolean} expired        the assertion's validity window has passed
 * @property {boolean} wrongAudience  the Audience is not the SP's entity id
 * @property {string} [issuer]        the Issuer the Response and assertion name, signed with
 *   this IdP's own key (#1555: another tenant's issuer); default: this IdP's issuer
 */

/** Entra's own defaults: assertion-only signing, a password sign-in. */
export const DEFAULT_PROFILE = Object.freeze({
  signing: /** @type {const} */ ("assertion"),
  mfa: false,
  mfaSignals: /** @type {const} */ ("both"),
  groupOverage: false,
  expired: false,
  wrongAudience: false,
  issuer: /** @type {string | undefined} */ (undefined),
});

/**
 * @typedef {object} MockEntraSamlIdpOptions
 * @property {string} spEntityId   the enterprise app's Identifier (Entity ID)
 * @property {string} acsUrl       the enterprise app's Reply URL (ACS URL)
 * @property {EntraUser} user      who signs in at the SAML endpoint
 * @property {Partial<EntraProfile>} [profile]
 * @property {string} [tenantId]   default: a random UUID per instance
 * @property {string} [host]       bind address, default 127.0.0.1
 * @property {number} [port]       listen port, default 0 (ephemeral)
 * @property {EntraAccount[]} [accounts]
 *   #1559 — when given, the SAML endpoint shows an account picker offering
 *   these instead of signing `user` in at once.
 */

/**
 * @typedef {object} EntraAccount  a preset account on the account picker
 * @property {EntraUser} user
 * @property {Partial<EntraProfile>} [profile]  e.g. `{ mfa: true }`; the picker's signing option wins
 * @property {string} [note]                    one line shown beside the name
 */

/** @param {string} value */
export function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A throwaway RSA key and self-signed certificate. `node:crypto` cannot mint an
 * X.509 certificate, and node-saml verifies against one, hence `openssl`.
 */
export function generateSigningIdentity() {
  const dir = mkdtempSync(join(tmpdir(), "metis-entra-idp-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
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
        "2",
        "-nodes",
        "-subj",
        "/CN=Microsoft Azure Federated SSO Certificate (mock)",
        "-sha256",
      ],
      { stdio: "ignore" },
    );
    const certificatePem = readFileSync(certPath, "utf8");
    return {
      privateKey: readFileSync(keyPath, "utf8"),
      certificatePem,
      certificate: certificatePem
        .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
        .replace(/\s/g, ""),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sign `xml` with an enveloped signature over the element `referenceXpath`
 * selects, placed `action` relative to `locationXpath`.
 *
 * @param {string} xml
 * @param {ReturnType<typeof generateSigningIdentity>} identity
 * @param {string} referenceXpath
 * @param {{ reference: string, action: "after" | "prepend" }} location
 */
function signXml(xml, identity, referenceXpath, location) {
  const sig = new SignedXml({
    privateKey: identity.privateKey,
    signatureAlgorithm: DSIG.signatureAlgorithm,
    canonicalizationAlgorithm: DSIG.canonicalizationAlgorithm,
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${identity.certificate}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: referenceXpath,
    transforms: DSIG.transforms,
    digestAlgorithm: DSIG.digestAlgorithm,
  });
  sig.computeSignature(xml, { location });
  return sig.getSignedXml();
}

/** @param {string} cert */
const keyDescriptor = (cert) =>
  `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${cert}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`;

/**
 * Federation Metadata XML in Entra's shape, signed.
 *
 * @param {{ tenantId: string, issuer: string, ssoUrl: string, baseUrl: string }} ids
 * @param {ReturnType<typeof generateSigningIdentity>} identity
 */
export function buildFederationMetadata(ids, identity) {
  const cert = identity.certificate;
  const wsfed = `${ids.baseUrl}/${ids.tenantId}/wsfed`;
  const fedNs =
    'protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706"';
  /** @param {string} url */
  const endpoint = (url) =>
    `<wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>${escapeXml(url)}</wsa:Address></wsa:EndpointReference>`;
  const claimTypes = Object.values(ENTRA_CLAIM)
    .map(
      (uri) =>
        `<auth:ClaimType Uri="${uri}" xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706"><auth:DisplayName>${uri.split("/").pop()}</auth:DisplayName></auth:ClaimType>`,
    )
    .join("");
  const unsigned =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<EntityDescriptor ID="_${randomUUID()}" entityID="${escapeXml(ids.issuer)}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata">` +
    `<RoleDescriptor xsi:type="fed:SecurityTokenServiceType" ${fedNs}>${keyDescriptor(cert)}` +
    `<fed:ClaimTypesOffered>${claimTypes}</fed:ClaimTypesOffered>` +
    `<fed:SecurityTokenServiceEndpoint>${endpoint(wsfed)}</fed:SecurityTokenServiceEndpoint>` +
    `<fed:PassiveRequestorEndpoint>${endpoint(wsfed)}</fed:PassiveRequestorEndpoint></RoleDescriptor>` +
    `<RoleDescriptor xsi:type="fed:ApplicationServiceType" ${fedNs}>${keyDescriptor(cert)}` +
    `<fed:TargetScopes>${endpoint(ids.issuer)}</fed:TargetScopes>` +
    `<fed:ApplicationServiceEndpoint>${endpoint(wsfed)}</fed:ApplicationServiceEndpoint>` +
    `<fed:PassiveRequestorEndpoint>${endpoint(wsfed)}</fed:PassiveRequestorEndpoint></RoleDescriptor>` +
    `<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${keyDescriptor(cert)}` +
    `<SingleLogoutService Binding="${BINDING_REDIRECT}" Location="${escapeXml(ids.ssoUrl)}"/>` +
    `<SingleSignOnService Binding="${BINDING_REDIRECT}" Location="${escapeXml(ids.ssoUrl)}"/>` +
    `<SingleSignOnService Binding="${BINDING_POST}" Location="${escapeXml(ids.ssoUrl)}"/>` +
    `</IDPSSODescriptor></EntityDescriptor>`;
  const signed = new SignedXml({
    privateKey: identity.privateKey,
    signatureAlgorithm: DSIG.signatureAlgorithm,
    canonicalizationAlgorithm: DSIG.canonicalizationAlgorithm,
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${identity.certificate}</X509Certificate></X509Data>`,
  });
  signed.addReference({
    xpath: "//*[local-name(.)='EntityDescriptor']",
    transforms: DSIG.transforms,
    digestAlgorithm: DSIG.digestAlgorithm,
  });
  signed.computeSignature(unsigned, {
    prefix: "ds",
    location: { reference: "//*[local-name(.)='EntityDescriptor']", action: "prepend" },
  });
  return signed.getSignedXml();
}

/** @param {string} name @param {string | string[]} values */
const attribute = (name, values) =>
  `<Attribute Name="${name}">${(Array.isArray(values) ? values : [values])
    .map((v) => `<AttributeValue>${escapeXml(v)}</AttributeValue>`)
    .join("")}</Attribute>`;

/**
 * An Entra-shaped SAML Response for `user`, signed as `profile.signing` says.
 *
 * @param {{
 *   issuer: string, tenantId: string, spEntityId: string, acsUrl: string,
 *   inResponseTo: string, user: EntraUser, profile: EntraProfile, now?: number,
 * }} input
 * @param {ReturnType<typeof generateSigningIdentity>} identity
 */
export function buildEntraResponse(input, identity) {
  const { user, profile } = input;
  const now = input.now ?? Date.now();
  // An expired assertion was issued two hours ago; its windows closed 50 min ago.
  const issued = profile.expired ? now - 2 * 60 * 60_000 : now;
  /** @param {number} ms */
  const iso = (ms) => new Date(ms).toISOString();
  const responseId = `_${randomUUID()}`;
  const assertionId = `_${randomUUID()}`;
  const audience = profile.wrongAudience
    ? "https://another-application.example/sp"
    : input.spEntityId;
  const issuerXml = escapeXml(input.issuer);
  const method =
    ENTRA_AUTH_METHODS[profile.method ?? (profile.mfa ? "passwordAndMfa" : "password")];
  if (!method) throw new Error(`unknown Entra authentication method: ${profile.method}`);
  const signals = profile.mfaSignals ?? "both";
  const classRef = `${CLASS_NS}${signals === "amr" ? "Password" : method.classRef}`;
  const attrs = [
    attribute(ENTRA_CLAIM.tenantId, input.tenantId),
    attribute(ENTRA_CLAIM.objectId, user.objectId),
    attribute(ENTRA_CLAIM.identityProvider, input.issuer),
    ...(signals === "classRef"
      ? []
      : [attribute(ENTRA_CLAIM.authnMethodsReferences, method.amr.map(amrUri))]),
    attribute(ENTRA_CLAIM.displayName, user.displayName),
    attribute(ENTRA_CLAIM.emailAddress, user.upn),
    attribute(ENTRA_CLAIM.name, user.upn),
  ];
  if (profile.groupOverage) {
    attrs.push(
      attribute(
        ENTRA_CLAIM.groupsLink,
        `https://graph.windows.net/${input.tenantId}/users/${user.objectId}/getMemberObjects`,
      ),
    );
  } else if (user.groups?.length) {
    attrs.push(attribute(ENTRA_CLAIM.groups, user.groups));
  }
  if (user.roles?.length) attrs.push(attribute(ENTRA_CLAIM.role, user.roles));

  const assertion =
    `<Assertion ID="${assertionId}" IssueInstant="${iso(issued)}" Version="2.0" xmlns="urn:oasis:names:tc:SAML:2.0:assertion">` +
    `<Issuer>${issuerXml}</Issuer>` +
    `<Subject><NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escapeXml(user.upn)}</NameID>` +
    `<SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<SubjectConfirmationData InResponseTo="${escapeXml(input.inResponseTo)}" NotOnOrAfter="${iso(issued + 5 * 60_000)}" Recipient="${escapeXml(input.acsUrl)}"/>` +
    `</SubjectConfirmation></Subject>` +
    `<Conditions NotBefore="${iso(issued - 5_000)}" NotOnOrAfter="${iso(issued + 70 * 60_000)}">` +
    `<AudienceRestriction><Audience>${escapeXml(audience)}</Audience></AudienceRestriction></Conditions>` +
    `<AttributeStatement>${attrs.join("")}</AttributeStatement>` +
    `<AuthnStatement AuthnInstant="${iso(issued - 1_000)}" SessionIndex="${assertionId}"><AuthnContext>` +
    `<AuthnContextClassRef>${classRef}</AuthnContextClassRef>` +
    `</AuthnContext></AuthnStatement></Assertion>`;
  let xml =
    `<samlp:Response ID="${responseId}" Version="2.0" IssueInstant="${iso(issued)}" Destination="${escapeXml(input.acsUrl)}" InResponseTo="${escapeXml(input.inResponseTo)}" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol">` +
    `<Issuer xmlns="urn:oasis:names:tc:SAML:2.0:assertion">${issuerXml}</Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `${assertion}</samlp:Response>`;

  // Entra places each Signature right after the signed element's Issuer.
  if (profile.signing !== "response") {
    xml = signXml(xml, identity, `//*[@ID='${assertionId}']`, {
      reference: `//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']`,
      action: "after",
    });
  }
  if (profile.signing !== "assertion") {
    xml = signXml(xml, identity, `//*[@ID='${responseId}']`, {
      reference: `/*[local-name(.)='Response']/*[local-name(.)='Issuer']`,
      action: "after",
    });
  }
  return xml;
}

/**
 * The fields of an SP-initiated AuthnRequest that Entra checks. The input is
 * the SP's own request, bounded by the URL it arrived in.
 *
 * @param {string} encoded  the `SAMLRequest` query value (deflated, base64)
 */
export function readAuthnRequest(encoded) {
  const xml = inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
  const head = /<(?:\w+:)?AuthnRequest\b([^>]*)>/.exec(xml)?.[1];
  if (head === undefined) throw new Error("not an AuthnRequest");
  return {
    id: /\bID="([^"]*)"/.exec(head)?.[1] ?? "",
    acsUrl: /\bAssertionConsumerServiceURL="([^"]*)"/.exec(head)?.[1],
    issuer: /<(?:\w+:)?Issuer\b[^>]*>([^<]*)<\/(?:\w+:)?Issuer>/.exec(xml)?.[1]?.trim() ?? "",
  };
}

/** Entra's auto-posting form. @param {string} acsUrl @param {string} samlResponse @param {string | null} relayState */
function autoPostForm(acsUrl, samlResponse, relayState) {
  const relay =
    relayState === null
      ? ""
      : `<input type="hidden" name="RelayState" value="${escapeXml(relayState)}" />`;
  return (
    `<!DOCTYPE html><html><head><title>Working...</title></head><body>` +
    `<form method="POST" name="hiddenform" action="${escapeXml(acsUrl)}">` +
    `<input type="hidden" name="SAMLResponse" value="${samlResponse}" />${relay}` +
    `<noscript><p>Script is disabled. Click Submit to continue.</p><input type="submit" value="Submit" /></noscript>` +
    `</form><script>document.forms[0].submit();</script></body></html>`
  );
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} contentType
 * @param {string} body
 */
function send(res, status, contentType, body) {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

/**
 * Entra's signing options, as the account picker offers them.
 * @type {ReadonlyArray<readonly [EntraProfile["signing"], string]>}
 */
export const SIGNING_OPTIONS = Object.freeze([
  /** @type {const} */ (["both", "Sign SAML response and assertion"]),
  /** @type {const} */ (["assertion", "Sign SAML assertion (Entra's default)"]),
  /** @type {const} */ (["response", "Sign SAML response"]),
]);

/**
 * #1559 — an account picker, the page Entra shows when it cannot choose the
 * account itself, so a person signs in by hand as any preset account under any
 * signing option. It posts the request back to the SAML endpoint.
 *
 * @param {{
 *   action: string, samlRequest: string, relayState: string | null,
 *   accounts: ReadonlyArray<EntraAccount>, signing: EntraProfile["signing"],
 * }} input
 */
export function accountPickerPage(input) {
  const relay =
    input.relayState === null
      ? ""
      : `<input type="hidden" name="RelayState" value="${escapeXml(input.relayState)}" />`;
  const options = SIGNING_OPTIONS.map(
    ([value, label]) =>
      `<option value="${value}"${value === input.signing ? " selected" : ""}>${escapeXml(label)}</option>`,
  ).join("");
  const buttons = input.accounts
    .map(
      (account, i) =>
        `<li><button type="submit" name="account" value="${i}">` +
        `<strong>${escapeXml(account.user.displayName)}</strong> &lt;${escapeXml(account.user.upn)}&gt;` +
        (account.note ? ` <small>${escapeXml(account.note)}</small>` : "") +
        `</button></li>`,
    )
    .join("");
  return (
    `<!DOCTYPE html><html><head><title>Pick an account (mock Entra ID)</title></head><body>` +
    `<h1>Pick an account</h1><p>Mock Microsoft Entra ID, for local testing only.</p>` +
    `<form method="POST" action="${escapeXml(input.action)}">` +
    `<input type="hidden" name="SAMLRequest" value="${escapeXml(input.samlRequest)}" />${relay}` +
    `<label>Signing option <select name="signing">${options}</select></label>` +
    `<ul>${buttons}</ul></form></body></html>`
  );
}

/** The largest picker form read; an AuthnRequest is a few hundred bytes. */
export const MAX_FORM_BYTES = 64 * 1024;

/**
 * The picker's urlencoded form, or null past MAX_FORM_BYTES.
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<URLSearchParams | null>}
 */
function readForm(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on("data", (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        req.removeAllListeners("data");
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/**
 * Start the IdP on loopback, on `options.port` or an ephemeral port.
 *
 * @param {MockEntraSamlIdpOptions} options
 */
export async function startMockEntraSamlIdp(options) {
  const identity = generateSigningIdentity();
  const tenantId = options.tenantId ?? randomUUID();
  const issuer = `https://sts.windows.net/${tenantId}/`;
  const host = options.host ?? "127.0.0.1";
  const accounts = options.accounts ?? [];
  let user = options.user;
  /** @type {EntraProfile} */
  let profile = { ...DEFAULT_PROFILE, ...options.profile };
  /** @type {string | undefined} */
  let lastResponse;
  const calls = { metadata: 0, sso: 0 };
  const ids = { tenantId, issuer, ssoUrl: "", baseUrl: "" };

  /**
   * Check an SP-initiated AuthnRequest as Entra does.
   * @param {string | null} encoded  the `SAMLRequest` value
   * @returns {{ request: ReturnType<typeof readAuthnRequest> } | { error: string }}
   */
  function checkRequest(encoded) {
    if (!encoded) return { error: "AADSTS750054: SAMLRequest must be present." };
    let request;
    try {
      request = readAuthnRequest(encoded);
    } catch {
      return { error: "AADSTS7500529: The SAML request is not valid." };
    }
    if (request.issuer !== options.spEntityId) {
      return {
        error: `AADSTS700016: Application with identifier '${request.issuer}' was not found in the directory.`,
      };
    }
    if (request.acsUrl !== undefined && request.acsUrl !== options.acsUrl) {
      return {
        error: `AADSTS50011: The redirect URI '${request.acsUrl}' does not match the redirect URIs configured for the application.`,
      };
    }
    return { request };
  }

  /**
   * Sign `who` in under `as` and answer with Entra's auto-posting form.
   * @param {import("node:http").ServerResponse} res
   * @param {string} inResponseTo
   * @param {string | null} relayState
   * @param {EntraUser} who
   * @param {EntraProfile} as
   */
  function answer(res, inResponseTo, relayState, who, as) {
    const xml = buildEntraResponse(
      {
        issuer: as.issuer ?? issuer,
        tenantId,
        spEntityId: options.spEntityId,
        acsUrl: options.acsUrl,
        inResponseTo,
        user: who,
        profile: as,
      },
      identity,
    );
    lastResponse = Buffer.from(xml, "utf8").toString("base64");
    send(
      res,
      200,
      "text/html; charset=utf-8",
      autoPostForm(options.acsUrl, lastResponse, relayState),
    );
  }

  /**
   * The picker's POST: the chosen account under the chosen signing option.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async function pick(req, res) {
    const form = await readForm(req);
    if (form === null) return send(res, 413, "text/plain", "The form is too large.");
    const checked = checkRequest(form.get("SAMLRequest"));
    if ("error" in checked) return send(res, 400, "text/plain", checked.error);
    const index = form.get("account") ?? "";
    const account = /^\d+$/.test(index) ? accounts[Number(index)] : undefined;
    if (account === undefined) return send(res, 400, "text/plain", "Unknown account.");
    const signing = SIGNING_OPTIONS.find(([value]) => value === form.get("signing"))?.[0];
    if (signing === undefined) return send(res, 400, "text/plain", "Unknown signing option.");
    answer(res, checked.request.id, form.get("RelayState"), account.user, {
      ...profile,
      ...account.profile,
      signing,
    });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", ids.baseUrl || "http://localhost");
    const path = url.pathname.toLowerCase();
    if (
      req.method === "GET" &&
      path === `/${tenantId}/federationmetadata/2007-06/federationmetadata.xml`
    ) {
      calls.metadata += 1;
      return send(
        res,
        200,
        "application/xml; charset=utf-8",
        buildFederationMetadata(ids, identity),
      );
    }
    if (req.method === "GET" && path === `/${tenantId}/saml2`) {
      calls.sso += 1;
      const encoded = url.searchParams.get("SAMLRequest");
      const checked = checkRequest(encoded);
      if ("error" in checked) return send(res, 400, "text/plain", checked.error);
      const relayState = url.searchParams.get("RelayState");
      if (accounts.length === 0) return answer(res, checked.request.id, relayState, user, profile);
      return send(
        res,
        200,
        "text/html; charset=utf-8",
        accountPickerPage({
          action: ids.ssoUrl,
          samlRequest: /** @type {string} */ (encoded),
          relayState,
          accounts,
          signing: profile.signing,
        }),
      );
    }
    if (req.method === "POST" && path === `/${tenantId}/saml2` && accounts.length > 0) {
      pick(req, res).catch(() => send(res, 400, "text/plain", "The request is not valid."));
      return;
    }
    send(res, 404, "text/plain", "not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve(undefined));
  });
  const address = /** @type {import("node:net").AddressInfo} */ (server.address());
  ids.baseUrl = `http://${host}:${address.port}`;
  ids.ssoUrl = `${ids.baseUrl}/${tenantId}/saml2`;

  return {
    tenantId,
    issuer,
    ssoUrl: ids.ssoUrl,
    metadataUrl: `${ids.baseUrl}/${tenantId}/federationmetadata/2007-06/federationmetadata.xml`,
    /** The base64 body of the signing certificate. */
    certificate: identity.certificate,
    calls,
    /** The base64 SAMLResponse of the last sign-in, for a replay. */
    lastResponse: () => lastResponse,
    /** @param {EntraUser} next */
    setUser: (next) => {
      user = next;
    },
    /** Change the profile for later sign-ins; unnamed fields go back to Entra's defaults. @param {Partial<EntraProfile>} next */
    setProfile: (next) => {
      profile = { ...DEFAULT_PROFILE, ...next };
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      }),
  };
}
