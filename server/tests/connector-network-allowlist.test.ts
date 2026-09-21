/**
 * Connector network allow-list — DNS pinning + RFC1918/loopback rejection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAllowlistForTests,
  assertConnectorHostAllowed,
  isPrivateIp,
  makePinnedLookup,
  resolveAndAssertConnectorHost,
  resolveConnectorDispatcher,
  resolveCorporateProxyUrl,
} from "../src/lib/connectors/network-allowlist.js";
import { __resetConfigSingleton } from "../src/lib/config/index.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.REPO_ALLOWED_HOSTS;
  delete process.env.DB_ALLOWED_HOSTS;
  delete process.env.PUBLISH_GITHUB_ALLOWED_HOSTS;
  delete process.env.CONNECTOR_ALLOW_LOOPBACK;
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  // Issue #262 — drop the in-process compiled allow-list + ConfigService
  // singleton so each test starts from a cold cache and the changes the
  // test makes to process.env are observed on the next read.
  __resetConfigSingleton();
  __resetAllowlistForTests();
});
afterEach(() => {
  process.env = { ...ORIG_ENV };
  __resetConfigSingleton();
  __resetAllowlistForTests();
});

describe("isPrivateIp", () => {
  it.each([
    ["10.0.0.1", true],
    ["192.168.1.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["169.254.169.254", true], // cloud metadata
    ["127.0.0.1", true],
    ["100.64.0.1", true], // CGNAT
    ["::1", true],
    ["::", true],
    ["fe80::1", true],
    ["fc00::1", true],
    ["fd12::1", true],
    ["::ffff:10.0.0.1", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["2606:4700:4700::1111", false],
    ["172.32.0.1", false],
    ["100.128.0.1", false],
    ["not-an-ip", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe("assertConnectorHostAllowed", () => {
  it("rejects empty host", async () => {
    await expect(assertConnectorHostAllowed("", "repo")).rejects.toMatchObject({
      code: "HOST_REQUIRED",
    });
  });

  it("blocks RFC1918 IP literal that is not allow-listed", async () => {
    process.env.NODE_ENV = "production";
    await expect(assertConnectorHostAllowed("10.0.0.5", "db")).rejects.toMatchObject({
      code: "HOST_NOT_ALLOWED",
      status: 403,
    });
  });

  it("permits IP literal on allow-list", async () => {
    process.env.NODE_ENV = "production";
    process.env.DB_ALLOWED_HOSTS = "10.0.0.5";
    await expect(assertConnectorHostAllowed("10.0.0.5", "db")).resolves.toBeUndefined();
  });

  it("permits loopback name in non-production", async () => {
    process.env.NODE_ENV = "test";
    await expect(assertConnectorHostAllowed("localhost", "db")).resolves.toBeUndefined();
  });

  it("blocks loopback name in production unless explicitly allowed", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CONNECTOR_ALLOW_LOOPBACK;
    await expect(assertConnectorHostAllowed("127.0.0.1", "db")).rejects.toMatchObject({
      code: "HOST_NOT_ALLOWED",
    });
  });

  it("permits loopback name in production with override", async () => {
    process.env.NODE_ENV = "production";
    process.env.CONNECTOR_ALLOW_LOOPBACK = "1";
    await expect(assertConnectorHostAllowed("localhost", "db")).resolves.toBeUndefined();
  });

  it("rejects DNS resolution to private IP unless allow-listed", async () => {
    process.env.NODE_ENV = "production";
    const lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(
      assertConnectorHostAllowed("evil.example.com", "repo", lookup),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("permits DNS resolution to private IP if hostname allow-listed", async () => {
    process.env.NODE_ENV = "production";
    process.env.REPO_ALLOWED_HOSTS = "internal.git.example";
    const lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(
      assertConnectorHostAllowed("internal.git.example", "repo", lookup),
    ).resolves.toBeUndefined();
  });

  it("permits public address resolution", async () => {
    process.env.NODE_ENV = "production";
    const lookup = async () => [{ address: "140.82.112.6", family: 4 }];
    await expect(
      assertConnectorHostAllowed("api.github.com", "repo", lookup),
    ).resolves.toBeUndefined();
  });

  it("wraps DNS lookup failure as DNS_LOOKUP_FAILED", async () => {
    const lookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertConnectorHostAllowed("nope.invalid", "db", lookup)).rejects.toMatchObject({
      code: "DNS_LOOKUP_FAILED",
      status: 502,
    });
  });

  it("rejects empty DNS result", async () => {
    const lookup = async () => [];
    await expect(
      assertConnectorHostAllowed("noaddrs.example", "repo", lookup),
    ).rejects.toMatchObject({ code: "DNS_LOOKUP_EMPTY" });
  });

  it("ConnectorError subclasses Error and exposes status+code", async () => {
    try {
      await assertConnectorHostAllowed("", "repo");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectorError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("resolveAndAssertConnectorHost (M1 — DNS pinning)", () => {
  it("returns IP literal verbatim", async () => {
    process.env.NODE_ENV = "production";
    const pin = await resolveAndAssertConnectorHost("8.8.8.8", "db");
    expect(pin).toEqual({ hostname: "8.8.8.8", address: "8.8.8.8", family: 4 });
  });

  it("pins to the FIRST resolved address but validates ALL", async () => {
    process.env.NODE_ENV = "production";
    const lookup = async () => [
      { address: "140.82.112.10", family: 4 },
      { address: "140.82.112.11", family: 4 },
    ];
    const pin = await resolveAndAssertConnectorHost("api.github.com", "repo", lookup);
    expect(pin.address).toBe("140.82.112.10");
    expect(pin.hostname).toBe("api.github.com");
  });

  it("rejects if ANY resolved address is private (defence against split-horizon)", async () => {
    process.env.NODE_ENV = "production";
    const lookup = async () => [
      { address: "140.82.112.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expect(
      resolveAndAssertConnectorHost("evil.example.com", "repo", lookup),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("DNS rebinding: second resolution returns different IP — pinned IP from first call is used", async () => {
    process.env.NODE_ENV = "production";
    let call = 0;
    const lookup = vi.fn(async () => {
      call += 1;
      if (call === 1) return [{ address: "140.82.112.10", family: 4 }];
      return [{ address: "10.0.0.5", family: 4 }]; // attacker flips DNS
    });
    const first = await resolveAndAssertConnectorHost("rebind.example.com", "repo", lookup);
    expect(first.address).toBe("140.82.112.10");
    // The pinned-lookup callback always returns the address from the FIRST
    // call regardless of what the OS resolver subsequently produces.
    const cb = makePinnedLookup(first.address, first.family);
    const out: { addr: string; fam: number } = await new Promise((resolve, reject) => {
      cb!("rebind.example.com", {}, (err, addr, fam) => {
        if (err) reject(err);
        else resolve({ addr, fam });
      });
    });
    expect(out.addr).toBe("140.82.112.10");
    expect(out.fam).toBe(4);
    // And re-validation fails (proves we'd notice on retry):
    await expect(
      resolveAndAssertConnectorHost("rebind.example.com", "repo", lookup),
    ).rejects.toMatchObject({ code: "HOST_NOT_ALLOWED" });
  });

  it("loopback in non-production pins to 127.0.0.1", async () => {
    process.env.NODE_ENV = "test";
    const pin = await resolveAndAssertConnectorHost("localhost", "db");
    expect(pin.address).toBe("127.0.0.1");
  });
});

describe("makePinnedLookup", () => {
  it("returns undefined when no address pinned", () => {
    expect(makePinnedLookup(undefined, undefined)).toBeUndefined();
  });

  it("ignores requested hostname and returns pinned address", () => {
    const cb = makePinnedLookup("203.0.113.20", 4);
    return new Promise<void>((resolve) => {
      cb!("attacker.example.com", {}, (err, addr, fam) => {
        expect(err).toBeNull();
        expect(addr).toBe("203.0.113.20");
        expect(fam).toBe(4);
        resolve();
      });
    });
  });

  it("infers family from IPv6 literal when not provided", () => {
    const cb = makePinnedLookup("2606:4700::1", undefined);
    return new Promise<void>((resolve) => {
      cb!("foo", {}, (_e, _a, fam) => {
        expect(fam).toBe(6);
        resolve();
      });
    });
  });
});

describe("resolveCorporateProxyUrl", () => {
  it("returns undefined when no proxy env vars are set", () => {
    expect(resolveCorporateProxyUrl("api.github.com")).toBeUndefined();
  });

  it("returns HTTPS_PROXY for a host not covered by NO_PROXY", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    expect(resolveCorporateProxyUrl("api.github.com")).toBe("http://proxy.example:8080");
  });

  it("falls back to HTTP_PROXY when HTTPS_PROXY is unset", () => {
    process.env.HTTP_PROXY = "http://proxy.example:8080";
    expect(resolveCorporateProxyUrl("api.github.com")).toBe("http://proxy.example:8080");
  });

  it("falls back to the lowercase https_proxy/http_proxy env vars", () => {
    process.env.https_proxy = "http://proxy.example:8080";
    expect(resolveCorporateProxyUrl("api.github.com")).toBe("http://proxy.example:8080");
  });

  it("bypasses the proxy for an exact NO_PROXY match", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "git.internal.example";
    expect(resolveCorporateProxyUrl("git.internal.example")).toBeUndefined();
  });

  it("bypasses the proxy for a .suffix NO_PROXY entry", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = ".example.com";
    expect(resolveCorporateProxyUrl("git.example.com")).toBeUndefined();
  });

  it("bypasses the proxy for a *.suffix wildcard NO_PROXY entry", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "*.example.com";
    expect(resolveCorporateProxyUrl("git.example.com")).toBeUndefined();
  });

  it("bypasses every host when NO_PROXY is *", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "*";
    expect(resolveCorporateProxyUrl("api.github.com")).toBeUndefined();
  });

  it("is case-insensitive on both hostname and NO_PROXY entries", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "*.EXAMPLE.com";
    expect(resolveCorporateProxyUrl("GIT.example.com")).toBeUndefined();
  });

  it("does not treat an unrelated hostname suffix substring as a subdomain match", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "example.com";
    // "evilexample.com" ends with the literal string "example.com" but is not a
    // subdomain of it (no dot boundary) — must still be proxied.
    expect(resolveCorporateProxyUrl("evilexample.com")).toBe("http://proxy.example:8080");
  });

  it("supports multiple comma-separated NO_PROXY entries", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "localhost, *.example.com , *.other.example";
    expect(resolveCorporateProxyUrl("git.example.com")).toBeUndefined();
    expect(resolveCorporateProxyUrl("api.github.com")).toBe("http://proxy.example:8080");
  });
});

describe("resolveConnectorDispatcher", () => {
  it("returns a DNS-pinned dispatcher when no proxy is required", async () => {
    const dispatcher = await resolveConnectorDispatcher({
      hostname: "api.github.com",
      address: "140.82.114.6",
      family: 4,
    });
    expect(typeof dispatcher.close).toBe("function");
    await dispatcher.close?.();
  });

  it("returns a proxying dispatcher when the host requires the corporate proxy", async () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    const dispatcher = await resolveConnectorDispatcher({
      hostname: "api.github.com",
      address: "140.82.114.6",
      family: 4,
    });
    expect(dispatcher.constructor.name).toBe("ProxyAgent");
    await dispatcher.close?.();
  });

  it("falls back to the pinned dispatcher for a NO_PROXY-covered host even with a proxy configured", async () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    process.env.NO_PROXY = "*.example.com";
    const dispatcher = await resolveConnectorDispatcher({
      hostname: "git.example.com",
      address: "10.1.2.3",
      family: 4,
    });
    expect(dispatcher.constructor.name).not.toBe("ProxyAgent");
    await dispatcher.close?.();
  });
});
