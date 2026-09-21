import { describe, expect, it } from "vitest";
import {
  classifyPrivateIp,
  isLoopbackHostname,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
} from "../../src/net/private-ip.js";

describe("isPrivateIPv4", () => {
  it.each([
    ["0.0.0.0", true],
    ["0.255.255.255", true],
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["100.64.0.1", true], // CGNAT
    ["100.127.255.255", true],
    ["100.128.0.0", false], // outside CGNAT
    ["100.63.255.255", false],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["169.254.0.1", true],
    ["169.254.169.254", true], // AWS metadata
    ["172.15.255.255", false],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.0", false],
    ["192.0.0.1", true], // IETF /24
    ["192.0.2.1", true], // TEST-NET-1
    ["192.168.1.1", true],
    ["198.17.255.255", false],
    ["198.18.0.1", true], // benchmark
    ["198.19.255.255", true],
    ["198.20.0.0", false],
    ["198.51.100.1", true], // TEST-NET-2
    ["203.0.113.1", true], // TEST-NET-3
    ["224.0.0.1", true], // multicast start
    ["239.255.255.255", true],
    ["240.0.0.1", true], // reserved
    ["255.255.255.255", true], // broadcast
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["140.82.112.4", false], // public github.com
  ])("classifies %s as private=%s", (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });

  it("fails closed on malformed input", () => {
    expect(isPrivateIPv4("not-an-ip")).toBe(true);
    expect(isPrivateIPv4("999.0.0.1")).toBe(true);
    expect(isPrivateIPv4("1.2.3")).toBe(true);
    expect(isPrivateIPv4("1.2.3.4.5")).toBe(true);
    expect(isPrivateIPv4("-1.0.0.0")).toBe(true);
    expect(isPrivateIPv4("")).toBe(true);
  });
});

describe("isPrivateIPv6", () => {
  it.each([
    ["::", true],
    ["::1", true],
    ["fe80::1", true],
    ["fe80:0:0:0:0:0:0:1", true],
    ["fc00::1", true],
    ["fd00::1", true],
    ["fcff::abcd", true],
    ["ff00::1", true],
    ["ff02::1", true], // multicast all-nodes
    ["::ffff:127.0.0.1", true], // IPv4-mapped loopback
    ["::ffff:169.254.169.254", true], // IPv4-mapped AWS metadata
    ["::ffff:10.0.0.1", true], // IPv4-mapped RFC1918
    ["::ffff:8.8.8.8", false], // IPv4-mapped public
    ["::8.8.8.8", false], // IPv4-compatible public
    ["::10.0.0.1", true], // IPv4-compatible private
    ["2001:4860:4860::8888", false], // Google DNS
    ["2606:4700:4700::1111", false], // Cloudflare DNS
  ])("classifies %s as private=%s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });

  it("strips brackets", () => {
    expect(isPrivateIPv6("[::1]")).toBe(true);
  });
});

// Issue #683 — `new URL().hostname` normalises IPv4-mapped IPv6 addresses to
// the HEX form (`::ffff:169.254.169.254` → `::ffff:a9fe:a9fe`), which the
// old `/^::ffff:([0-9.]+)$/` regex failed to match, classifying every mapped
// private address as PUBLIC and defeating all SSRF egress guards. These cover
// the hex form (and uppercase / zero-compression variants) of every private
// range, plus the dotted form, plus NAT64 and IPv4-compatible embeddings.
describe("isPrivateIPv6 — IPv4-mapped/embedded bypass (#683)", () => {
  it.each([
    // hex form (what URL normalisation actually produces) — MUST be private
    ["::ffff:7f00:1", true], // 127.0.0.1 loopback
    ["::ffff:a00:1", true], // 10.0.0.1 RFC1918
    ["::ffff:ac10:1", true], // 172.16.0.1 RFC1918
    ["::ffff:c0a8:1", true], // 192.168.0.1 RFC1918
    ["::ffff:a9fe:a9fe", true], // 169.254.169.254 link-local / cloud IMDS
    ["::ffff:6440:1", true], // 100.64.0.1 CGNAT
    // uppercase hex variant — canonicalisation must lowercase
    ["::FFFF:A9FE:A9FE", true], // 169.254.169.254 IMDS
    ["::FFFF:7F00:1", true], // 127.0.0.1
    // zero-compression variants of the private vectors
    ["::ffff:0:1", true], // 0.0.0.1 → 0.0.0.0/8 fail-closed
    ["0:0:0:0:0:ffff:7f00:1", true], // fully-expanded loopback
    ["::ffff:7f00:0001", true], // padded loopback low group
    // dotted form still works (regression on the original path)
    ["::ffff:127.0.0.1", true],
    ["::ffff:169.254.169.254", true],
    ["::ffff:10.0.0.1", true],
    // IPv4-mapped PUBLIC must still pass (not over-blocked)
    ["::ffff:808:808", false], // 8.8.8.8
    ["::ffff:8.8.8.8", false],
    ["::ffff:1.1.1.1", false],
    ["::ffff:8c52:7004", false], // 140.82.112.4 github
    // IPv4-compatible (deprecated) hex embeddings
    ["::a00:1", true], // ::10.0.0.1
    ["::808:808", false], // ::8.8.8.8 public
    // NAT64 64:ff9b::/96 embeddings — extract trailing v4
    ["64:ff9b::a9fe:a9fe", true], // NAT64 of 169.254.169.254 IMDS
    ["64:ff9b::7f00:1", true], // NAT64 of 127.0.0.1
    ["64:ff9b::808:808", false], // NAT64 of 8.8.8.8 public
    // malformed mapped → fail closed
    ["::ffff:nothex:1", true],
    // legit global unicast must still pass
    ["2606:4700::1", false], // Cloudflare
    ["2001:4860:4860::8888", false], // Google DNS
    ["2a00:1450:4001:81b::200e", false], // global unicast
  ])("classifies %s as private=%s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

// Issue #689 — the fe80::/10 link-local block spans fe80:: through febf:: (top
// 10 bits 1111111010), but the classifier used a literal startsWith("fe80:")
// that only matched fe80::/16, leaving fe81:: through febf:: classified PUBLIC;
// and the RFC 8215 NAT64 local-use prefix 64:ff9b:1::/48 was not decoded.
describe("isPrivateIPv6 — fe80::/10 + NAT64 64:ff9b:1::/48 (#689)", () => {
  it.each([
    // fe80::/10 link-local range endpoints + midpoint — all private
    ["fe80::1", true], // /10 lower bound (regression)
    ["fe81::1", true], // was PUBLIC before #689
    ["fea0::1", true], // midpoint
    ["febf::1", true], // /10 upper bound
    ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", true],
    // just OUTSIDE fe80::/10 — must stay public
    ["fe7f::1", false], // one below the range
    ["fec0::1", false], // deprecated site-local, not link-local
    // RFC 8215 NAT64 local-use 64:ff9b:1::/48 — decode the trailing v4
    ["64:ff9b:1::a9fe:a9fe", true], // 169.254.169.254 IMDS (hex tail)
    ["64:ff9b:1::7f00:1", true], // 127.0.0.1 (hex tail)
    ["64:ff9b:1::192.168.0.1", true], // RFC1918 (dotted tail)
    ["64:ff9b:1::10.0.0.1", true], // RFC1918 (dotted tail)
    ["64:ff9b:1::808:808", false], // 8.8.8.8 public (hex tail)
    ["64:ff9b:1::8.8.8.8", false], // 8.8.8.8 public (dotted tail)
    // well-known /96 prefix still works (regression)
    ["64:ff9b::a9fe:a9fe", true],
    ["64:ff9b::808:808", false],
  ])("classifies %s as private=%s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });

  it.each([
    ["fe80::1", "ipv6-link-local"],
    ["fe81::1", "ipv6-link-local"], // was null (public) before #689
    ["febf::1", "ipv6-link-local"],
    ["fea0::1", "ipv6-link-local"],
    ["64:ff9b:1::a9fe:a9fe", "ipv6-mapped-private"], // NAT64 /48 IMDS
    ["64:ff9b:1::10.0.0.1", "ipv6-mapped-private"], // NAT64 /48 RFC1918
  ])("classifies %s as %s", (ip, klass) => {
    expect(classifyPrivateIp(ip)).toBe(klass);
  });

  it.each([["fe7f::1"], ["fec0::1"], ["64:ff9b:1::8.8.8.8"], ["2001:4860:4860::8888"]])(
    "classifies %s as public (null)",
    (ip) => {
      expect(classifyPrivateIp(ip)).toBeNull();
    },
  );
});

describe("classifyPrivateIp", () => {
  it.each([
    ["169.254.169.254", "ipv4-aws-metadata"],
    ["127.0.0.1", "ipv4-loopback"],
    ["169.254.1.1", "ipv4-link-local"],
    ["100.64.0.1", "ipv4-cgnat"],
    ["224.0.0.1", "ipv4-multicast"],
    ["10.0.0.1", "ipv4-private"],
    ["192.168.1.1", "ipv4-private"],
    ["172.16.0.1", "ipv4-private"],
    ["192.0.2.1", "ipv4-reserved"],
    ["::1", "ipv6-loopback"],
    ["fe80::1", "ipv6-link-local"],
    ["fc00::1", "ipv6-ula"],
    ["ff02::1", "ipv6-multicast"],
    // mapped hex private → classified, not null (the #683 fix)
    ["::ffff:a9fe:a9fe", "ipv6-mapped-private"],
    ["::ffff:7f00:1", "ipv6-mapped-private"],
  ])("classifies %s as %s", (ip, klass) => {
    expect(classifyPrivateIp(ip)).toBe(klass);
  });

  it("returns null for public addresses", () => {
    expect(classifyPrivateIp("8.8.8.8")).toBeNull();
    expect(classifyPrivateIp("140.82.112.4")).toBeNull();
    expect(classifyPrivateIp("2606:4700::1")).toBeNull();
    expect(classifyPrivateIp("::ffff:8.8.8.8")).toBeNull();
    expect(classifyPrivateIp("::ffff:808:808")).toBeNull();
  });

  it("returns null for non-IP input (callers resolve DNS first)", () => {
    expect(classifyPrivateIp("example.com")).toBeNull();
  });

  it("strips brackets and lowercases", () => {
    expect(classifyPrivateIp("[::FFFF:A9FE:A9FE]")).toBe("ipv6-mapped-private");
  });
});

describe("isPrivateIp", () => {
  it("dispatches by family", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("2001:db8::1")).toBe(false);
  });

  it("returns false for non-IP input (callers must resolve DNS first)", () => {
    expect(isPrivateIp("example.com")).toBe(false);
    expect(isPrivateIp("not-an-ip")).toBe(false);
  });

  it("strips brackets and lowercases", () => {
    expect(isPrivateIp("[FE80::1]")).toBe(true);
    expect(isPrivateIp("[2001:DB8::1]")).toBe(false);
  });
});

describe("isLoopbackHostname", () => {
  it.each([
    ["localhost", true],
    ["LOCALHOST", true],
    ["127.0.0.1", true],
    ["::1", true],
    ["[::1]", true],
    ["0.0.0.0", true],
    ["example.com", false],
    ["10.0.0.1", false],
  ])("classifies %s as loopback=%s", (host, expected) => {
    expect(isLoopbackHostname(host)).toBe(expected);
  });
});
