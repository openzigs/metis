/**
 * #1552 — Microsoft Entra ID-shaped SAML fixtures.
 *
 * Every shape here is taken from Microsoft Learn, not from memory:
 *   - claim URIs and the overage claim: "SAML 2.0 token claims reference"
 *     (learn.microsoft.com/entra/identity-platform/reference-saml-tokens);
 *   - `authnmethodsreferences` and the AuthnContextClassRef values: "Single
 *     sign-on SAML protocol" (learn.microsoft.com/entra/identity-platform/single-sign-on-saml-protocol);
 *   - the metadata document: "Microsoft Entra federation metadata"
 *     (learn.microsoft.com/entra/identity-platform/federation-metadata).
 *
 * The tenant id, object ids and group ids are synthetic, and the signing
 * identity is the throwaway key `getTestSigningKey` mints at runtime.
 */
import { SignedXml } from "xml-crypto";

import type { TestSigningKey } from "./saml-test-helpers.js";

/** A synthetic tenant id (never a real tenant). */
export const ENTRA_TENANT_ID = "00000000-1552-4000-8000-00000000e17a";
/** What Entra sets as Issuer and as the metadata entityID. */
export const ENTRA_ISSUER = `https://sts.windows.net/${ENTRA_TENANT_ID}/`;
/** The tenant's SAML endpoint (HTTP-Redirect binding). */
export const ENTRA_SSO_URL = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/saml2`;

export const ENTRA_CLAIM = {
  objectId: "http://schemas.microsoft.com/identity/claims/objectidentifier",
  tenantId: "http://schemas.microsoft.com/identity/claims/tenantid",
  displayName: "http://schemas.microsoft.com/identity/claims/displayname",
  emailAddress: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  groups: "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups",
  role: "http://schemas.microsoft.com/ws/2008/06/identity/claims/role",
  groupsLink: "http://schemas.microsoft.com/claims/groups.link",
  authnMethodsReferences: "http://schemas.microsoft.com/claims/authnmethodsreferences",
} as const;

export const ENTRA_AMR = {
  password: "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password",
  multipleAuthn: "http://schemas.microsoft.com/claims/multipleauthn",
} as const;

/** AuthnContextClassRef values Entra sends (full URIs). */
export const ENTRA_CLASS_REF = {
  password: "urn:oasis:names:tc:SAML:2.0:ac:classes:Password",
  mobileTwoFactorContract: "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
  x509: "urn:oasis:names:tc:SAML:2.0:ac:classes:X509",
} as const;

/** Synthetic group object ids. */
export const ENTRA_GROUP = {
  metisAdmins: "5a1c0d0e-1552-4a00-9000-0000000000ad",
  metisMembers: "5a1c0d0e-1552-4a00-9000-00000000006d",
  unrelated: "5a1c0d0e-1552-4a00-9000-000000000999",
} as const;

export interface EntraUser {
  upn: string;
  objectId: string;
  displayName: string;
  groups?: string[];
  roles?: string[];
  /** `true` adds `multipleauthn` to authnmethodsreferences. */
  mfa?: boolean;
  /** Replace `groups` with the overage link, as Entra does past 150 groups. */
  groupOverage?: boolean;
}

/** The AttributeStatement Entra sends for a user (claim URI -> value or values). */
export function entraAttributes(user: EntraUser): Record<string, string | string[]> {
  const attrs: Record<string, string | string[]> = {
    [ENTRA_CLAIM.tenantId]: ENTRA_TENANT_ID,
    [ENTRA_CLAIM.objectId]: user.objectId,
    [ENTRA_CLAIM.displayName]: user.displayName,
    [ENTRA_CLAIM.emailAddress]: user.upn,
    [ENTRA_CLAIM.name]: user.upn,
    [ENTRA_CLAIM.authnMethodsReferences]: user.mfa
      ? [ENTRA_AMR.password, ENTRA_AMR.multipleAuthn]
      : [ENTRA_AMR.password],
  };
  if (user.groupOverage) {
    attrs[ENTRA_CLAIM.groupsLink] =
      `https://graph.windows.net/${ENTRA_TENANT_ID}/users/${user.objectId}/getMemberObjects`;
  } else if (user.groups?.length) {
    attrs[ENTRA_CLAIM.groups] = user.groups;
  }
  if (user.roles?.length) attrs[ENTRA_CLAIM.role] = user.roles;
  return attrs;
}

const keyDescriptor = (certBody: string): string =>
  `<KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${certBody}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`;

/**
 * Federation Metadata XML in Entra's shape: a signed EntityDescriptor whose
 * entityID is `https://sts.windows.net/<tenant>/`, two WS-Federation
 * `RoleDescriptor`s typed with `xsi:type` before the `IDPSSODescriptor`, and
 * the signing certificate repeated in each section. The document signature's
 * KeyInfo carries `metadataSignerCertBody` (Entra's is the same certificate;
 * a test may pass a different one to prove it is not trusted for tokens).
 */
export function buildEntraFederationMetadata(
  key: TestSigningKey,
  metadataSignerCertBody: string = key.certificateBody,
): string {
  const cert = key.certificateBody;
  const unsigned = `<?xml version="1.0" encoding="utf-8"?><EntityDescriptor ID="_e17a1552-0000-4000-8000-000000000001" entityID="${ENTRA_ISSUER}" xmlns="urn:oasis:names:tc:SAML:2.0:metadata"><RoleDescriptor xsi:type="fed:SecurityTokenServiceType" protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706">${keyDescriptor(cert)}<fed:ClaimTypesOffered><auth:ClaimType Uri="${ENTRA_CLAIM.name}" xmlns:auth="http://docs.oasis-open.org/wsfed/authorization/200706"><auth:DisplayName>Name</auth:DisplayName></auth:ClaimType></fed:ClaimTypesOffered><fed:SecurityTokenServiceEndpoint><wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>https://login.microsoftonline.com/${ENTRA_TENANT_ID}/wsfed</wsa:Address></wsa:EndpointReference></fed:SecurityTokenServiceEndpoint><fed:PassiveRequestorEndpoint><wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>https://login.microsoftonline.com/${ENTRA_TENANT_ID}/wsfed</wsa:Address></wsa:EndpointReference></fed:PassiveRequestorEndpoint></RoleDescriptor><RoleDescriptor xsi:type="fed:ApplicationServiceType" protocolSupportEnumeration="http://docs.oasis-open.org/wsfed/federation/200706" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:fed="http://docs.oasis-open.org/wsfed/federation/200706">${keyDescriptor(cert)}<fed:TargetScopes><wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>https://sts.windows.net/${ENTRA_TENANT_ID}/</wsa:Address></wsa:EndpointReference></fed:TargetScopes><fed:ApplicationServiceEndpoint><wsa:EndpointReference xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:Address>https://login.microsoftonline.com/${ENTRA_TENANT_ID}/wsfed</wsa:Address></wsa:EndpointReference></fed:ApplicationServiceEndpoint></RoleDescriptor><IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${keyDescriptor(cert)}<SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ENTRA_SSO_URL}"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ENTRA_SSO_URL}"/><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${ENTRA_SSO_URL}"/></IDPSSODescriptor></EntityDescriptor>`;

  const sig = new SignedXml({
    privateKey: key.privateKey,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${metadataSignerCertBody}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: "//*[local-name(.)='EntityDescriptor']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(unsigned, {
    prefix: "ds",
    location: { reference: "//*[local-name(.)='EntityDescriptor']", action: "prepend" },
  });
  return sig.getSignedXml();
}
