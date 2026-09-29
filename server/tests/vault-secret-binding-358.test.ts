/**
 * #358 — the pure "does this write change the destination?" predicates behind
 * the Jira / test-management / publishing binding checks. The route-level
 * behaviour is proved in `vault-secret-binding-358.sqlite.test.ts`; these pin
 * the edges a route test would need a row per case for.
 */
import { describe, expect, it } from "vitest";
import {
  jiraDestinationChanged,
  testMgmtDestinationChanged,
} from "../src/lib/connectors/destination.js";
import { isCallerChosenPublishHost } from "../src/lib/publishing/publish-secret-binding.js";

describe("#358 jiraDestinationChanged", () => {
  const existing = {
    baseUrl: "https://jira.example.test",
    proxyUrl: null,
    tlsRejectUnauthorized: true,
  };

  it("treats re-sent values and non-destination fields as unchanged", () => {
    expect(jiraDestinationChanged(existing, {})).toBe(false);
    expect(
      jiraDestinationChanged(existing, {
        baseUrl: existing.baseUrl,
        proxyUrl: null,
        tlsRejectUnauthorized: true,
        tlsCaCert: null,
      }),
    ).toBe(false);
    // Removing a CA is stricter, not a new destination.
    expect(jiraDestinationChanged(existing, { tlsCaCert: "" })).toBe(false);
  });

  it("flags base URL, proxy, TLS verification and a new CA", () => {
    expect(jiraDestinationChanged(existing, { baseUrl: "https://x.example.test" })).toBe(true);
    expect(jiraDestinationChanged(existing, { proxyUrl: "https://p.example.test" })).toBe(true);
    expect(jiraDestinationChanged(existing, { tlsRejectUnauthorized: false })).toBe(true);
    expect(jiraDestinationChanged(existing, { tlsCaCert: "PEM" })).toBe(true);
  });

  it("turning TLS verification back ON is stricter, not a new destination", () => {
    const insecure = { ...existing, tlsRejectUnauthorized: false };
    expect(jiraDestinationChanged(insecure, { tlsRejectUnauthorized: true })).toBe(false);
    expect(jiraDestinationChanged(insecure, { tlsRejectUnauthorized: false })).toBe(false);
  });
});

describe("#358 testMgmtDestinationChanged", () => {
  const existing = {
    baseUrl: "https://tm.example.test",
    proxyConfigJson: JSON.stringify({ url: "https://proxy.example.test" }),
    tlsConfigJson: JSON.stringify({ rejectUnauthorized: true, caCertRef: null }),
  };

  it("treats re-sent values as unchanged", () => {
    expect(testMgmtDestinationChanged(existing, {})).toBe(false);
    expect(
      testMgmtDestinationChanged(existing, {
        baseUrl: existing.baseUrl,
        proxyConfig: { url: "https://proxy.example.test" },
        tlsConfig: { rejectUnauthorized: true },
      }),
    ).toBe(false);
    // Dropping the TLS block restores the default (verify), which is unchanged here.
    expect(testMgmtDestinationChanged(existing, { tlsConfig: null })).toBe(false);
  });

  it("flags base URL, proxy (set, changed or cleared), TLS verification and a new CA", () => {
    expect(testMgmtDestinationChanged(existing, { baseUrl: "https://x.example.test" })).toBe(true);
    expect(
      testMgmtDestinationChanged(existing, { proxyConfig: { url: "https://p2.example.test" } }),
    ).toBe(true);
    expect(testMgmtDestinationChanged(existing, { proxyConfig: null })).toBe(true);
    expect(testMgmtDestinationChanged(existing, { tlsConfig: { rejectUnauthorized: false } })).toBe(
      true,
    );
    expect(testMgmtDestinationChanged(existing, { tlsConfig: { caCert: "PEM" } })).toBe(true);
  });

  it("turning TLS verification back ON is stricter, not a new destination", () => {
    const insecure = { ...existing, tlsConfigJson: JSON.stringify({ rejectUnauthorized: false }) };
    expect(testMgmtDestinationChanged(insecure, { tlsConfig: { rejectUnauthorized: true } })).toBe(
      false,
    );
    expect(testMgmtDestinationChanged(insecure, { tlsConfig: null })).toBe(false);
    expect(testMgmtDestinationChanged(insecure, { tlsConfig: { rejectUnauthorized: false } })).toBe(
      false,
    );
  });

  it("reads an unparseable stored proxy / TLS config as none", () => {
    const broken = { baseUrl: existing.baseUrl, proxyConfigJson: "{", tlsConfigJson: "{" };
    expect(testMgmtDestinationChanged(broken, { proxyConfig: null, tlsConfig: null })).toBe(false);
    const none = { baseUrl: existing.baseUrl, proxyConfigJson: null, tlsConfigJson: null };
    expect(testMgmtDestinationChanged(none, { proxyConfig: { url: "https://p.test" } })).toBe(true);
  });
});

describe("#358 isCallerChosenPublishHost", () => {
  it("public GitHub (implicit or explicit) is not caller-chosen", () => {
    for (const u of [
      null,
      undefined,
      "",
      "  ",
      "https://api.github.com",
      "https://API.github.com/",
    ]) {
      expect(isCallerChosenPublishHost(u)).toBe(false);
    }
  });

  it("any other host, or an unparseable URL, is caller-chosen", () => {
    expect(isCallerChosenPublishHost("https://ghe.example.test/api/v3")).toBe(true);
    expect(isCallerChosenPublishHost("https://api.github.com.attacker.test")).toBe(true);
    expect(isCallerChosenPublishHost("not a url")).toBe(true);
  });
});
