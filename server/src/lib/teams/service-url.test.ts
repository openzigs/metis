/** #1466 — the proactive-send serviceUrl allowlist. */
import { describe, expect, it } from "vitest";

import {
  assertTrustedBotServiceUrl,
  isTrustedBotServiceUrl,
  UntrustedServiceUrlError,
} from "./service-url.js";

describe("isTrustedBotServiceUrl (#1466)", () => {
  it.each([
    "https://smba.trafficmanager.net/amer/",
    "https://smba.trafficmanager.net/emea/",
    "https://SMBA.trafficmanager.net/apac/",
    "https://europe.webchat.botframework.com/",
    "https://smba.infra.gcc.teams.microsoft.com/",
    "https://smba.infra.gov.teams.microsoft.us/",
    "https://smba.infra.dod.teams.microsoft.us/",
    "https://directline.botframework.azure.us/",
  ])("accepts the Bot Framework / Teams connector URL %s", (url) => {
    expect(isTrustedBotServiceUrl(url)).toBe(true);
  });

  it.each([
    ["an attacker host", "https://attacker.example.com/"],
    ["a look-alike suffix", "https://evil-botframework.com/"],
    ["a trusted name as a label of another zone", "https://smba.trafficmanager.net.evil.com/"],
    ["another trafficmanager.net tenant", "https://evil.trafficmanager.net/"],
    ["plain http", "http://smba.trafficmanager.net/amer/"],
    ["an explicit port", "https://smba.trafficmanager.net:8443/amer/"],
    ["embedded credentials", "https://user:pw@smba.trafficmanager.net/amer/"],
    ["localhost", "https://localhost/"],
    ["not a URL", "smba.trafficmanager.net"],
    ["empty", ""],
    ["missing", undefined],
    ["a non-string", 42],
  ])("refuses %s", (_label, url) => {
    expect(isTrustedBotServiceUrl(url)).toBe(false);
  });

  it("assertTrustedBotServiceUrl throws a named error that does not echo the URL", () => {
    expect(() => assertTrustedBotServiceUrl("https://smba.trafficmanager.net/amer/")).not.toThrow();
    let thrown: unknown;
    try {
      assertTrustedBotServiceUrl("https://attacker.example.com/collect");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UntrustedServiceUrlError);
    expect((thrown as Error).message).not.toContain("attacker");
  });
});
