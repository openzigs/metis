/**
 * Epic #517 (#520) — the SAML Response-signing posture is surfaced to the admin
 * view and defaults to the SECURE setting for legacy configs.
 *
 * These pin the read-side projection (`toAdminProviderView`) so a config stored
 * before #520 (no `requireSignedResponse` field) is reported as
 * `requireSignedResponse: true`, and explicit true/false values round-trip.
 */
import { describe, expect, it } from "vitest";

import { toAdminProviderView, upsertProvider } from "../sso-config.js";
import type { SAMLConfig } from "../sso-types.js";

function samlBlock(overrides: Partial<SAMLConfig> = {}): SAMLConfig {
  return {
    entityId: "sp",
    acsUrl: "https://sp/acs",
    idpMetadataXml: "",
    idpSsoUrl: "https://idp/sso",
    idpCerts: ["CERT"],
    idpIssuer: "idp",
    signRequests: false,
    ...overrides,
  };
}

describe("toAdminProviderView — requireSignedResponse posture (#520)", () => {
  it("reports requireSignedResponse=true for a legacy config (field absent)", () => {
    const p = upsertProvider({ mode: "saml", name: "legacy", saml: samlBlock() });
    const view = toAdminProviderView(p);
    expect(view.saml?.requireSignedResponse).toBe(true);
  });

  it("round-trips an explicit secure posture (true)", () => {
    const p = upsertProvider({
      mode: "saml",
      name: "secure",
      saml: samlBlock({ requireSignedResponse: true }),
    });
    expect(toAdminProviderView(p).saml?.requireSignedResponse).toBe(true);
  });

  it("round-trips an explicit opt-out (false)", () => {
    const p = upsertProvider({
      mode: "saml",
      name: "optout",
      saml: samlBlock({ requireSignedResponse: false }),
    });
    expect(toAdminProviderView(p).saml?.requireSignedResponse).toBe(false);
  });

  it("never echoes SP secrets back in the admin view", () => {
    const p = upsertProvider({
      mode: "saml",
      name: "sec",
      saml: samlBlock({ spPrivateKey: "PEM-SECRET", spCert: "CERT-PEM" }),
    });
    const serialized = JSON.stringify(toAdminProviderView(p));
    expect(serialized).not.toContain("PEM-SECRET");
    expect(toAdminProviderView(p).saml?.hasSpPrivateKey).toBe(true);
  });
});
