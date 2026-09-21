/**
 * SSO provider types — shared across SAML, OIDC, and SCIM.
 *
 * Epic #748: SSO Providers — SAML 2.0 + OIDC + SCIM 2.0
 */
import type { RoleKey } from "@metis/shared";

/** Supported SSO authentication modes. */
export type SSOMode = "saml" | "oidc";

/** A mapping from an IdP group claim to a METIS role. */
export interface GroupRoleMapping {
  claimValue: string;
  role: RoleKey;
}

/** SAML 2.0 provider configuration. */
export interface SAMLConfig {
  /** SP entity ID (audience restriction). */
  entityId: string;
  /** SP Assertion Consumer Service URL. */
  acsUrl: string;
  /** IdP metadata XML (raw). */
  idpMetadataXml: string;
  /** Parsed IdP SSO URL from metadata. */
  idpSsoUrl: string;
  /** Parsed IdP certificate(s) from metadata. */
  idpCerts: string[];
  /** IdP issuer / entity ID. */
  idpIssuer: string;
  /** Whether to sign AuthnRequests. */
  signRequests: boolean;
  /** SP private key for signing (PEM). */
  spPrivateKey?: string;
  /** SP certificate for signing (PEM). */
  spCert?: string;
  /**
   * Epic #517 (#520) — require the SAML *Response* envelope (not just the
   * assertion) to be signed. Defaults to `true` (the secure posture) when
   * omitted; an admin may set it to `false` ONLY for an IdP that cannot sign the
   * response envelope, in which case assertion signing
   * (`wantAssertionsSigned: true`, always on) still protects the assertion. See
   * docs/auth/saml.md for the threat-model rationale.
   */
  requireSignedResponse?: boolean;
}

/** OIDC provider configuration. */
export interface OIDCConfig {
  /** OpenID Connect discovery URL (e.g. https://idp.example.com/.well-known/openid-configuration). */
  discoveryUrl: string;
  /** Client ID registered with the IdP. */
  clientId: string;
  /** Client secret. */
  clientSecret: string;
  /** Redirect URI for authorization code flow. */
  redirectUri: string;
  /** Scopes to request (default: openid profile email). */
  scopes: string[];
  /** Whether PKCE is enabled (always true in this impl). */
  pkceEnabled: boolean;
}

/** Unified SSO provider configuration stored in the database. */
export interface SSOProviderConfig {
  id: string;
  name: string;
  mode: SSOMode;
  enabled: boolean;
  /** Group claim → role mappings. */
  groupMappings: GroupRoleMapping[];
  /** Default role when no group claim matches. */
  defaultRole: RoleKey;
  /** SAML-specific config (present when mode=saml). */
  saml?: SAMLConfig;
  /** OIDC-specific config (present when mode=oidc). */
  oidc?: OIDCConfig;
  createdAt: Date;
  updatedAt: Date;
}

/** Result of an SSO authentication flow. */
export interface SSOAuthResult {
  success: boolean;
  user?: {
    username: string;
    displayName: string;
    email: string;
    groups: string[];
    /** Whether MFA was confirmed via amr/AuthnContext. */
    mfaPassed: boolean;
    /** Raw claims from the IdP. */
    rawClaims: Record<string, unknown>;
  };
  error?: string;
}

/** SCIM 2.0 resource types. */
export interface SCIMUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName: string;
  name?: {
    formatted?: string;
    familyName?: string;
    givenName?: string;
  };
  displayName?: string;
  emails?: Array<{ value: string; type?: string; primary?: boolean }>;
  active?: boolean;
  groups?: Array<{ value: string; display?: string }>;
  meta?: {
    resourceType: string;
    created?: string;
    lastModified?: string;
    location?: string;
  };
}

export interface SCIMGroup {
  schemas: string[];
  id?: string;
  externalId?: string;
  displayName: string;
  members?: Array<{ value: string; display?: string }>;
  meta?: {
    resourceType: string;
    created?: string;
    lastModified?: string;
    location?: string;
  };
}

export interface SCIMListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface SCIMPatchOp {
  schemas: string[];
  Operations: Array<{
    op: "add" | "remove" | "replace";
    path?: string;
    value?: unknown;
  }>;
}

export interface SCIMError {
  schemas: string[];
  status: string;
  detail: string;
}

/** Service provider config for SCIM discovery. */
export interface SCIMServiceProviderConfig {
  schemas: string[];
  documentationUri: string;
  patch: { supported: boolean };
  bulk: { supported: boolean; maxOperations: number; maxPayloadSize: number };
  filter: { supported: boolean; maxResults: number };
  changePassword: { supported: boolean };
  sort: { supported: boolean };
  etag: { supported: boolean };
  authenticationSchemes: Array<{
    type: string;
    name: string;
    description: string;
  }>;
}
