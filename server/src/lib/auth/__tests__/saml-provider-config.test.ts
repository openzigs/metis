/**
 * Epic #517 (#520) — assert the exact node-saml options the hardening sets.
 *
 * These pin the VERIFIED option names/values for `@node-saml/passport-saml`
 * v5.1.0 (which bundles `@node-saml/node-saml` v5.1.0) so a future dependency
 * bump that renames/relaxes them fails loudly here rather than silently
 * weakening the SAML posture.
 */
import { ValidateInResponseTo } from "@node-saml/passport-saml";
import { describe, expect, it } from "vitest";

import { __resetSAMLInstances, buildSamlConfig, getSAMLInstance } from "../saml-provider.js";
import {
  DEFAULT_REQUEST_ID_EXPIRATION_MS,
  InMemorySamlRequestIdCache,
} from "../saml-request-id-cache.js";
import type { SAMLConfig } from "../sso-types.js";

function makeConfig(overrides: Partial<SAMLConfig> = {}): SAMLConfig {
  return {
    entityId: "sp-entity",
    acsUrl: "https://sp/acs",
    idpMetadataXml: "",
    idpSsoUrl: "https://idp/sso",
    idpCerts: ["BASE64CERT"],
    idpIssuer: "idp-issuer",
    signRequests: false,
    ...overrides,
  };
}

const cache = new InMemorySamlRequestIdCache();

describe("buildSamlConfig — secure defaults (#520)", () => {
  it("enables replay protection: validateInResponseTo=ifPresent + cache + TTL", () => {
    const opts = buildSamlConfig(makeConfig(), cache);
    expect(opts.validateInResponseTo).toBe(ValidateInResponseTo.ifPresent);
    expect(opts.cacheProvider).toBe(cache);
    expect(opts.requestIdExpirationPeriodMs).toBe(DEFAULT_REQUEST_ID_EXPIRATION_MS);
  });

  it("requires the Response envelope to be signed by default", () => {
    expect(buildSamlConfig(makeConfig(), cache).wantAuthnResponseSigned).toBe(true);
  });

  it("always requires the assertion to be signed", () => {
    expect(buildSamlConfig(makeConfig(), cache).wantAssertionsSigned).toBe(true);
    expect(
      buildSamlConfig(makeConfig({ requireSignedResponse: false }), cache).wantAssertionsSigned,
    ).toBe(true);
  });

  it("honours requireSignedResponse=false (documented assertion-only opt-out)", () => {
    expect(
      buildSamlConfig(makeConfig({ requireSignedResponse: false }), cache).wantAuthnResponseSigned,
    ).toBe(false);
  });

  it("treats requireSignedResponse=true the same as the default", () => {
    expect(
      buildSamlConfig(makeConfig({ requireSignedResponse: true }), cache).wantAuthnResponseSigned,
    ).toBe(true);
  });

  it("enforces the assertion time window with a small, non-zero clock skew", () => {
    const skew = buildSamlConfig(makeConfig(), cache).acceptedClockSkewMs;
    expect(skew).toBeGreaterThan(0);
    expect(skew).toBeLessThanOrEqual(60_000); // small — not unbounded
  });

  it("only sets a signing private key when AuthnRequest signing is enabled", () => {
    expect(buildSamlConfig(makeConfig(), cache).privateKey).toBeUndefined();
    const withKey = buildSamlConfig(makeConfig({ signRequests: true, spPrivateKey: "PEM" }), cache);
    expect(withKey.privateKey).toBe("PEM");
  });
});

describe("getSAMLInstance — shared instance per config", () => {
  it("returns the SAME instance for an identical config (shared cache across legs)", () => {
    __resetSAMLInstances();
    const config = makeConfig();
    expect(getSAMLInstance(config)).toBe(getSAMLInstance(config));
  });

  it("returns a NEW instance when a security-relevant field changes", () => {
    __resetSAMLInstances();
    const a = getSAMLInstance(makeConfig());
    const b = getSAMLInstance(makeConfig({ requireSignedResponse: false }));
    expect(a).not.toBe(b);
  });

  it("rebuilds when the SP signing key rotates", () => {
    __resetSAMLInstances();
    const a = getSAMLInstance(makeConfig({ signRequests: true, spPrivateKey: "k1" }));
    const b = getSAMLInstance(makeConfig({ signRequests: true, spPrivateKey: "k2" }));
    expect(a).not.toBe(b);
  });
});
