/**
 * Tests for the public SSO providers endpoint — `GET /api/auth/sso/providers`.
 *
 * Issue #429 (Epic #407): the login page calls this pre-auth endpoint to render
 * one branded button per configured+enabled SSO provider. The endpoint must:
 *   - return only configured, ENABLED providers,
 *   - expose ONLY safe display fields { id, label, type, loginUrl },
 *   - never leak secrets (client secret, signing keys, certs, metadata XML),
 *   - return an empty list (200, not 404/500) when none are configured,
 *   - read live config (so configuring a provider makes it appear w/o redeploy).
 *
 * The store is in-memory (server/src/lib/auth/sso-config.ts), so these tests
 * mutate it directly via upsertProvider / __resetProviders and assert the HTTP
 * contract through supertest against the real createApp() router.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is never touched by this read-only public endpoint, but createApp wires
// routers that import prisma at module load — mock it so the app boots without a
// live DB (mirrors app.test.ts).
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { upsertProvider, __resetProviders, toPublicProvider } from "../src/lib/auth/sso-config.js";

const app = createApp();

beforeEach(() => {
  __resetProviders();
});

afterEach(() => {
  __resetProviders();
  vi.restoreAllMocks();
});

describe("GET /api/auth/sso/providers", () => {
  it("returns an empty list (200, not 404/500) when none are configured", async () => {
    const res = await request(app).get("/api/auth/sso/providers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { providers: [] } });
  });

  it("returns configured + ENABLED providers with only safe display fields", async () => {
    upsertProvider({
      name: "Okta SAML",
      mode: "saml",
      enabled: true,
      saml: {
        entityId: "metis",
        acsUrl: "https://app/acs",
        idpMetadataXml: "<EntityDescriptor>secret-metadata</EntityDescriptor>",
        idpSsoUrl: "https://idp/sso",
        idpCerts: ["MIIC-super-secret-cert"],
        idpIssuer: "https://idp",
        signRequests: true,
        spPrivateKey: "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
        spCert: "-----BEGIN CERTIFICATE-----xyz-----END CERTIFICATE-----",
      },
    });
    upsertProvider({
      name: "Google OIDC",
      mode: "oidc",
      enabled: true,
      oidc: {
        discoveryUrl: "https://idp/.well-known/openid-configuration",
        clientId: "client-123",
        clientSecret: "TOP-SECRET-CLIENT-SECRET",
        redirectUri: "https://app/callback",
        scopes: ["openid", "profile", "email"],
        pkceEnabled: true,
      },
    });

    const res = await request(app).get("/api/auth/sso/providers");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const providers = res.body.data.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(2);

    const saml = providers.find((p) => p.type === "saml")!;
    const oidc = providers.find((p) => p.type === "oidc")!;

    // Each provider exposes EXACTLY the four safe keys — no more.
    expect(Object.keys(saml).sort()).toEqual(["id", "label", "loginUrl", "type"]);
    expect(Object.keys(oidc).sort()).toEqual(["id", "label", "loginUrl", "type"]);

    expect(saml).toMatchObject({
      label: "Okta SAML",
      type: "saml",
      loginUrl: "/api/auth/saml/login",
    });
    expect(oidc).toMatchObject({
      label: "Google OIDC",
      type: "oidc",
      loginUrl: "/api/auth/oidc/login",
    });
    expect(typeof saml.id).toBe("string");
    expect(typeof oidc.id).toBe("string");
  });

  it("omits providers that are configured but DISABLED", async () => {
    upsertProvider({ name: "Disabled SAML", mode: "saml", enabled: false });
    upsertProvider({ name: "Enabled OIDC", mode: "oidc", enabled: true });

    const res = await request(app).get("/api/auth/sso/providers");
    const providers = res.body.data.providers as Array<{ label: string }>;
    expect(providers).toHaveLength(1);
    expect(providers[0].label).toBe("Enabled OIDC");
  });

  it("reads LIVE config — a provider enabled after boot appears without redeploy", async () => {
    const before = await request(app).get("/api/auth/sso/providers");
    expect(before.body.data.providers).toHaveLength(0);

    upsertProvider({ name: "Late SAML", mode: "saml", enabled: true });

    const after = await request(app).get("/api/auth/sso/providers");
    expect(after.body.data.providers).toHaveLength(1);
    expect(after.body.data.providers[0].label).toBe("Late SAML");
  });

  it("NO SECRET LEAK — the response body contains none of the stored sensitive fields", async () => {
    const secrets = {
      clientSecret: "TOP-SECRET-CLIENT-SECRET",
      spPrivateKey: "-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
      spCert: "-----BEGIN CERTIFICATE-----xyz-----END CERTIFICATE-----",
      idpCert: "MIIC-super-secret-cert",
      metadataXml: "<EntityDescriptor>secret-metadata</EntityDescriptor>",
    };
    upsertProvider({
      name: "Okta SAML",
      mode: "saml",
      enabled: true,
      groupMappings: [{ claimValue: "admins", role: "admin" }],
      defaultRole: "reader",
      saml: {
        entityId: "metis",
        acsUrl: "https://app/acs",
        idpMetadataXml: secrets.metadataXml,
        idpSsoUrl: "https://idp/sso",
        idpCerts: [secrets.idpCert],
        idpIssuer: "https://idp",
        signRequests: true,
        spPrivateKey: secrets.spPrivateKey,
        spCert: secrets.spCert,
      },
    });
    upsertProvider({
      name: "Google OIDC",
      mode: "oidc",
      enabled: true,
      oidc: {
        discoveryUrl: "https://idp/.well-known/openid-configuration",
        clientId: "client-123",
        clientSecret: secrets.clientSecret,
        redirectUri: "https://app/callback",
        scopes: ["openid", "profile", "email"],
        pkceEnabled: true,
      },
    });

    const res = await request(app).get("/api/auth/sso/providers");
    const raw = JSON.stringify(res.body);

    for (const value of Object.values(secrets)) {
      expect(raw).not.toContain(value);
    }
    // And none of the sensitive KEY names appear either — proving the nested
    // `saml`/`oidc` config objects (which hold the secrets) were never spread
    // into the response. NB: the substrings "saml"/"oidc" DO legitimately appear
    // inside the safe `type` and `loginUrl` fields, so we assert on the secret
    // *config keys*, not the mode words.
    for (const key of [
      "clientSecret",
      "spPrivateKey",
      "spCert",
      "idpCerts",
      "idpMetadataXml",
      "idpSsoUrl",
      "discoveryUrl",
      "redirectUri",
      "groupMappings",
      "defaultRole",
    ]) {
      expect(raw).not.toContain(key);
    }
    // Belt-and-suspenders: every provider object has EXACTLY the safe key set.
    for (const p of res.body.data.providers as Array<Record<string, unknown>>) {
      expect(Object.keys(p).sort()).toEqual(["id", "label", "loginUrl", "type"]);
    }
  });
});

describe("toPublicProvider() mapping helper", () => {
  it("maps a SAML config to safe display fields with the SAML initiation URL", () => {
    const cfg = upsertProvider({ name: "Acme SAML", mode: "saml", enabled: true });
    expect(toPublicProvider(cfg)).toEqual({
      id: cfg.id,
      label: "Acme SAML",
      type: "saml",
      loginUrl: "/api/auth/saml/login",
    });
  });

  it("maps an OIDC config to safe display fields with the OIDC initiation URL", () => {
    const cfg = upsertProvider({ name: "Acme OIDC", mode: "oidc", enabled: true });
    expect(toPublicProvider(cfg)).toEqual({
      id: cfg.id,
      label: "Acme OIDC",
      type: "oidc",
      loginUrl: "/api/auth/oidc/login",
    });
  });
});
