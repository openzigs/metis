/**
 * Smallest IdP metadata the admin SAML save accepts.
 *
 * Since #1540 (PR #1546) `PUT /api/admin/auth/providers/saml` refuses metadata
 * that yields no SingleSignOnService URL or no X509 certificate with a 400
 * ("IdP metadata has no SingleSignOnService URL or no X509 certificate"), so
 * a bare `<EntityDescriptor></EntityDescriptor>` no longer saves. This is the
 * minimal realistic document: one IDPSSODescriptor with a Redirect-binding SSO
 * service and a signing certificate. The certificate body is a placeholder —
 * nothing in these specs completes a SAML login against it.
 */
export const MINIMAL_IDP_METADATA_XML = [
  '<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"',
  ' xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.com">',
  '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">',
  '<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>',
  "<ds:X509Certificate>MIIC-E2E-PLACEHOLDER-CERT</ds:X509Certificate>",
  "</ds:X509Data></ds:KeyInfo></md:KeyDescriptor>",
  '<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"',
  ' Location="https://idp.example.com/sso/saml"/>',
  "</md:IDPSSODescriptor>",
  "</md:EntityDescriptor>",
].join("");
