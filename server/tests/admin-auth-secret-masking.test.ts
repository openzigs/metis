/**
 * Tests for the admin SSO config-read secret masking — `/api/admin/auth/*`.
 *
 * Issue #451 (OWASP A09, found during the #429 vision walkthrough, epic #407):
 * the admin-authenticated config-read endpoints (`GET /providers`,
 * `GET /providers/:id`) historically echoed the stored OIDC client secret (and
 * other secrets — SAML SP private key, certs, IdP metadata XML) back in
 * plaintext. This is a SEPARATE surface from the already-clean public
 * `/api/auth/sso/providers` login endpoint.
 *
 * These tests mount the real `adminAuthRouter()` on a minimal Express app with
 * the auth/role middleware stubbed to an admin user, and exercise the real
 * in-memory sso-config store. They assert the HTTP contract:
 *   (a) read-masks-secret  — a configured provider returns has* flags, no raw secret
 *   (b) write-accepts-new-secret — PUT a new secret persists it
 *   (c) update-without-secret-keeps-existing — PUT with empty/mask secret does NOT wipe it
 *   (d) no-leak across ALL audited secret fields (SAML key/cert/metadata, OIDC secret)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Admin-authenticate every request: stub requireAuth to inject an admin user,
// and requireRole to a pass-through so the router mounts without a real JWT/DB.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: { userId: string; role: string } }).user = {
      userId: "admin-1",
      role: "admin",
    };
    next();
  },
}));
vi.mock("../src/middleware/require-role.js", () => ({
  requireRole: () => (_req: express.Request, _res: express.Response, next: () => void) => next(),
}));

// The audit service imports prisma; stub it to a no-op so no DB is touched.
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { auditLog: { create: vi.fn(async () => ({})) } },
}));

import { adminAuthRouter } from "../src/routes/admin/auth.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import {
  getProvider,
  getAllProvidersForAdmin,
  upsertProvider,
  __resetProviders,
  MASKED_SECRET,
} from "../src/lib/auth/sso-config.js";

/** Concrete secret values that must never appear in any admin read response. */
const OIDC_SECRET = "TOP-SECRET-CLIENT-SECRET-451";
const SAML_SECRETS = {
  spPrivateKey: "-----BEGIN PRIVATE KEY-----PK-451-----END PRIVATE KEY-----",
  spCert: "-----BEGIN CERTIFICATE-----SPCERT-451-----END CERTIFICATE-----",
  idpCert: "MIIC-IDP-CERT-451",
  metadataXml: "<EntityDescriptor>idp-metadata-451</EntityDescriptor>",
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/auth", adminAuthRouter());
  app.use(errorHandler);
  return app;
}

function seedOidc() {
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

function seedSaml() {
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

const app = makeApp();

beforeEach(() => __resetProviders());
afterEach(() => {
  __resetProviders();
  vi.clearAllMocks();
});

describe("GET /api/admin/auth/providers — (a) read masks secret", () => {
  it("returns has* presence flags and NO raw secrets for a configured OIDC provider", async () => {
    seedOidc();
    const res = await request(app).get("/api/admin/auth/providers");
    expect(res.status).toBe(200);
    const oidc = res.body.data.providers.find((p: { mode: string }) => p.mode === "oidc");
    expect(oidc.oidc.hasClientSecret).toBe(true);
    expect(oidc.oidc.clientId).toBe("client-123");
    expect(oidc.oidc).not.toHaveProperty("clientSecret");
    expect(JSON.stringify(res.body)).not.toContain(OIDC_SECRET);
  });

  it("returns SAML has* flags and omits raw key/cert/metadata", async () => {
    seedSaml();
    const res = await request(app).get("/api/admin/auth/providers");
    const saml = res.body.data.providers.find((p: { mode: string }) => p.mode === "saml");
    expect(saml.saml).toMatchObject({
      entityId: "metis-sp",
      hasSpPrivateKey: true,
      hasSpCert: true,
      hasIdpCerts: true,
      hasIdpMetadataXml: true,
    });
    expect(saml.saml).not.toHaveProperty("spPrivateKey");
    expect(saml.saml).not.toHaveProperty("idpMetadataXml");
  });
});

describe("GET /api/admin/auth/providers/:id — (a) single read masks secret", () => {
  it("masks the OIDC secret on the single-provider read", async () => {
    const cfg = seedOidc();
    const res = await request(app).get(`/api/admin/auth/providers/${cfg.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.provider.oidc.hasClientSecret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(OIDC_SECRET);
  });

  it("404s for an unknown id", async () => {
    const res = await request(app).get("/api/admin/auth/providers/nope");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/admin/auth/providers/oidc — (b) write accepts new secret", () => {
  it("persists a brand-new client secret on first configuration", async () => {
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      name: "Google OIDC",
      discoveryUrl: "https://idp/disc",
      clientId: "client-abc",
      clientSecret: "brand-new-oidc-secret",
      redirectUri: "https://app/cb",
      enabled: true,
    });
    expect(res.status).toBe(200);
    const id = res.body.data.provider.id;
    // Stored verbatim in the underlying config (the read view masks it).
    expect(getProvider(id)?.oidc?.clientSecret).toBe("brand-new-oidc-secret");
    // ...but the write RESPONSE itself must not echo the raw secret back.
    expect(JSON.stringify(res.body)).not.toContain("brand-new-oidc-secret");
  });

  it("replaces an existing secret when a real new value is supplied", async () => {
    const cfg = seedOidc();
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      id: cfg.id,
      name: "Google OIDC",
      discoveryUrl: "https://idp/disc",
      clientId: "client-123",
      clientSecret: "rotated-secret",
      redirectUri: "https://app/cb",
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(getProvider(cfg.id)?.oidc?.clientSecret).toBe("rotated-secret");
  });
});

describe("PUT /api/admin/auth/providers/oidc — (c) update without secret keeps existing", () => {
  it("keeps the stored secret when clientSecret is omitted on update", async () => {
    const cfg = seedOidc();
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      id: cfg.id,
      name: "Google OIDC (renamed)",
      discoveryUrl: "https://idp/disc",
      clientId: "client-123",
      redirectUri: "https://app/cb",
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(getProvider(cfg.id)?.oidc?.clientSecret).toBe(OIDC_SECRET);
    expect(getProvider(cfg.id)?.name).toBe("Google OIDC (renamed)");
  });

  it("keeps the stored secret when clientSecret is the empty string", async () => {
    const cfg = seedOidc();
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      id: cfg.id,
      name: "Google OIDC",
      discoveryUrl: "https://idp/disc",
      clientId: "client-123",
      clientSecret: "",
      redirectUri: "https://app/cb",
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(getProvider(cfg.id)?.oidc?.clientSecret).toBe(OIDC_SECRET);
  });

  it("REFUSES to persist the mask sentinel — keeps the stored secret", async () => {
    const cfg = seedOidc();
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      id: cfg.id,
      name: "Google OIDC",
      discoveryUrl: "https://idp/disc",
      clientId: "client-123",
      clientSecret: MASKED_SECRET,
      redirectUri: "https://app/cb",
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(getProvider(cfg.id)?.oidc?.clientSecret).toBe(OIDC_SECRET);
  });

  it("400s for first-time OIDC config with no secret at all", async () => {
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      name: "Google OIDC",
      discoveryUrl: "https://idp/disc",
      clientId: "client-123",
      redirectUri: "https://app/cb",
      enabled: true,
    });
    expect(res.status).toBe(400);
  });

  // The admin form does NOT round-trip a provider id (#451 vision walkthrough):
  // a no-id PUT must UPDATE the single OIDC provider (keep secret, no duplicate),
  // not 400 demanding the masked secret be re-typed.
  it("keeps the secret AND updates in place on a no-id update (real admin UI flow)", async () => {
    const cfg = seedOidc();
    const before = getAllProvidersForAdmin().length;
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      // NO id, secret left blank — exactly what the admin form sends.
      name: "Google OIDC (edited, no id)",
      discoveryUrl: "https://idp/disc",
      clientId: "client-123",
      clientSecret: "",
      redirectUri: "https://app/cb",
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(getProvider(cfg.id)?.oidc?.clientSecret).toBe(OIDC_SECRET);
    expect(getProvider(cfg.id)?.name).toBe("Google OIDC (edited, no id)");
    // Same provider updated — NOT a duplicate.
    expect(getAllProvidersForAdmin().length).toBe(before);
  });

  it("resolves a currently-DISABLED provider by mode on a no-id update (enabled-agnostic)", async () => {
    const cfg = upsertProvider({
      name: "Disabled OIDC",
      mode: "oidc",
      enabled: false,
      oidc: {
        discoveryUrl: "https://idp/disc",
        clientId: "client-123",
        clientSecret: OIDC_SECRET,
        redirectUri: "https://app/cb",
        scopes: ["openid"],
        pkceEnabled: true,
      },
    });
    const res = await request(app).put("/api/admin/auth/providers/oidc").send({
      name: "Re-enabled OIDC",
      discoveryUrl: "https://idp/disc",
      clientId: "client-123",
      clientSecret: MASKED_SECRET,
      redirectUri: "https://app/cb",
      enabled: true,
    });
    expect(res.status).toBe(200);
    expect(getProvider(cfg.id)?.oidc?.clientSecret).toBe(OIDC_SECRET);
  });
});

describe("PUT /api/admin/auth/providers/saml — update keeps existing SP secrets", () => {
  it("keeps the stored SP private key + cert + metadata when omitted on update", async () => {
    const cfg = seedSaml();
    const res = await request(app)
      .put("/api/admin/auth/providers/saml")
      .send({
        id: cfg.id,
        name: "Okta SAML (renamed)",
        entityId: "metis-sp",
        acsUrl: "https://app/acs",
        enabled: false,
        groupMappings: [{ claimValue: "admins", role: "admin" }],
      });
    expect(res.status).toBe(200);
    const stored = getProvider(cfg.id)?.saml;
    expect(stored?.spPrivateKey).toBe(SAML_SECRETS.spPrivateKey);
    expect(stored?.spCert).toBe(SAML_SECRETS.spCert);
    expect(stored?.idpMetadataXml).toBe(SAML_SECRETS.metadataXml);
    expect(stored?.idpSsoUrl).toBe("https://idp/sso");
  });

  it("replaces the SP private key when a new value is supplied", async () => {
    const cfg = seedSaml();
    const res = await request(app)
      .put("/api/admin/auth/providers/saml")
      .send({
        id: cfg.id,
        name: "Okta SAML",
        entityId: "metis-sp",
        acsUrl: "https://app/acs",
        spPrivateKey: "-----BEGIN PRIVATE KEY-----ROTATED-----END PRIVATE KEY-----",
        enabled: true,
        groupMappings: [{ claimValue: "admins", role: "admin" }],
      });
    expect(res.status).toBe(200);
    expect(getProvider(cfg.id)?.saml?.spPrivateKey).toBe(
      "-----BEGIN PRIVATE KEY-----ROTATED-----END PRIVATE KEY-----",
    );
  });

  it("keeps SP secrets AND updates in place on a no-id update (real admin UI flow)", async () => {
    const cfg = seedSaml();
    const before = getAllProvidersForAdmin().length;
    const res = await request(app)
      .put("/api/admin/auth/providers/saml")
      .send({
        // NO id — the admin form does not round-trip one.
        name: "Okta SAML (edited, no id)",
        entityId: "metis-sp",
        acsUrl: "https://app/acs",
        enabled: false,
        groupMappings: [{ claimValue: "admins", role: "admin" }],
      });
    expect(res.status).toBe(200);
    const stored = getProvider(cfg.id)?.saml;
    expect(stored?.spPrivateKey).toBe(SAML_SECRETS.spPrivateKey);
    expect(stored?.spCert).toBe(SAML_SECRETS.spCert);
    expect(getProvider(cfg.id)?.name).toBe("Okta SAML (edited, no id)");
    expect(getAllProvidersForAdmin().length).toBe(before);
  });
});

describe("(d) no-leak across ALL audited secret fields", () => {
  it("the providers list response contains NONE of the stored secrets", async () => {
    seedSaml();
    seedOidc();
    const res = await request(app).get("/api/admin/auth/providers");
    const raw = JSON.stringify(res.body);
    for (const secret of [OIDC_SECRET, ...Object.values(SAML_SECRETS)]) {
      expect(raw).not.toContain(secret);
    }
    // The sensitive config KEY names must not appear either — proving the nested
    // secret-bearing fields were never spread into the response.
    for (const key of ["clientSecret", "spPrivateKey", "spCert", "idpCerts", "idpMetadataXml"]) {
      expect(raw).not.toContain(key);
    }
  });

  it("the GET /ldap admin read never returns the bind password", async () => {
    // The LDAP read endpoint uses getLDAPConfigForUI(), which strips bindPassword.
    const res = await request(app).get("/api/admin/auth/ldap");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("bindPassword");
    expect(res.body.data.ldap).not.toHaveProperty("bindPassword");
  });
});
