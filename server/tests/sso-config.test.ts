/**
 * Tests for SSO configuration management.
 * Epic #748, Issues #749, #750, #751.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  getEnabledProviders,
  getAllProviders,
  getProvider,
  getProviderByMode,
  upsertProvider,
  deleteProvider,
  validateGroupMappings,
  resolveRoleFromGroups,
  toAdminProviderView,
  getAllProvidersForAdmin,
  getProviderForAdmin,
  mergeSecretOnUpdate,
  MASKED_SECRET,
  __resetProviders,
} from "../src/lib/auth/sso-config.js";

describe("SSO Config Store", () => {
  beforeEach(() => {
    __resetProviders();
  });

  describe("upsertProvider", () => {
    it("creates a new SAML provider", () => {
      const p = upsertProvider({ name: "Okta", mode: "saml" });
      expect(p.id).toBeTruthy();
      expect(p.name).toBe("Okta");
      expect(p.mode).toBe("saml");
      expect(p.enabled).toBe(false);
      expect(p.defaultRole).toBe("reader");
    });

    it("creates a new OIDC provider", () => {
      const p = upsertProvider({ name: "Azure AD", mode: "oidc", enabled: true });
      expect(p.mode).toBe("oidc");
      expect(p.enabled).toBe(true);
    });

    it("updates an existing provider by id", () => {
      const created = upsertProvider({ name: "Okta", mode: "saml" });
      const updated = upsertProvider({
        id: created.id,
        name: "Okta v2",
        mode: "saml",
        enabled: true,
      });
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe("Okta v2");
      expect(updated.enabled).toBe(true);
      expect(updated.createdAt).toEqual(created.createdAt);
    });

    it("preserves existing fields when partially updating", () => {
      const created = upsertProvider({
        name: "Test",
        mode: "oidc",
        groupMappings: [{ claimValue: "admins", role: "admin" }],
        defaultRole: "developer",
      });
      const updated = upsertProvider({ id: created.id, name: "Test Updated", mode: "oidc" });
      expect(updated.groupMappings).toEqual([{ claimValue: "admins", role: "admin" }]);
      expect(updated.defaultRole).toBe("developer");
    });
  });

  describe("getEnabledProviders", () => {
    it("returns only enabled providers", () => {
      upsertProvider({ name: "Enabled", mode: "saml", enabled: true });
      upsertProvider({ name: "Disabled", mode: "oidc", enabled: false });
      const enabled = getEnabledProviders();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe("Enabled");
    });
  });

  describe("getAllProviders", () => {
    it("returns all providers regardless of enabled status", () => {
      upsertProvider({ name: "A", mode: "saml", enabled: true });
      upsertProvider({ name: "B", mode: "oidc", enabled: false });
      expect(getAllProviders()).toHaveLength(2);
    });
  });

  describe("getProvider", () => {
    it("returns a provider by ID", () => {
      const p = upsertProvider({ name: "Test", mode: "saml" });
      expect(getProvider(p.id)?.name).toBe("Test");
    });

    it("returns undefined for unknown ID", () => {
      expect(getProvider("nonexistent")).toBeUndefined();
    });
  });

  describe("getProviderByMode", () => {
    it("returns an enabled provider by mode", () => {
      upsertProvider({ name: "SAML", mode: "saml", enabled: true });
      upsertProvider({ name: "OIDC", mode: "oidc", enabled: false });
      expect(getProviderByMode("saml")?.name).toBe("SAML");
      expect(getProviderByMode("oidc")).toBeUndefined();
    });
  });

  describe("deleteProvider", () => {
    it("removes a provider", () => {
      const p = upsertProvider({ name: "Delete me", mode: "saml" });
      expect(deleteProvider(p.id)).toBe(true);
      expect(getProvider(p.id)).toBeUndefined();
    });

    it("returns false for unknown ID", () => {
      expect(deleteProvider("nope")).toBe(false);
    });
  });
});

describe("validateGroupMappings", () => {
  it("returns null for empty mappings (valid — uses default role)", () => {
    expect(validateGroupMappings([])).toBeNull();
  });

  it("returns null when at least one admin mapping exists", () => {
    expect(
      validateGroupMappings([
        { claimValue: "admins", role: "admin" },
        { claimValue: "devs", role: "developer" },
      ]),
    ).toBeNull();
  });

  it("returns error when no admin mapping exists", () => {
    const result = validateGroupMappings([
      { claimValue: "devs", role: "developer" },
      { claimValue: "readers", role: "reader" },
    ]);
    expect(result).toContain("admin");
  });
});

describe("resolveRoleFromGroups", () => {
  const mappings = [
    { claimValue: "metis-admins", role: "admin" as const },
    { claimValue: "metis-coordinators", role: "coordinator" as const },
    { claimValue: "metis-devs", role: "developer" as const },
  ];

  it("returns default role when no groups match", () => {
    expect(resolveRoleFromGroups(["unrelated"], mappings, "reader")).toBe("reader");
  });

  it("returns default role when groups array is empty", () => {
    expect(resolveRoleFromGroups([], mappings, "reader")).toBe("reader");
  });

  it("returns the matched role", () => {
    expect(resolveRoleFromGroups(["metis-devs"], mappings, "reader")).toBe("developer");
  });

  it("returns the highest-privilege role when multiple groups match", () => {
    expect(resolveRoleFromGroups(["metis-devs", "metis-admins"], mappings, "reader")).toBe("admin");
  });

  it("returns default role when mappings array is empty", () => {
    expect(resolveRoleFromGroups(["anything"], [], "developer")).toBe("developer");
  });
});

// ---------------------------------------------------------------------------
// Issue #451 (OWASP A09) — admin config-read secret masking + update guard.
// ---------------------------------------------------------------------------

/** Every concrete secret value that must NEVER appear in an admin read view. */
const SAML_SECRETS = {
  spPrivateKey: "-----BEGIN PRIVATE KEY-----PK-451-----END PRIVATE KEY-----",
  spCert: "-----BEGIN CERTIFICATE-----SPCERT-451-----END CERTIFICATE-----",
  idpCert: "MIIC-IDP-CERT-451",
  metadataXml: "<EntityDescriptor>idp-metadata-451</EntityDescriptor>",
};
const OIDC_SECRET = "TOP-SECRET-CLIENT-SECRET-451";

function makeSamlProvider() {
  return upsertProvider({
    name: "Okta SAML",
    mode: "saml",
    enabled: true,
    groupMappings: [{ claimValue: "admins", role: "admin" }],
    defaultRole: "reader",
    saml: {
      entityId: "metis-sp",
      acsUrl: "https://app/acs",
      idpMetadataXml: SAML_SECRETS.metadataXml,
      idpSsoUrl: "https://idp/sso",
      idpCerts: [SAML_SECRETS.idpCert],
      idpIssuer: "https://idp",
      signRequests: true,
      spPrivateKey: SAML_SECRETS.spPrivateKey,
      spCert: SAML_SECRETS.spCert,
    },
  });
}

function makeOidcProvider() {
  return upsertProvider({
    name: "Google OIDC",
    mode: "oidc",
    enabled: true,
    oidc: {
      discoveryUrl: "https://idp/.well-known/openid-configuration",
      clientId: "client-123",
      clientSecret: OIDC_SECRET,
      redirectUri: "https://app/callback",
      scopes: ["openid", "profile", "email"],
      pkceEnabled: true,
    },
  });
}

describe("toAdminProviderView()", () => {
  beforeEach(() => __resetProviders());

  it("masks every SAML secret as a boolean flag and omits raw values", () => {
    const view = toAdminProviderView(makeSamlProvider());
    // Non-secret config round-trips so the admin form can repopulate.
    expect(view.saml).toMatchObject({
      entityId: "metis-sp",
      acsUrl: "https://app/acs",
      idpSsoUrl: "https://idp/sso",
      idpIssuer: "https://idp",
      signRequests: true,
      hasSpPrivateKey: true,
      hasSpCert: true,
      hasIdpCerts: true,
      hasIdpMetadataXml: true,
    });
    // Raw secret/internal fields are structurally absent from the view.
    const raw = JSON.stringify(view);
    for (const secret of Object.values(SAML_SECRETS)) {
      expect(raw).not.toContain(secret);
    }
    for (const key of ["spPrivateKey", "spCert", "idpCerts", "idpMetadataXml"]) {
      expect(raw).not.toContain(key);
    }
  });

  it("exposes hasClientSecret (no raw value, no last-4) for OIDC", () => {
    const view = toAdminProviderView(makeOidcProvider());
    expect(view.oidc).toMatchObject({
      discoveryUrl: "https://idp/.well-known/openid-configuration",
      clientId: "client-123",
      redirectUri: "https://app/callback",
      pkceEnabled: true,
      hasClientSecret: true,
    });
    const raw = JSON.stringify(view);
    expect(raw).not.toContain(OIDC_SECRET);
    expect(raw).not.toContain("clientSecret");
  });

  it("reports hasClientSecret=false when no secret is stored", () => {
    const cfg = upsertProvider({
      name: "No-secret OIDC",
      mode: "oidc",
      enabled: false,
      oidc: {
        discoveryUrl: "https://idp/disc",
        clientId: "c",
        clientSecret: "",
        redirectUri: "https://app/cb",
        scopes: ["openid"],
        pkceEnabled: true,
      },
    });
    expect(toAdminProviderView(cfg).oidc?.hasClientSecret).toBe(false);
  });

  it("reports SAML presence flags as false when secrets are absent", () => {
    const cfg = upsertProvider({
      name: "Bare SAML",
      mode: "saml",
      enabled: false,
      saml: {
        entityId: "e",
        acsUrl: "https://a/acs",
        idpMetadataXml: "",
        idpSsoUrl: "",
        idpCerts: [],
        idpIssuer: "",
        signRequests: false,
      },
    });
    expect(toAdminProviderView(cfg).saml).toMatchObject({
      hasSpPrivateKey: false,
      hasSpCert: false,
      hasIdpCerts: false,
      hasIdpMetadataXml: false,
    });
  });

  it("leaves saml/oidc undefined when the stored config has none", () => {
    const cfg = upsertProvider({ name: "Empty", mode: "saml" });
    const view = toAdminProviderView(cfg);
    expect(view.saml).toBeUndefined();
    expect(view.oidc).toBeUndefined();
    expect(view.id).toBe(cfg.id);
    expect(view.name).toBe("Empty");
  });
});

describe("getAllProvidersForAdmin() / getProviderForAdmin()", () => {
  beforeEach(() => __resetProviders());

  it("maps all providers to secret-free admin views", () => {
    makeSamlProvider();
    makeOidcProvider();
    const views = getAllProvidersForAdmin();
    expect(views).toHaveLength(2);
    const raw = JSON.stringify(views);
    for (const secret of [...Object.values(SAML_SECRETS), OIDC_SECRET]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("returns a single secret-free view by id", () => {
    const cfg = makeOidcProvider();
    const view = getProviderForAdmin(cfg.id);
    expect(view?.oidc?.hasClientSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain(OIDC_SECRET);
  });

  it("returns undefined for an unknown id", () => {
    expect(getProviderForAdmin("nope")).toBeUndefined();
  });
});

describe("mergeSecretOnUpdate() — update-keeps-existing guard", () => {
  it("keeps the existing secret when the incoming value is undefined", () => {
    expect(mergeSecretOnUpdate(undefined, "stored")).toBe("stored");
  });

  it("keeps the existing secret when the incoming value is null", () => {
    expect(mergeSecretOnUpdate(null, "stored")).toBe("stored");
  });

  it("keeps the existing secret when the incoming value is empty", () => {
    expect(mergeSecretOnUpdate("", "stored")).toBe("stored");
  });

  it("keeps the existing secret when the incoming value is whitespace only", () => {
    expect(mergeSecretOnUpdate("   ", "stored")).toBe("stored");
  });

  it("REFUSES to persist the mask sentinel — keeps the existing secret", () => {
    expect(mergeSecretOnUpdate(MASKED_SECRET, "stored")).toBe("stored");
    // Even padded with whitespace, the mask must never be stored as a real value.
    expect(mergeSecretOnUpdate(`  ${MASKED_SECRET}  `, "stored")).toBe("stored");
  });

  it("persists a real new value verbatim (including legit surrounding spaces)", () => {
    expect(mergeSecretOnUpdate("brand-new-secret", "stored")).toBe("brand-new-secret");
    expect(mergeSecretOnUpdate("  has spaces  ", "stored")).toBe("  has spaces  ");
  });

  it("returns undefined when neither incoming nor existing is set", () => {
    expect(mergeSecretOnUpdate(undefined, undefined)).toBeUndefined();
    expect(mergeSecretOnUpdate("", undefined)).toBeUndefined();
  });

  it("sets a first-time secret when none was stored before", () => {
    expect(mergeSecretOnUpdate("first-secret", undefined)).toBe("first-secret");
  });
});
