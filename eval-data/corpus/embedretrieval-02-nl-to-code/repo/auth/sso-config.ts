/**
 * SSO configuration persistence — in-memory store with JSON file backing.
 *
 * Epic #748, Issue #751: Group claim → role mapping config + persistence.
 * Stores SSO provider configs encrypted at rest via the vault.
 */
import { ulid } from "ulid";
import { createChildLogger } from "../logger.js";
import type {
  SSOProviderConfig,
  SSOMode,
  GroupRoleMapping,
  SAMLConfig,
  OIDCConfig,
} from "./sso-types.js";
import type { RoleKey } from "@metis/shared";

const log = createChildLogger("sso-config");

/**
 * Opaque placeholder the admin READ API emits in place of a stored secret, and
 * which the admin WRITE path treats as "no change — keep what's stored".
 *
 * Issue #451 (OWASP A09): the admin config-read endpoints (`GET /providers`,
 * `GET /providers/:id`) historically round-tripped raw secrets (OIDC client
 * secret, SAML SP private key, certs, IdP metadata XML) back to the browser.
 * The mask is intentionally a FIXED, non-reversible sentinel — it carries zero
 * bits of the real secret, so it is safe in the response body and in logs.
 *
 * Because the UI may echo whatever it read back on a subsequent save, the WRITE
 * path MUST refuse to persist this sentinel as if it were a real secret (see
 * {@link mergeSecretOnUpdate}) — otherwise a no-op "Save" would overwrite the
 * real stored secret with the placeholder.
 */
export const MASKED_SECRET = "••••••••" as const;

/** In-memory store of SSO provider configs. */
const providers = new Map<string, SSOProviderConfig>();

/**
 * The SAFE, public-facing shape of an SSO provider — exactly what the
 * unauthenticated `/login` page needs to render a button, and nothing more.
 *
 * Issue #429 (OWASP A01/A05): this endpoint is necessarily pre-auth, so it must
 * expose ONLY display info. It must NEVER include client secrets, signing keys,
 * certificates, metadata XML, redirect/discovery URLs, group mappings, or any
 * other internal config. `toPublicProvider()` is the single mapping seam that
 * guarantees this — it constructs a fresh object with a fixed key set rather
 * than spreading/omitting the stored config, so a future field added to
 * `SSOProviderConfig` can never accidentally leak through.
 */
export interface PublicSSOProvider {
  /** Stable provider id (opaque ULID) — used as the button key. */
  id: string;
  /** Human-readable display name shown on the button. */
  label: string;
  /** Provider mode — drives the button icon. */
  type: SSOMode;
  /** SP-initiated login (initiation) URL the button navigates to. */
  loginUrl: string;
}

/** Map an SSO mode to its SP-initiated login (initiation) URL. */
function initiationUrlForMode(mode: SSOMode): string {
  return mode === "saml" ? "/api/auth/saml/login" : "/api/auth/oidc/login";
}

/**
 * Project a stored provider config down to its safe, public display fields.
 *
 * Constructs a brand-new object with a fixed allow-list of keys — secrets in the
 * nested `saml`/`oidc` config are structurally unreachable from the result.
 */
export function toPublicProvider(p: SSOProviderConfig): PublicSSOProvider {
  return {
    id: p.id,
    label: p.name,
    type: p.mode,
    loginUrl: initiationUrlForMode(p.mode),
  };
}

/** Get all enabled SSO providers. */
export function getEnabledProviders(): SSOProviderConfig[] {
  return Array.from(providers.values()).filter((p) => p.enabled);
}

/**
 * Get the SAFE, public-facing list of enabled providers for the login page.
 *
 * This is the only provider accessor the pre-auth `/auth/sso/providers` route
 * should use — it returns `PublicSSOProvider[]`, which by construction cannot
 * carry secrets (see {@link toPublicProvider}).
 */
export function getPublicEnabledProviders(): PublicSSOProvider[] {
  return getEnabledProviders().map(toPublicProvider);
}

/** Get all providers (admin view). */
export function getAllProviders(): SSOProviderConfig[] {
  return Array.from(providers.values());
}

/** Get a single provider by ID. */
export function getProvider(id: string): SSOProviderConfig | undefined {
  return providers.get(id);
}

/** Get an ENABLED provider by mode (used by the login flow). */
export function getProviderByMode(mode: SSOMode): SSOProviderConfig | undefined {
  return Array.from(providers.values()).find((p) => p.mode === mode && p.enabled);
}

/**
 * Get the stored provider for a mode REGARDLESS of `enabled` (single-provider
 * setups). Issue #451 — the admin config-edit endpoints resolve the existing
 * provider by mode when the request carries no `id` (the admin form does not
 * round-trip an id), so a "leave the secret blank to keep it" update finds the
 * stored secret AND updates the existing row instead of creating a duplicate.
 * Must NOT filter on `enabled` so an admin can edit a currently-disabled provider.
 */
export function getStoredProviderByMode(mode: SSOMode): SSOProviderConfig | undefined {
  return Array.from(providers.values()).find((p) => p.mode === mode);
}

/** Create or update a provider config. Returns the full config. */
export function upsertProvider(
  input: Partial<SSOProviderConfig> & { mode: SSOMode; name: string },
): SSOProviderConfig {
  const existing = input.id ? providers.get(input.id) : undefined;
  const now = new Date();
  const config: SSOProviderConfig = {
    id: existing?.id ?? input.id ?? ulid(),
    name: input.name,
    mode: input.mode,
    enabled: input.enabled ?? existing?.enabled ?? false,
    groupMappings: input.groupMappings ?? existing?.groupMappings ?? [],
    defaultRole: input.defaultRole ?? existing?.defaultRole ?? "reader",
    saml: input.saml ?? existing?.saml,
    oidc: input.oidc ?? existing?.oidc,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  providers.set(config.id, config);
  log.info("SSO provider upserted", { id: config.id, mode: config.mode, name: config.name });
  return config;
}

/** Delete a provider config. */
export function deleteProvider(id: string): boolean {
  const deleted = providers.delete(id);
  if (deleted) log.info("SSO provider deleted", { id });
  return deleted;
}

/**
 * SAML config as exposed to the admin UI — every secret is replaced with a
 * boolean `has*` flag. Display/config fields (entityId, acsUrl, idpSsoUrl,
 * idpIssuer, signRequests) round-trip so the admin form can repopulate, but the
 * raw private key, certificates, and metadata XML never leave the server.
 *
 * Issue #451: `spPrivateKey` is a hard secret (never displayed, only re-entered).
 * `spCert`, `idpCerts`, and `idpMetadataXml` are not "secret" in the credential
 * sense but are bulky internal config the browser does not need on read; we
 * surface only presence flags to keep the read surface minimal.
 */
export interface AdminSAMLView {
  entityId: string;
  acsUrl: string;
  idpSsoUrl: string;
  idpIssuer: string;
  signRequests: boolean;
  /**
   * Epic #517 (#520): whether the SAML Response envelope must be signed. Surfaced
   * (not a secret) so the admin form shows the posture; defaults to the secure
   * `true` for legacy configs stored before #520.
   */
  requireSignedResponse: boolean;
  /** True when SP private key (PEM) is stored — value is never returned. */
  hasSpPrivateKey: boolean;
  /** True when SP certificate (PEM) is stored — value is never returned. */
  hasSpCert: boolean;
  /** True when one or more IdP certificates are stored — values never returned. */
  hasIdpCerts: boolean;
  /** True when IdP metadata XML is stored — raw XML is never returned. */
  hasIdpMetadataXml: boolean;
}

/**
 * OIDC config as exposed to the admin UI. `clientSecret` is short and sensitive,
 * so we expose ONLY a boolean `hasClientSecret` (no masked tail — a last-4 of a
 * short secret materially weakens it). Non-secret fields round-trip for the form.
 */
export interface AdminOIDCView {
  discoveryUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  pkceEnabled: boolean;
  /** True when a client secret is stored — the raw value is never returned. */
  hasClientSecret: boolean;
}

/**
 * The SAFE admin-facing shape of an SSO provider. Same top-level metadata as the
 * stored config, but the nested `saml`/`oidc` blocks are projected through
 * {@link toAdminSamlView}/{@link toAdminOidcView} so NO secret is reachable.
 */
export interface AdminSSOProviderView {
  id: string;
  name: string;
  mode: SSOMode;
  enabled: boolean;
  groupMappings: GroupRoleMapping[];
  defaultRole: RoleKey;
  saml?: AdminSAMLView;
  oidc?: AdminOIDCView;
  createdAt: Date;
  updatedAt: Date;
}

/** Project a stored SAML config to its secret-free admin view. */
function toAdminSamlView(s: SAMLConfig): AdminSAMLView {
  return {
    entityId: s.entityId,
    acsUrl: s.acsUrl,
    idpSsoUrl: s.idpSsoUrl,
    idpIssuer: s.idpIssuer,
    signRequests: s.signRequests,
    // Default legacy (pre-#520) configs to the secure posture on read.
    requireSignedResponse: s.requireSignedResponse !== false,
    hasSpPrivateKey: !!s.spPrivateKey,
    hasSpCert: !!s.spCert,
    hasIdpCerts: Array.isArray(s.idpCerts) && s.idpCerts.length > 0,
    hasIdpMetadataXml: !!s.idpMetadataXml,
  };
}

/** Project a stored OIDC config to its secret-free admin view. */
function toAdminOidcView(o: OIDCConfig): AdminOIDCView {
  return {
    discoveryUrl: o.discoveryUrl,
    clientId: o.clientId,
    redirectUri: o.redirectUri,
    scopes: o.scopes,
    pkceEnabled: o.pkceEnabled,
    hasClientSecret: !!o.clientSecret,
  };
}

/**
 * Project a stored provider config down to its SAFE admin-config view.
 *
 * Issue #451 (OWASP A09): the admin config-read API must show whether a provider
 * is configured/enabled and surface non-secret config for the form, but it must
 * NEVER round-trip stored secrets to the browser. Like {@link toPublicProvider},
 * this builds a brand-new object with a fixed key set — secrets in the nested
 * `saml`/`oidc` blocks are structurally unreachable from the result, so a future
 * secret field added to those interfaces cannot accidentally leak through.
 */
export function toAdminProviderView(p: SSOProviderConfig): AdminSSOProviderView {
  return {
    id: p.id,
    name: p.name,
    mode: p.mode,
    enabled: p.enabled,
    groupMappings: p.groupMappings,
    defaultRole: p.defaultRole,
    saml: p.saml ? toAdminSamlView(p.saml) : undefined,
    oidc: p.oidc ? toAdminOidcView(p.oidc) : undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Map all providers to the SAFE admin-config view (no secrets). */
export function getAllProvidersForAdmin(): AdminSSOProviderView[] {
  return getAllProviders().map(toAdminProviderView);
}

/** Map a single provider to the SAFE admin-config view, or undefined if absent. */
export function getProviderForAdmin(id: string): AdminSSOProviderView | undefined {
  const p = getProvider(id);
  return p ? toAdminProviderView(p) : undefined;
}

/**
 * Decide which secret value to persist on an UPDATE.
 *
 * Issue #451 — CRITICAL guard. The admin READ API masks secrets, so the UI never
 * sees the real value. On a subsequent "Save" the UI may send back an empty
 * field (user left it blank) or, in a careless implementation, the mask sentinel
 * itself. Either case means "the admin did not change the secret" — we MUST keep
 * the existing stored value rather than wiping it.
 *
 * Rules (applied in order):
 *   - incoming is `undefined`/`null`/empty/whitespace → keep `existing`.
 *   - incoming, trimmed, equals {@link MASKED_SECRET} → keep `existing` (refuse
 *     to ever persist the placeholder as a real secret).
 *   - otherwise → the admin typed a real new value → use `incoming` (verbatim,
 *     un-trimmed: a secret may legitimately contain leading/trailing spaces).
 *
 * @param incoming  the value submitted by the admin (may be omitted/blank/mask).
 * @param existing  the currently stored secret (may be undefined if never set).
 * @returns the value that should be stored.
 */
export function mergeSecretOnUpdate(
  incoming: string | undefined | null,
  existing: string | undefined,
): string | undefined {
  if (incoming == null) return existing;
  const trimmed = incoming.trim();
  if (trimmed.length === 0) return existing;
  if (trimmed === MASKED_SECRET) return existing;
  return incoming;
}

/** Validate that group mappings include at least one admin mapping. */
export function validateGroupMappings(mappings: GroupRoleMapping[]): string | null {
  if (mappings.length === 0) return null; // No mappings is valid (uses default role)
  const hasAdmin = mappings.some((m) => m.role === "admin");
  if (!hasAdmin) {
    return "At least one group mapping must resolve to the 'admin' role";
  }
  return null;
}

/** Resolve a user's role from group claims using provider mappings. */
export function resolveRoleFromGroups(
  groups: string[],
  mappings: GroupRoleMapping[],
  defaultRole: RoleKey,
): RoleKey {
  if (mappings.length === 0 || groups.length === 0) return defaultRole;

  // Return the highest-privilege role matched
  const roleHierarchy: Record<RoleKey, number> = {
    reader: 10,
    developer: 20,
    coordinator: 30,
    admin: 99,
  };

  let bestRole = defaultRole;
  let bestLevel = roleHierarchy[defaultRole];

  for (const mapping of mappings) {
    if (groups.includes(mapping.claimValue)) {
      const level = roleHierarchy[mapping.role];
      if (level > bestLevel) {
        bestRole = mapping.role;
        bestLevel = level;
      }
    }
  }
  return bestRole;
}

/** Test helper — clears all providers. */
export function __resetProviders(): void {
  providers.clear();
}
