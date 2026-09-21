/**
 * Tests for the egress allowlist defaults + validator (Epic #395 #414).
 */
import { describe, expect, it } from "vitest";
import {
  SYSTEM_DEFAULT_EGRESS_ALLOWLIST,
  buildEffectiveEgressAllowlist,
  isForbiddenEgressTarget,
  validateEgressAllowlist,
} from "../../../src/lib/sandbox/egress-defaults.js";
import { SandboxEgressValidationError } from "../../../src/lib/sandbox/types.js";

describe("SYSTEM_DEFAULT_EGRESS_ALLOWLIST", () => {
  it("includes the npm + pypi + github hosts called out in #414", () => {
    const set = new Set(SYSTEM_DEFAULT_EGRESS_ALLOWLIST);
    expect(set.has("registry.npmjs.org")).toBe(true);
    expect(set.has("pypi.org")).toBe(true);
    expect(set.has("github.com")).toBe(true);
    expect(set.has("api.github.com")).toBe(true);
  });

  it("is frozen so callers cannot mutate the system list", () => {
    expect(() => {
      // @ts-expect-error — intentional violation
      SYSTEM_DEFAULT_EGRESS_ALLOWLIST.push("evil.example");
    }).toThrow();
  });
});

describe("validateEgressAllowlist", () => {
  it("accepts an empty list", () => {
    expect(() => validateEgressAllowlist([])).not.toThrow();
  });

  it("accepts hostnames", () => {
    expect(() => validateEgressAllowlist(["a.example", "b.example"])).not.toThrow();
  });

  it("rejects wildcard '*'", () => {
    expect(() => validateEgressAllowlist(["*"])).toThrow(SandboxEgressValidationError);
  });

  it("rejects subdomain wildcard '*.example.com'", () => {
    expect(() => validateEgressAllowlist(["*.example.com"])).toThrow(SandboxEgressValidationError);
  });

  it("rejects 0.0.0.0/0 CIDR", () => {
    expect(() => validateEgressAllowlist(["0.0.0.0/0"])).toThrow(SandboxEgressValidationError);
  });

  it("rejects ::/0 IPv6 CIDR", () => {
    expect(() => validateEgressAllowlist(["::/0"])).toThrow(SandboxEgressValidationError);
  });

  it("rejects empty entries", () => {
    expect(() => validateEgressAllowlist([""])).toThrow(SandboxEgressValidationError);
  });
});

describe("buildEffectiveEgressAllowlist", () => {
  it("returns just the system defaults when no caller hosts are supplied", () => {
    const out = buildEffectiveEgressAllowlist([]);
    for (const host of SYSTEM_DEFAULT_EGRESS_ALLOWLIST) {
      expect(out).toContain(host);
    }
  });

  it("merges caller hosts with the system defaults", () => {
    const out = buildEffectiveEgressAllowlist(["internal.example.com"]);
    expect(out).toContain("internal.example.com");
    expect(out).toContain("registry.npmjs.org");
  });

  it("dedupes overlapping caller + system entries", () => {
    const out = buildEffectiveEgressAllowlist(["github.com", "github.com"]);
    expect(out.filter((h) => h === "github.com").length).toBe(1);
  });

  it("returns hosts in deterministic sorted order", () => {
    const out = buildEffectiveEgressAllowlist(["zzz.example.com"]);
    const sorted = [...out].sort();
    expect(out).toEqual(sorted);
  });

  it("throws when caller list contains a wildcard", () => {
    expect(() => buildEffectiveEgressAllowlist(["*.evil"])).toThrow(SandboxEgressValidationError);
  });

  it("normalizes case so 'GITHUB.COM' matches the lower-case default", () => {
    const out = buildEffectiveEgressAllowlist(["GITHUB.COM"]);
    expect(out.filter((h) => h === "github.com").length).toBe(1);
  });
});

describe("isForbiddenEgressTarget — deny-by-default ranges (OWASP A10 SSRF)", () => {
  it("denies the AWS/GCP/Azure IMDS literal", () => {
    expect(isForbiddenEgressTarget("169.254.169.254")).toBe(true);
  });

  it("denies the GCP metadata hostname", () => {
    expect(isForbiddenEgressTarget("metadata.google.internal")).toBe(true);
  });

  it("denies the Azure metadata hostname", () => {
    expect(isForbiddenEgressTarget("metadata.azure.com")).toBe(true);
  });

  it("denies the AWS internal metadata hostname", () => {
    expect(isForbiddenEgressTarget("metadata.aws.internal")).toBe(true);
  });

  it.each([
    ["127.0.0.1", "IPv4 loopback literal"],
    ["127.5.5.5", "IPv4 loopback /8"],
    ["10.0.0.1", "RFC1918 10/8"],
    ["10.255.255.255/32", "RFC1918 10/8 with CIDR"],
    ["172.16.0.1", "RFC1918 172.16/12 lower bound"],
    ["172.31.255.255", "RFC1918 172.16/12 upper bound"],
    ["192.168.1.1", "RFC1918 192.168/16"],
    ["169.254.0.1", "link-local 169.254/16"],
    ["0.0.0.0", "0.0.0.0/8 unspecified"],
    ["::1", "IPv6 loopback"],
    ["[::1]", "IPv6 loopback bracketed"],
    ["fe80::1", "IPv6 link-local fe80::/10"],
    ["fc00::1", "IPv6 unique-local fc00::/7"],
    ["fd00::abcd", "IPv6 unique-local fd00::/8"],
  ])("denies %s (%s)", (input) => {
    expect(isForbiddenEgressTarget(input)).toBe(true);
  });

  it("does not deny legitimate public hosts", () => {
    expect(isForbiddenEgressTarget("github.com")).toBe(false);
    expect(isForbiddenEgressTarget("8.8.8.8")).toBe(false);
    expect(isForbiddenEgressTarget("172.15.0.1")).toBe(false); // just below 172.16/12
    expect(isForbiddenEgressTarget("172.32.0.1")).toBe(false); // just above 172.16/12
  });
});

describe("validateEgressAllowlist — deny-by-default precedence", () => {
  it.each([
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.aws.internal",
    "metadata.azure.com",
    "127.0.0.1",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "::1",
    "fe80::1",
  ])("rejects %s even when explicitly allowlisted", (host) => {
    expect(() => validateEgressAllowlist([host])).toThrow(SandboxEgressValidationError);
    // The same input must propagate through `buildEffectiveEgressAllowlist`.
    expect(() => buildEffectiveEgressAllowlist([host])).toThrow(SandboxEgressValidationError);
  });

  it("denies forbidden targets BEFORE merging with system defaults", () => {
    // If precedence were reversed, an empty caller list + a forbidden target
    // could sneak through; ensure the validator rejects on the caller list
    // alone.
    expect(() => validateEgressAllowlist(["169.254.169.254"])).toThrow();
    expect(() => buildEffectiveEgressAllowlist(["169.254.169.254"])).toThrow();
  });
});
