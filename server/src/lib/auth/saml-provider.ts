/**
 * SAML 2.0 authentication provider via @node-saml/passport-saml v5.
 *
 * Epic #748, Issue #749: SAML 2.0 provider.
 * - SP metadata endpoint at /auth/saml/metadata
 * - IdP metadata upload + parse on save
 * - Inspects AuthnContextClassRef for MFA passthrough (#754)
 *
 * Epic #517, Issue #520 — security hardening (OWASP A07):
 * - `validateInResponseTo: ifPresent` + a request-id `cacheProvider` give
 *   InResponseTo / replay protection: the id minted on the AuthnRequest is
 *   single-use, so a captured Response cannot be replayed.
 * - `wantAuthnResponseSigned: true` by default — the Response envelope (not just
 *   the assertion) must be signed unless an admin explicitly opts out.
 * - `acceptedClockSkewMs` is a small (not zero, not unbounded) tolerance so the
 *   assertion `NotOnOrAfter` / SubjectConfirmation window is enforced without
 *   breaking legitimate logins across slightly-skewed clocks.
 *
 * CRITICAL — shared cache across the two legs. `validateInResponseTo` only works
 * if the SAME `cacheProvider` instance is used to (a) save the id when the
 * AuthnRequest is generated and (b) read+remove it when the Response is
 * validated. The SAML instance is therefore built ONCE per config (memoised) and
 * reused across `generateAuthnRequestUrl` + `validateSAMLResponse`, and under
 * multi-replica the cache must be the shared Postgres backend (see
 * saml-request-id-cache.ts) so the two legs can land on different pods.
 */
import {
  SAML,
  ValidateInResponseTo,
  type SamlConfig,
  type CacheProvider,
} from "@node-saml/passport-saml";
import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../logger.js";
import {
  DEFAULT_REQUEST_ID_EXPIRATION_MS,
  resolveSamlRequestIdCache,
} from "./saml-request-id-cache.js";
import type { SSOAuthResult, SAMLConfig } from "./sso-types.js";

const log = createChildLogger("saml-provider");

/**
 * Clock-skew tolerance (ms) for SAML assertion time-window checks
 * (`NotBefore` / `NotOnOrAfter` / SubjectConfirmation). 30s is the conventional
 * SAML default — large enough to absorb normal NTP drift between the IdP and SP,
 * small enough that an expired assertion is rejected promptly. NOT zero (would
 * reject legitimate logins on minor skew) and NOT unbounded (would defeat the
 * NotOnOrAfter expiry this issue enforces).
 */
const SAML_CLOCK_SKEW_MS = 30_000;

/**
 * AuthnContextClassRef values that mean a second factor was used (#754, #1552).
 *
 * Not `PasswordProtectedTransport` (a password over TLS — what ADFS and generic
 * IdPs report for a password-only sign-in) and not `X509` (Entra reports it for
 * single-factor certificate and device authentication). Entra reports
 * `MobileTwoFactorContract` when Authenticator, SMS, phone or e-mail completes
 * MFA and `SmartcardPKI` for FIDO2, passkeys, Windows Hello and multi-factor
 * CBA; ADFS reports `multipleauthn` as a class ref. Source: Microsoft Learn,
 * "Single sign-on SAML protocol" (AuthnStatement table).
 */
const MFA_AUTHN_CONTEXTS: ReadonlySet<string> = new Set([
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI",
  "http://schemas.microsoft.com/claims/multipleauthn",
]);

/**
 * `authnmethodsreferences` values that mean MFA was completed. Entra emits
 * `multipleauthn` "only when the user completed multifactor authentication"
 * (Microsoft Learn, "Single sign-on SAML protocol", authnmethodsreferences).
 */
const MFA_AUTHN_METHODS: ReadonlySet<string> = new Set([
  "http://schemas.microsoft.com/claims/multipleauthn",
]);

/**
 * Claims METIS reads group-to-role mapping values from (#1552). The values of
 * every claim present are pooled, so a mapping on a group object id or on an
 * app role value both match. Sources: Microsoft Learn, "SAML 2.0 token claims
 * reference" (Entra `groups` and `role`); ADFS's `Group`; generic IdPs.
 */
const GROUP_CLAIMS = [
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  "http://schemas.xmlsoap.org/claims/Group",
  "groups",
  "memberOf",
] as const;

/**
 * Entra sends this INSTEAD of `groups` when the user is in more than 150
 * groups (Microsoft Learn, "SAML 2.0 token claims reference", Groups Overage
 * Indicator), so the user arrives with no group at all.
 */
export const ENTRA_GROUPS_OVERAGE_CLAIM = "http://schemas.microsoft.com/claims/groups.link";

const AUTHN_METHODS_CLAIM = "http://schemas.microsoft.com/claims/authnmethodsreferences";
const AUTHN_CLASS_CLAIM = "http://schemas.microsoft.com/claims/authnclassreference";

/**
 * node-saml rejects a Response whose envelope signature is missing or does not
 * verify, when `wantAuthnResponseSigned` is on, with exactly this message.
 */
const NODE_SAML_RESPONSE_SIGNATURE_ERROR = "Invalid document signature";

/**
 * What an admin sees instead (#1552). Entra's default signing option, "Sign
 * SAML assertion", leaves the Response envelope unsigned (Microsoft Learn,
 * "Certificate signing options in a SAML token").
 */
export const UNSIGNED_RESPONSE_MESSAGE =
  "Invalid document signature: the SAML Response envelope is not signed, or its signature " +
  "does not verify against the IdP certificate. METIS requires the whole Response to be " +
  "signed. In Microsoft Entra ID, set the enterprise application's SAML Signing Certificate > " +
  'Signing Option to "Sign SAML response and assertion".';

/**
 * Largest IdP metadata document accepted (#1540). Real metadata, even with a
 * few rolled-over signing certificates, is a few KB; an unbounded body let an
 * admin (or a compromised admin session) pin the event loop for seconds.
 */
export const SAML_METADATA_MAX_CHARS = 256 * 1024;

const SAML_BINDING_REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const SAML_BINDING_POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

/** Elements with this local name, in any (or no) namespace, in document order. */
function elementsByLocalName(doc: XmlDocument, localName: string): XmlElement[] {
  return Array.from(doc.getElementsByTagNameNS("*", localName));
}

/**
 * Parse IdP metadata XML to extract SSO URL, certificates, and issuer.
 *
 * Parsed with `@xmldom/xmldom` rather than regexes (#1540: the old
 * `SingleSignOnService[^>]+…[^>]+` patterns were polynomial, 2.7 s on 380 KB).
 * xmldom does not resolve external entities nor expand DTD-declared ones.
 * Metadata that is not well-formed XML yields empty values, as before; a
 * document over {@link SAML_METADATA_MAX_CHARS} is a 400.
 */
export function parseIdPMetadata(xml: string): {
  ssoUrl: string;
  certs: string[];
  issuer: string;
} {
  if (xml.length > SAML_METADATA_MAX_CHARS) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      `IdP metadata XML must be at most ${SAML_METADATA_MAX_CHARS} characters`,
    );
  }
  let doc: XmlDocument;
  try {
    // A non-fatal `error` (an undeclared entity, say) is ignored; only a fatal
    // well-formedness error throws.
    // xmldom treats whitespace or a BOM before `<?xml …?>` as fatal, and a pasted
    // textarea or an ADFS FederationMetadata.xml routinely carries both.
    doc = new DOMParser({ onError: () => undefined }).parseFromString(
      xml.replace(/^\uFEFF/, "").trim(),
      "text/xml",
    );
  } catch {
    return { ssoUrl: "", certs: [], issuer: "" };
  }

  // entityID of the (first) EntityDescriptor.
  const issuer =
    elementsByLocalName(doc, "EntityDescriptor")
      .map((el) => el.getAttribute("entityID") ?? "")
      .find((id) => id.length > 0) ?? "";

  // SSO URL: HTTP-Redirect binding preferred, fallback to POST.
  const services = elementsByLocalName(doc, "SingleSignOnService");
  const locationFor = (binding: string): string | undefined =>
    services
      .filter((el) => el.getAttribute("Binding") === binding)
      .map((el) => el.getAttribute("Location") ?? "")
      .find((loc) => loc.length > 0);
  const ssoUrl = locationFor(SAML_BINDING_REDIRECT) ?? locationFor(SAML_BINDING_POST) ?? "";

  // Token-signing certificates: the IDPSSODescriptor's KeyDescriptors (any
  // namespace prefix), not every X509Certificate in the document. Entra's
  // metadata repeats its certificate in two WS-Federation RoleDescriptors and in
  // the document signature's KeyInfo (#1552); the metadata signer is not
  // thereby a token signer.
  const certs: string[] = [];
  for (const descriptor of elementsByLocalName(doc, "IDPSSODescriptor")) {
    for (const keyDescriptor of Array.from(
      descriptor.getElementsByTagNameNS("*", "KeyDescriptor"),
    )) {
      if (keyDescriptor.getAttribute("use") === "encryption") continue;
      for (const el of Array.from(keyDescriptor.getElementsByTagNameNS("*", "X509Certificate"))) {
        const cert = (el.textContent ?? "").replace(/\s/g, "");
        if (cert && !certs.includes(cert)) certs.push(cert);
      }
    }
  }

  return { ssoUrl, certs, issuer };
}

/** Generate SP metadata XML for the IdP to consume. */
export function generateSPMetadata(config: SAMLConfig): string {
  const certElement = config.spCert
    ? `<md:KeyDescriptor use="signing">
        <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
          <ds:X509Data>
            <ds:X509Certificate>${config.spCert.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")}</ds:X509Certificate>
          </ds:X509Data>
        </ds:KeyInfo>
      </md:KeyDescriptor>`
    : "";

  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${escapeXml(config.entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="${config.signRequests}" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${certElement}
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${escapeXml(config.acsUrl)}"
      index="0"
      isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the node-saml options for a config, with the #520 secure defaults baked
 * in. `cacheProvider` MUST be supplied by the caller (and shared across legs) so
 * `validateInResponseTo` can match the AuthnRequest id against the Response.
 */
export function buildSamlConfig(config: SAMLConfig, cacheProvider: CacheProvider): SamlConfig {
  const samlConfig: SamlConfig = {
    issuer: config.entityId,
    callbackUrl: config.acsUrl,
    entryPoint: config.idpSsoUrl,
    idpCert: config.idpCerts,
    idpIssuer: config.idpIssuer,
    // The assertion is always required to be signed.
    wantAssertionsSigned: true,
    // #520: require the Response envelope to be signed by default. Secure posture
    // unless an admin explicitly opts out for an IdP that cannot sign it.
    wantAuthnResponseSigned: config.requireSignedResponse !== false,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    // #520: InResponseTo / replay protection. `ifPresent` validates the id
    // whenever the Response carries one (SP-initiated logins always do) but does
    // not hard-fail a legitimately IdP-initiated Response that has none. The
    // shared cache makes the id single-use, so a replayed Response is rejected.
    validateInResponseTo: ValidateInResponseTo.ifPresent,
    requestIdExpirationPeriodMs: DEFAULT_REQUEST_ID_EXPIRATION_MS,
    cacheProvider,
    // #520: enforce the assertion NotBefore/NotOnOrAfter window with a small,
    // non-zero clock-skew tolerance.
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
  };
  if (config.signRequests && config.spPrivateKey) {
    samlConfig.privateKey = config.spPrivateKey;
  }
  return samlConfig;
}

/**
 * Memoised SAML instances keyed by a fingerprint of the config. The SAME
 * instance — and therefore the SAME `cacheProvider` — must serve both the
 * AuthnRequest (which saves the request id) and the Response validation (which
 * reads+removes it), or `validateInResponseTo` can never match. Re-saving the
 * config (admin PUT) changes the fingerprint and yields a fresh instance.
 */
const samlInstanceCache = new Map<string, SAML>();

/** Stable fingerprint of the security-relevant config fields. */
function configFingerprint(config: SAMLConfig): string {
  return JSON.stringify([
    config.entityId,
    config.acsUrl,
    config.idpSsoUrl,
    config.idpCerts,
    config.idpIssuer,
    config.signRequests,
    config.requireSignedResponse !== false,
    // Include the key material so a rotated SP key rebuilds the instance, but
    // never log this fingerprint (it is only ever a Map key).
    config.spPrivateKey ?? "",
  ]);
}

/**
 * Get (or lazily build) the shared SAML instance for a config. The request-id
 * cache backend is resolved from `SAML_REQUEST_ID_CACHE_BACKEND` (memory default,
 * postgres for multi-replica) so the id minted on one pod is visible on another.
 */
export function getSAMLInstance(config: SAMLConfig): SAML {
  const key = configFingerprint(config);
  let instance = samlInstanceCache.get(key);
  if (!instance) {
    instance = new SAML(buildSamlConfig(config, resolveSamlRequestIdCache()));
    samlInstanceCache.set(key, instance);
  }
  return instance;
}

/** Test helper — clear the memoised SAML instances. */
export function __resetSAMLInstances(): void {
  samlInstanceCache.clear();
}

/** Validate a SAML response and extract user attributes. */
export async function validateSAMLResponse(
  samlResponse: string,
  config: SAMLConfig,
): Promise<SSOAuthResult> {
  try {
    const saml = getSAMLInstance(config);
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: samlResponse,
    });

    if (!profile) {
      return { success: false, error: "No profile in SAML response" };
    }

    const issuerError = assertionIssuerError(profile.issuer, config.idpIssuer);
    if (issuerError) {
      log.warn("SAML assertion Issuer refused", { error: issuerError });
      return { success: false, error: issuerError };
    }

    const claims = profile as Record<string, unknown>;
    const email =
      claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] ??
      claims.email ??
      profile.nameID ??
      "";
    const displayName =
      claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ??
      claims.displayName ??
      claims.cn ??
      String(email);
    const username =
      claims["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn"] ??
      claims.uid ??
      String(email).split("@")[0] ??
      "";

    const groups = [...new Set(GROUP_CLAIMS.flatMap((claim) => claimValues(claims[claim])))];
    const groupOverage = claimValues(claims[ENTRA_GROUPS_OVERAGE_CLAIM]).length > 0;
    if (groupOverage) {
      log.warn(
        "SAML group overage: the IdP sent a groups link instead of the user's groups, so no " +
          "group mapping can match. In Entra ID, emit 'Groups assigned to the application'.",
        { username: String(username) },
      );
    }

    // MFA (#754, #1552): the signed assertion's AuthnContextClassRef, the
    // `authnclassreference` claim ADFS sends, or Entra's authnmethodsreferences.
    const classRefs = [
      ...authnContextClassRefs(profile.getAssertion?.()),
      ...claimValues(claims.authnContext),
      ...claimValues(claims[AUTHN_CLASS_CLAIM]),
    ];
    const mfaPassed =
      classRefs.some((ref) => MFA_AUTHN_CONTEXTS.has(ref)) ||
      claimValues(claims[AUTHN_METHODS_CLAIM]).some((method) => MFA_AUTHN_METHODS.has(method));

    return {
      success: true,
      user: {
        username: String(username),
        displayName: String(displayName),
        email: String(email),
        groups,
        mfaPassed,
        ...(groupOverage ? { groupOverage } : {}),
        rawClaims: profile as unknown as Record<string, unknown>,
      },
    };
  } catch (err) {
    log.error("SAML response validation failed", { error: err });
    const message = err instanceof Error ? err.message : "SAML validation failed";
    return {
      success: false,
      error: message === NODE_SAML_RESPONSE_SIGNATURE_ERROR ? UNSIGNED_RESPONSE_MESSAGE : message,
    };
  }
}

/**
 * Why the validated assertion's Issuer is refused, or `undefined` (#1555).
 *
 * node-saml 5.1.0 hands `idpIssuer` only to its LogoutRequest/LogoutResponse
 * check, so a login assertion from any issuer whose signature verifies against
 * the pinned certificate was accepted. The comparison is exact, as the IdP sends
 * it: the configured value is the metadata entityID, which for Entra is
 * `https://sts.windows.net/<tenant-id>/` with its trailing slash, the same
 * string as the assertion's Issuer. With no issuer configured there is nothing
 * to compare against, and the signature check stays the only control.
 */
function assertionIssuerError(
  assertionIssuer: string | undefined,
  idpIssuer: string,
): string | undefined {
  if (!idpIssuer) return undefined;
  if (!assertionIssuer) {
    return `The SAML assertion has no Issuer; the configured IdP issuer is "${idpIssuer}"`;
  }
  if (assertionIssuer !== idpIssuer) {
    return `SAML assertion Issuer "${assertionIssuer}" does not match the configured IdP issuer "${idpIssuer}"`;
  }
  return undefined;
}

/** A claim's string values: node-saml gives one value bare and several as an array. */
function claimValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** `<x>text</x>` as xml2js parses it with `explicitCharkey` (node-saml's setting). */
function textOf(node: unknown): string | undefined {
  if (typeof node === "string") return node;
  const text = (node as { _?: unknown } | null)?._;
  return typeof text === "string" ? text.trim() : undefined;
}

/** Child elements named `name` of an xml2js node (prefix already stripped). */
function children(node: unknown, name: string): unknown[] {
  const value = (node as Record<string, unknown> | null)?.[name];
  return Array.isArray(value) ? value : [];
}

/**
 * Every AuthnStatement/AuthnContext/AuthnContextClassRef of the validated
 * assertion. node-saml verifies the assertion but copies none of these onto the
 * profile, so the class ref was never read before #1552.
 */
function authnContextClassRefs(parsedAssertion: unknown): string[] {
  const assertion = (parsedAssertion as { Assertion?: unknown } | null)?.Assertion;
  return children(assertion, "AuthnStatement")
    .flatMap((statement) => children(statement, "AuthnContext"))
    .flatMap((context) => children(context, "AuthnContextClassRef"))
    .map(textOf)
    .filter((ref): ref is string => !!ref);
}

/**
 * Generate an AuthnRequest URL for SP-initiated login.
 *
 * Uses the SHARED memoised SAML instance so the request id node-saml saves here
 * (via the request-id cache) is the same id `validateSAMLResponse` later looks up
 * for InResponseTo / replay validation. With a fresh instance per call the id
 * would be saved into a throwaway cache and never matched.
 */
export async function generateAuthnRequestUrl(config: SAMLConfig): Promise<string> {
  const saml = getSAMLInstance(config);
  const url = await saml.getAuthorizeUrlAsync("", undefined, {});
  return url;
}
