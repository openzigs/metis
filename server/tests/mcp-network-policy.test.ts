/**
 * Epic #272 / Sub-issue #285 — NetworkPolicy builder unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildNetworkPolicy,
  parseAllowlist,
  parseAllowlistEntry,
} from "../src/lib/mcp/provisioners/network-policy.js";

describe("parseAllowlistEntry", () => {
  it("parses a CIDR entry", () => {
    expect(parseAllowlistEntry("cidr:10.0.0.0/8")).toEqual({
      kind: "cidr",
      cidr: "10.0.0.0/8",
    });
  });

  it("parses a host entry", () => {
    expect(parseAllowlistEntry("host:api.github.com")).toEqual({
      kind: "host",
      host: "api.github.com",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseAllowlistEntry("  host:example.com  ")).toEqual({
      kind: "host",
      host: "example.com",
    });
  });

  it("throws on empty input", () => {
    expect(() => parseAllowlistEntry("")).toThrow();
  });

  it("throws on missing scheme prefix", () => {
    expect(() => parseAllowlistEntry("api.github.com")).toThrow(/Unrecognised/);
  });

  it("throws on empty CIDR", () => {
    expect(() => parseAllowlistEntry("cidr:")).toThrow(/Empty CIDR/);
  });

  it("throws on empty host", () => {
    expect(() => parseAllowlistEntry("host:")).toThrow(/Empty host/);
  });
});

describe("parseAllowlist", () => {
  it("returns empty list for null/empty", () => {
    expect(parseAllowlist(null)).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
  });

  it("parses a CSV string", () => {
    const out = parseAllowlist("cidr:10.0.0.0/8, host:api.github.com");
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "cidr", cidr: "10.0.0.0/8" });
    expect(out[1]).toEqual({ kind: "host", host: "api.github.com" });
  });

  it("accepts a string array", () => {
    const out = parseAllowlist(["host:a.example", "host:b.example"]);
    expect(out).toHaveLength(2);
  });

  it("ignores empty entries between commas", () => {
    expect(parseAllowlist("host:a.example,, ,host:b.example")).toHaveLength(2);
  });
});

describe("buildNetworkPolicy", () => {
  const baseInput = { serverId: "abc", resourceName: "mcp-deadbeef", namespace: "metis-mcp" };

  it("includes a deny-all base + DNS egress when allowlist is empty", () => {
    const np = buildNetworkPolicy({ ...baseInput, allowlist: [] });
    expect(np.kind).toBe("NetworkPolicy");
    expect(np.metadata?.name).toBe("mcp-deadbeef");
    expect(np.metadata?.namespace).toBe("metis-mcp");
    // Selector must match the pod via metis.io/server-id.
    expect(np.spec?.podSelector?.matchLabels?.["metis.io/server-id"]).toBe("abc");
    // Policy types — at minimum egress.
    expect(np.spec?.policyTypes).toContain("Egress");
    // Egress always includes DNS rule (UDP+TCP/53).
    const egress = np.spec?.egress ?? [];
    expect(egress.length).toBeGreaterThanOrEqual(1);
    const dnsRule = egress.find((r) => r.ports?.some((p) => Number(p.port) === 53));
    expect(dnsRule).toBeDefined();
    expect(dnsRule?.ports?.map((p) => p.protocol).sort()).toEqual(["TCP", "UDP"]);
  });

  it("renders CIDR entries as ipBlock egress", () => {
    const np = buildNetworkPolicy({
      ...baseInput,
      allowlist: ["cidr:10.0.0.0/8", "cidr:192.168.0.0/16"],
    });
    const cidrs = (np.spec?.egress ?? [])
      .flatMap((r) => r.to ?? [])
      .map((p) => p.ipBlock?.cidr)
      .filter(Boolean);
    expect(cidrs).toEqual(expect.arrayContaining(["10.0.0.0/8", "192.168.0.0/16"]));
  });

  it("collapses host entries into permissive 80/443 egress", () => {
    const np = buildNetworkPolicy({
      ...baseInput,
      allowlist: ["host:api.github.com", "host:registry.npmjs.org"],
    });
    const hostRules = (np.spec?.egress ?? []).filter((r) =>
      r.ports?.some((p) => Number(p.port) === 443),
    );
    expect(hostRules.length).toBeGreaterThanOrEqual(1);
  });

  it("propagates parsing errors", () => {
    expect(() => buildNetworkPolicy({ ...baseInput, allowlist: ["bogus"] })).toThrow();
  });

  it("declares both Ingress and Egress policy types", () => {
    const np = buildNetworkPolicy({ ...baseInput, allowlist: [] });
    expect(np.spec?.policyTypes).toEqual(expect.arrayContaining(["Ingress", "Egress"]));
  });

  it("emits a single ingress rule allowing only METIS server pods on 8080", () => {
    const np = buildNetworkPolicy({ ...baseInput, allowlist: [] });
    const ingress = np.spec?.ingress ?? [];
    expect(ingress).toHaveLength(1);
    const rule = ingress[0]!;
    expect(rule._from).toHaveLength(1);
    expect(rule._from?.[0]?.podSelector?.matchLabels).toEqual({
      "metis.io/component": "server",
    });
    expect(rule.ports?.map((p) => Number(p.port))).toEqual([8080]);
  });

  it("does not allow ingress from any other source", () => {
    const np = buildNetworkPolicy({
      ...baseInput,
      allowlist: ["cidr:10.0.0.0/8", "host:api.github.com"],
    });
    const ingress = np.spec?.ingress ?? [];
    // Exactly one ingress entry, exactly one `_from` peer, with the metis
    // component label — confirms no namespaceSelector/ipBlock fall-through.
    expect(ingress).toHaveLength(1);
    expect(ingress[0]?._from).toHaveLength(1);
    const peer = ingress[0]?._from?.[0];
    expect(peer?.namespaceSelector).toBeUndefined();
    expect(peer?.ipBlock).toBeUndefined();
    expect(peer?.podSelector?.matchLabels?.["metis.io/component"]).toBe("server");
  });
});
