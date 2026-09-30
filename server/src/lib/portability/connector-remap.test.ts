import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeModelRemap,
  computeUploadPathAnchoring,
  computeRemap,
  computeRuntimeConfigRemap,
  parseRemapSpec,
  RemapValidationError,
  type RemapRow,
} from "./connector-remap.js";

// ── Zod validation ────────────────────────────────────────────────────────────

describe("parseRemapSpec validation", () => {
  it("accepts a valid spec with valueMap + byId + RuntimeConfig", () => {
    const spec = parseRemapSpec({
      version: 1,
      RepoConnection: {
        valueMap: { apiBaseUrl: { "https://old.example": "https://new.example" } },
        byId: { repo1: { localPath: "/srv/new/path" } },
      },
      DatabaseConnection: { valueMap: { host: { "old-db": "new-db" }, port: { "5432": 5433 } } },
      MCPServer: { byId: { mcp1: { url: "http://new-mcp:8080" } } },
      RuntimeConfig: { set: { LOCAL_GEMMA_BASE_URL: "http://localhost:11434" } },
    });
    expect(spec.version).toBe(1);
    expect(spec.RuntimeConfig?.set?.LOCAL_GEMMA_BASE_URL).toBe("http://localhost:11434");
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(() => parseRemapSpec({ version: 1, Bogus: {} })).toThrow(RemapValidationError);
  });

  it("rejects a non-allowlisted field for a model", () => {
    expect(() =>
      parseRemapSpec({ version: 1, RepoConnection: { byId: { r: { secretId: "x" } } } }),
    ).toThrow(RemapValidationError);
  });

  it("rejects a RuntimeConfig key that is not env-specific-tunable", () => {
    // A secret/bootstrap/portable key must be refused.
    expect(() =>
      parseRemapSpec({ version: 1, RuntimeConfig: { set: { VAULT_MASTER_KEY: "x" } } }),
    ).toThrow(/not.*env-specific-tunable|unknown config key/i);
  });

  it("rejects an unknown RuntimeConfig key", () => {
    expect(() =>
      parseRemapSpec({ version: 1, RuntimeConfig: { set: { NOT_A_REAL_KEY: "x" } } }),
    ).toThrow(/unknown config key/i);
  });

  it("accepts an env-specific-tunable RuntimeConfig key", () => {
    const spec = parseRemapSpec({
      version: 1,
      RuntimeConfig: { set: { MCP_K8S_NAMESPACE: "metis-prod" } },
    });
    expect(spec.RuntimeConfig?.set?.MCP_K8S_NAMESPACE).toBe("metis-prod");
  });

  it("rejects a missing version literal", () => {
    expect(() => parseRemapSpec({ RepoConnection: {} })).toThrow(RemapValidationError);
  });
});

// ── computeModelRemap transform ────────────────────────────────────────────────

describe("computeModelRemap", () => {
  const rows: RemapRow[] = [
    { id: "r1", apiBaseUrl: "https://old.example", localPath: "/srv/old", uploadPath: null },
    { id: "r2", apiBaseUrl: "https://keep.example", localPath: "/srv/other", uploadPath: null },
  ];

  it("applies valueMap substitution only to matching values", () => {
    const result = computeModelRemap("RepoConnection", rows, {
      valueMap: { apiBaseUrl: { "https://old.example": "https://new.example" } },
    });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      rowId: "r1",
      field: "apiBaseUrl",
      before: "https://old.example",
      after: "https://new.example",
    });
  });

  it("byId override takes priority over valueMap", () => {
    const result = computeModelRemap("RepoConnection", rows, {
      valueMap: { apiBaseUrl: { "https://old.example": "https://from-valuemap" } },
      byId: { r1: { apiBaseUrl: "https://from-byid" } },
    });
    const change = result.changes.find((c) => c.rowId === "r1" && c.field === "apiBaseUrl")!;
    expect(change.after).toBe("https://from-byid");
  });

  it("reports no change when value already matches target (no-op)", () => {
    const result = computeModelRemap("RepoConnection", rows, {
      valueMap: { apiBaseUrl: { "https://old.example": "https://old.example" } },
    });
    expect(result.changes).toHaveLength(0);
  });

  it("does not touch fields/rows not referenced", () => {
    const result = computeModelRemap("RepoConnection", rows, {
      byId: { r1: { localPath: "/srv/new" } },
    });
    expect(result.changes).toEqual([
      { rowId: "r1", field: "localPath", before: "/srv/old", after: "/srv/new" },
    ]);
  });

  it("can set a value to null via override", () => {
    const result = computeModelRemap("RepoConnection", rows, {
      byId: { r1: { apiBaseUrl: null } },
    });
    expect(result.changes[0]).toMatchObject({ field: "apiBaseUrl", after: null });
  });
});

// ── computeRuntimeConfigRemap ──────────────────────────────────────────────────

describe("computeRuntimeConfigRemap", () => {
  it("reports changes for differing values, skips unchanged", () => {
    const changes = computeRuntimeConfigRemap(
      { MCP_K8S_NAMESPACE: "metis-prod", LOCAL_GEMMA_BASE_URL: "http://localhost:11434" },
      { MCP_K8S_NAMESPACE: "metis-dev", LOCAL_GEMMA_BASE_URL: "http://localhost:11434" },
    );
    expect(changes).toEqual([
      { key: "MCP_K8S_NAMESPACE", before: "metis-dev", after: "metis-prod" },
    ]);
  });

  it("treats an absent current key as null before", () => {
    const changes = computeRuntimeConfigRemap({ MCP_K8S_NAMESPACE: "x" }, {});
    expect(changes[0]).toEqual({ key: "MCP_K8S_NAMESPACE", before: null, after: "x" });
  });
});

// ── computeRemap end-to-end plan ────────────────────────────────────────────────

describe("computeRemap", () => {
  it("assembles a plan across models + RuntimeConfig", () => {
    const spec = parseRemapSpec({
      version: 1,
      DatabaseConnection: { byId: { db1: { host: "new-host", port: 5433 } } },
      RuntimeConfig: { set: { MCP_K8S_NAMESPACE: "metis-prod" } },
    });
    const plan = computeRemap(spec, {
      DatabaseConnection: [{ id: "db1", host: "old-host", port: 5432, databaseName: "metis" }],
      runtimeConfigValues: { MCP_K8S_NAMESPACE: "metis-dev" },
    });
    expect(plan.models).toHaveLength(1);
    expect(plan.models[0].model).toBe("DatabaseConnection");
    expect(plan.models[0].changes).toHaveLength(2);
    expect(plan.runtimeConfig).toHaveLength(1);
  });

  it("omits models with no effective changes", () => {
    const spec = parseRemapSpec({ version: 1, MCPServer: { byId: { m1: { url: "same" } } } });
    const plan = computeRemap(spec, { MCPServer: [{ id: "m1", url: "same" }] });
    expect(plan.models).toHaveLength(0);
  });
});

// ── #527: imported uploadPath is anchored under the importing server's root ──

describe("computeUploadPathAnchoring", () => {
  const ROOT = path.resolve("/srv/metis/data/repo-archives");

  it("re-anchors an uploadPath that points outside the archive root", () => {
    const changes = computeUploadPathAnchoring(
      [{ id: "abc123", uploadPath: "/anywhere/abc123.zip" }],
      ROOT,
    );
    expect(changes).toEqual([
      {
        rowId: "abc123",
        field: "uploadPath",
        before: "/anywhere/abc123.zip",
        after: path.join(ROOT, "abc123.zip"),
      },
    ]);
  });

  it("re-anchors a path that climbs out of the root or names another file", () => {
    const changes = computeUploadPathAnchoring(
      [
        { id: "a1", uploadPath: path.join(ROOT, "..", "a1.zip") },
        { id: "b2", uploadPath: path.join(ROOT, "other.zip") },
        { id: "c3", uploadPath: path.join(ROOT, "nested", "c3.zip") },
        { id: "d4", uploadPath: "d4.zip" },
      ],
      ROOT,
    );
    expect(changes.map((c) => [c.rowId, c.after])).toEqual([
      ["a1", path.join(ROOT, "a1.zip")],
      ["b2", path.join(ROOT, "b2.zip")],
      ["c3", path.join(ROOT, "c3.zip")],
      ["d4", path.join(ROOT, "d4.zip")],
    ]);
  });

  it("leaves a path already at <root>/<id>.zip, and rows with no uploadPath, alone", () => {
    const changes = computeUploadPathAnchoring(
      [
        { id: "ok1", uploadPath: path.join(ROOT, "ok1.zip") },
        { id: "none1", uploadPath: null },
        { id: "none2" },
      ],
      ROOT,
    );
    expect(changes).toEqual([]);
  });

  it("refuses a row whose id could steer the path out of the root", () => {
    expect(() =>
      computeUploadPathAnchoring([{ id: "../../etc/x", uploadPath: "/tmp/x.zip" }], ROOT),
    ).toThrow(RemapValidationError);
    expect(() =>
      computeUploadPathAnchoring([{ id: "Abc", uploadPath: "/tmp/Abc.zip" }], ROOT),
    ).toThrow(/not a server-generated id/);
  });
});
