/**
 * Issue #317 — `buildSecret` / `buildSecretEnvRefs` unit tests.
 */
import { describe, expect, it } from "vitest";
import { buildSecret, buildSecretEnvRefs } from "../../../../src/lib/mcp/provisioners/secret.js";

describe("buildSecret", () => {
  it("returns null when no env entries are present", () => {
    expect(buildSecret({ serverId: "s1", resourceName: "mcp-x", namespace: "n", env: {} })).toBe(
      null,
    );
  });

  it("returns null when every key is invalid (no Secret should be created)", () => {
    expect(
      buildSecret({
        serverId: "s1",
        resourceName: "mcp-x",
        namespace: "n",
        env: { "1bad": "x", "BAD-KEY": "x" },
      }),
    ).toBe(null);
  });

  it("emits stringData (NOT data) so callers don't have to base64-encode", () => {
    const s = buildSecret({
      serverId: "s1",
      resourceName: "mcp-x",
      namespace: "metis-mcp",
      env: { TOKEN: "supersecret" },
    });
    expect(s).not.toBeNull();
    expect(s?.kind).toBe("Secret");
    expect(s?.type).toBe("Opaque");
    expect(s?.stringData).toEqual({ TOKEN: "supersecret" });
    // No `data` field — k8s would expect base64 there.
    expect((s as { data?: unknown }).data).toBeUndefined();
  });

  it("filters out invalid env-var keys", () => {
    const s = buildSecret({
      serverId: "s1",
      resourceName: "mcp-x",
      namespace: "n",
      env: { GOOD: "v", "BAD-KEY": "v", "1BAD": "v", _OK: "v" },
    });
    expect(Object.keys(s?.stringData ?? {}).sort()).toEqual(["GOOD", "_OK"]);
  });

  it("labels the Secret with the metis managed-by + server-id selectors", () => {
    const s = buildSecret({
      serverId: "abc123",
      resourceName: "mcp-abc",
      namespace: "metis-mcp",
      env: { TOKEN: "x" },
    });
    expect(s?.metadata?.labels).toEqual({
      "metis.io/managed-by": "mcp-provisioner",
      "metis.io/server-id": "abc123",
    });
  });
});

describe("buildSecretEnvRefs", () => {
  it("returns deterministic, alphabetically ordered secretKeyRef entries", () => {
    const refs = buildSecretEnvRefs("mcp-x", { ZED: "z", ALPHA: "a", MID: "m" });
    expect(refs.map((r) => r.name)).toEqual(["ALPHA", "MID", "ZED"]);
    for (const r of refs) {
      expect(r.valueFrom.secretKeyRef.name).toBe("mcp-x");
      expect(r.valueFrom.secretKeyRef.key).toBe(r.name);
    }
  });

  it("never emits literal values — protects against argv-style leak in spec", () => {
    const refs = buildSecretEnvRefs("mcp-x", { TOKEN: "supersecret" });
    const serialised = JSON.stringify(refs);
    expect(serialised).not.toContain("supersecret");
    expect(serialised).toContain("secretKeyRef");
  });

  it("filters invalid keys (matches buildSecret's allowlist)", () => {
    const refs = buildSecretEnvRefs("mcp-x", { GOOD: "v", "BAD-KEY": "v" });
    expect(refs.map((r) => r.name)).toEqual(["GOOD"]);
  });
});
