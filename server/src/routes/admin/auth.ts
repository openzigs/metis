/**
 * Admin SSO configuration routes — /api/admin/auth.
 *
 * Epic #748, Issue #756: Admin UI configuration for SAML, OIDC, SCIM, mappings.
 * RBAC: admin only.
 */
import { Router, type Request, type Response } from "express";
import type { ApiResponse, AuthPayload } from "@metis/shared";
import { requireAuth } from "../../middleware/auth.js";
import { requireRole } from "../../middleware/require-role.js";
import { audit } from "../../lib/audit/audit-service.js";
import {
  getAllProvidersForAdmin,
  getProvider,
  getProviderForAdmin,
  getStoredProviderByMode,
  upsertProvider,
  deleteProvider,
  validateGroupMappings,
  mergeSecretOnUpdate,
  toAdminProviderView,
} from "../../lib/auth/sso-config.js";
import { parseIdPMetadata } from "../../lib/auth/saml-provider.js";
import {
  getLDAPConfigForUI,
  setLDAPConfig,
  testLDAPConnection,
  getLDAPConfig,
  type LDAPConfig,
} from "../../lib/auth/ldap-provider.js";
import { rotateScimToken } from "../scim.js";
import { AppError } from "../../middleware/error-handler.js";
import { authReconciliationRouter } from "./auth-reconciliation.js";

export function adminAuthRouter(): Router {
  const r = Router();

  // Reconciliation authorizes durable DB state inside its transaction, not JWT roles.
  r.use("/role-reconciliation", authReconciliationRouter());

  /** Coerce Express v5 params to string. */
  const p = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : (v ?? ""));

  // All routes require admin role
  r.use(requireAuth, requireRole("admin"));

  // --- List all SSO providers ---
  // Issue #451 (OWASP A09): returns the SAFE admin view — stored secrets (OIDC
  // client secret, SAML SP private key, certs, IdP metadata XML) are replaced
  // with `has*` presence flags and never round-trip to the browser.
  r.get("/providers", (_req: Request, res: Response) => {
    const providers = getAllProvidersForAdmin();
    const body: ApiResponse = { success: true, data: { providers } };
    res.json(body);
  });

  // --- Get a single provider ---
  // Issue #451: same secret-free admin view as the list endpoint.
  r.get("/providers/:id", (req: Request, res: Response) => {
    const provider = getProviderForAdmin(p(req.params.id));
    if (!provider) {
      throw new AppError(404, "NOT_FOUND", "Provider not found");
    }
    const body: ApiResponse = { success: true, data: { provider } };
    res.json(body);
  });

  // --- Create/update SAML provider ---
  r.put("/providers/saml", async (req: Request, res: Response) => {
    const {
      id,
      name,
      enabled,
      entityId,
      acsUrl,
      idpMetadataXml,
      signRequests,
      requireSignedResponse,
      spPrivateKey,
      spCert,
      groupMappings,
      defaultRole,
    } = req.body;

    if (!name || !entityId || !acsUrl) {
      throw new AppError(400, "VALIDATION_ERROR", "name, entityId, and acsUrl are required");
    }

    // Issue #451: the READ API masks stored SAML secrets and omits raw IdP
    // metadata XML, so an update may legitimately omit these. Keep existing
    // values when the incoming field is blank/omitted/equal-to-the-mask.
    // Resolve by id when supplied, else by mode — a no-id PUT updates the single
    // SAML provider rather than creating a duplicate (#451).
    const existing = id ? getProvider(id) : getStoredProviderByMode("saml");
    const existingSaml = existing?.saml;
    const resolvedSpPrivateKey = mergeSecretOnUpdate(spPrivateKey, existingSaml?.spPrivateKey);
    const resolvedSpCert = mergeSecretOnUpdate(spCert, existingSaml?.spCert);

    // Parse IdP metadata if provided, otherwise keep the previously parsed values.
    let idpSsoUrl = existingSaml?.idpSsoUrl ?? "";
    let idpCerts: string[] = existingSaml?.idpCerts ?? [];
    let idpIssuer = existingSaml?.idpIssuer ?? "";
    let resolvedMetadataXml = existingSaml?.idpMetadataXml ?? "";
    if (idpMetadataXml && idpMetadataXml.trim().length > 0) {
      const parsed = parseIdPMetadata(idpMetadataXml);
      idpSsoUrl = parsed.ssoUrl;
      idpCerts = parsed.certs;
      idpIssuer = parsed.issuer;
      resolvedMetadataXml = idpMetadataXml;
    }

    // Validate group mappings
    if (groupMappings) {
      const error = validateGroupMappings(groupMappings);
      if (error) {
        throw new AppError(400, "VALIDATION_ERROR", error);
      }
    }

    const provider = upsertProvider({
      id: existing?.id ?? id,
      name,
      mode: "saml",
      enabled: enabled ?? false,
      groupMappings,
      defaultRole,
      saml: {
        entityId,
        acsUrl,
        idpMetadataXml: resolvedMetadataXml,
        idpSsoUrl,
        idpCerts,
        idpIssuer,
        signRequests: signRequests ?? false,
        // Epic #517 (#520): default the Response-signing requirement to the
        // SECURE posture (true). An admin must explicitly send `false` to opt a
        // single IdP out (assertion signing still applies). `existingSaml` is
        // preserved on an update that omits the field so a save doesn't silently
        // relax it. Coerced to a strict boolean so a stray string can't enable
        // the insecure path.
        requireSignedResponse:
          typeof requireSignedResponse === "boolean"
            ? requireSignedResponse
            : (existingSaml?.requireSignedResponse ?? true),
        spPrivateKey: resolvedSpPrivateKey,
        spCert: resolvedSpCert,
      },
    });

    audit({
      actor: { id: (req.user as AuthPayload).userId },
      action: "admin.sso.provider.saved",
      target: { type: "sso-provider", id: provider.id },
      metadata: { mode: "saml", name },
    });

    // Issue #451: never echo stored secrets back, even on the write response.
    const body: ApiResponse = { success: true, data: { provider: toAdminProviderView(provider) } };
    res.json(body);
  });

  // --- Create/update OIDC provider ---
  r.put("/providers/oidc", async (req: Request, res: Response) => {
    const {
      id,
      name,
      enabled,
      discoveryUrl,
      clientId,
      clientSecret,
      redirectUri,
      scopes,
      groupMappings,
      defaultRole,
    } = req.body;

    // Issue #451: resolve the secret to persist BEFORE validation. Since the
    // READ API masks the stored client secret, an update may legitimately omit
    // it (or send back the mask) — in that case we keep the existing stored
    // value rather than wiping it. The secret is only "required" when there is
    // no existing secret to fall back to (i.e. first-time configuration).
    // Resolve the existing provider by id when supplied, else by mode — the
    // admin form does not round-trip an id, so a no-id PUT is an UPDATE of the
    // single OIDC provider, not a create (#451). This makes "leave the secret
    // blank to keep it" work AND prevents a duplicate provider on every save.
    const existing = id ? getProvider(id) : getStoredProviderByMode("oidc");
    const resolvedClientSecret = mergeSecretOnUpdate(clientSecret, existing?.oidc?.clientSecret);

    if (!name || !discoveryUrl || !clientId || !resolvedClientSecret || !redirectUri) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "name, discoveryUrl, clientId, clientSecret, and redirectUri are required",
      );
    }

    // Validate group mappings
    if (groupMappings) {
      const error = validateGroupMappings(groupMappings);
      if (error) {
        throw new AppError(400, "VALIDATION_ERROR", error);
      }
    }

    const provider = upsertProvider({
      id: existing?.id ?? id,
      name,
      mode: "oidc",
      enabled: enabled ?? false,
      groupMappings,
      defaultRole,
      oidc: {
        discoveryUrl,
        clientId,
        clientSecret: resolvedClientSecret,
        redirectUri,
        scopes: scopes ?? ["openid", "profile", "email"],
        pkceEnabled: true,
      },
    });

    audit({
      actor: { id: (req.user as AuthPayload).userId },
      action: "admin.sso.provider.saved",
      target: { type: "sso-provider", id: provider.id },
      metadata: { mode: "oidc", name },
    });

    // Issue #451: never echo stored secrets back, even on the write response.
    const body: ApiResponse = { success: true, data: { provider: toAdminProviderView(provider) } };
    res.json(body);
  });

  // --- Delete a provider ---
  r.delete("/providers/:id", (req: Request, res: Response) => {
    const deleted = deleteProvider(p(req.params.id));
    if (!deleted) {
      throw new AppError(404, "NOT_FOUND", "Provider not found");
    }

    audit({
      actor: { id: (req.user as AuthPayload).userId },
      action: "admin.sso.provider.deleted",
      target: { type: "sso-provider", id: p(req.params.id) },
    });

    const body: ApiResponse = { success: true, data: { message: "Provider deleted" } };
    res.json(body);
  });

  // --- Rotate SCIM token ---
  r.post("/scim/rotate-token", (req: Request, res: Response) => {
    const newToken = rotateScimToken();

    audit({
      actor: { id: (req.user as AuthPayload).userId },
      action: "admin.scim.token.rotated",
      target: { type: "scim-token", id: "current" },
    });

    // Token shown once only (AC from #756)
    const body: ApiResponse = { success: true, data: { token: newToken } };
    res.json(body);
  });

  // --- Get LDAP config (sanitized, no password) ---
  r.get("/ldap", (_req: Request, res: Response) => {
    const config = getLDAPConfigForUI();
    const body: ApiResponse = { success: true, data: { ldap: config } };
    res.json(body);
  });

  // --- Save LDAP config ---
  r.put("/ldap", (req: Request, res: Response) => {
    const {
      url,
      baseDN,
      bindDN,
      bindPassword,
      userSearchBase,
      searchFilter,
      groupMappings,
      defaultRole,
      tlsSkipVerify,
      connectionTimeout,
    } = req.body;

    if (!url || !bindDN) {
      throw new AppError(400, "VALIDATION_ERROR", "url and bindDN are required");
    }

    // Merge with existing config to preserve password if not re-sent
    const existing = getLDAPConfig();
    const config: LDAPConfig = {
      url,
      baseDN: baseDN ?? existing.baseDN,
      bindDN,
      bindPassword: bindPassword || existing.bindPassword,
      userSearchBase: userSearchBase ?? existing.userSearchBase,
      searchFilter: searchFilter ?? existing.searchFilter,
      groupMappings: groupMappings ?? existing.groupMappings,
      defaultRole: defaultRole ?? existing.defaultRole,
      tlsSkipVerify: tlsSkipVerify ?? existing.tlsSkipVerify,
      connectionTimeout: connectionTimeout ?? existing.connectionTimeout,
    };

    setLDAPConfig(config);

    audit({
      actor: { id: (req.user as AuthPayload).userId },
      action: "admin.ldap.config.saved",
      target: { type: "ldap-config", id: "current" },
      metadata: { url },
    });

    const body: ApiResponse = { success: true, data: { message: "LDAP config saved" } };
    res.json(body);
  });

  // --- Test LDAP connection ---
  r.post("/ldap/test", async (req: Request, res: Response) => {
    const { url, baseDN, bindDN, bindPassword, tlsSkipVerify, connectionTimeout } = req.body;

    // Use submitted values for test, falling back to stored config
    const existing = getLDAPConfig();
    const testConfig: LDAPConfig = {
      url: url ?? existing.url,
      baseDN: baseDN ?? existing.baseDN,
      bindDN: bindDN ?? existing.bindDN,
      bindPassword: bindPassword || existing.bindPassword,
      userSearchBase: existing.userSearchBase,
      searchFilter: existing.searchFilter,
      groupMappings: existing.groupMappings,
      defaultRole: existing.defaultRole,
      tlsSkipVerify: tlsSkipVerify ?? existing.tlsSkipVerify,
      connectionTimeout: connectionTimeout ?? existing.connectionTimeout,
    };

    const error = await testLDAPConnection(testConfig);
    if (error) {
      const body: ApiResponse = { success: false, error: { code: "LDAP_ERROR", message: error } };
      res.status(400).json(body);
      return;
    }

    const body: ApiResponse = { success: true, data: { message: "LDAP connection successful" } };
    res.json(body);
  });

  return r;
}
