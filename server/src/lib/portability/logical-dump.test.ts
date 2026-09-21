import { describe, expect, it } from "vitest";
import type { ModelFkInfo } from "./schema-fk-graph.js";
import {
  EXCLUDED_FIELDS,
  EXCLUDED_MODELS,
  buildLogicalManifest,
  deserializeRow,
  isFieldExcluded,
  isModelExcluded,
  orderModelsForLoad,
  parseLogicalManifest,
  roundTripRow,
  serializeRow,
  stripExcludedFields,
  type FieldTypeMap,
} from "./logical-dump.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function model(
  name: string,
  edges: { to: string; cols: string[]; required?: boolean }[] = [],
): ModelFkInfo {
  return {
    name,
    tableName: name,
    primaryKey: ["id"],
    scalarFields: [{ name: "id", type: "String", isRequired: true, isId: true, isList: false }],
    fkEdges: edges.map((e) => ({
      fieldName: e.to.toLowerCase(),
      referencedModel: e.to,
      fields: e.cols,
      references: ["id"],
      isRequired: e.required ?? true,
    })),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// orderModelsForLoad
// ════════════════════════════════════════════════════════════════════════════

describe("orderModelsForLoad", () => {
  it("orders referenced models before referencing models (DAG)", () => {
    const models = [
      model("Project", [{ to: "Workspace", cols: ["workspaceId"] }]),
      model("Workspace"),
      model("RepoConnection", [{ to: "Project", cols: ["projectId"] }]),
    ];
    const { order, deferred } = orderModelsForLoad(models);
    expect(deferred).toEqual([]);
    expect(order.indexOf("Workspace")).toBeLessThan(order.indexOf("Project"));
    expect(order.indexOf("Project")).toBeLessThan(order.indexOf("RepoConnection"));
  });

  it("is deterministic with a lexicographic tie-break", () => {
    const models = [model("Charlie"), model("Alpha"), model("Bravo")];
    const a = orderModelsForLoad(models).order;
    const b = orderModelsForLoad([...models].reverse()).order;
    expect(a).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(a).toEqual(b);
  });

  it("handles a self-reference by deferring the self FK (no deadlock)", () => {
    const models = [model("Comment", [{ to: "Comment", cols: ["parentId"], required: false }])];
    const { order, deferred } = orderModelsForLoad(models);
    expect(order).toEqual(["Comment"]);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({
      model: "Comment",
      referencedModel: "Comment",
      columns: ["parentId"],
    });
  });

  it("breaks a 2-model cycle by deferring a nullable FK", () => {
    // A -> B (required), B -> A (nullable). The nullable B->A edge is deferred,
    // leaving A before B.
    const models = [
      model("A", [{ to: "B", cols: ["bId"], required: true }]),
      model("B", [{ to: "A", cols: ["aId"], required: false }]),
    ];
    const { order, deferred } = orderModelsForLoad(models);
    expect(order).toHaveLength(2);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ model: "B", referencedModel: "A", columns: ["aId"] });
    // After deferring the nullable B->A edge, the only remaining hard dependency
    // is A->B (required), so B must load before A.
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("A"));
  });

  it("breaks a cycle with no nullable edge by deferring a required FK (still terminates)", () => {
    const models = [
      model("X", [{ to: "Y", cols: ["yId"], required: true }]),
      model("Y", [{ to: "X", cols: ["xId"], required: true }]),
    ];
    const { order, deferred } = orderModelsForLoad(models);
    expect(order.sort()).toEqual(["X", "Y"]);
    expect(deferred.length).toBeGreaterThanOrEqual(1);
  });

  it("ignores FK targets outside the dump set", () => {
    const models = [model("Solo", [{ to: "NotInDump", cols: ["x"] }])];
    const { order, deferred } = orderModelsForLoad(models);
    expect(order).toEqual(["Solo"]);
    expect(deferred).toEqual([]);
  });

  it("orders a longer chain transitively", () => {
    const models = [
      model("D", [{ to: "C", cols: ["cId"] }]),
      model("C", [{ to: "B", cols: ["bId"] }]),
      model("B", [{ to: "A", cols: ["aId"] }]),
      model("A"),
    ];
    expect(orderModelsForLoad(models).order).toEqual(["A", "B", "C", "D"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// serializeRow / deserializeRow round-trip
// ════════════════════════════════════════════════════════════════════════════

describe("serializeRow / deserializeRow", () => {
  const types: FieldTypeMap = {
    id: "String",
    count: "Int",
    ratio: "Float",
    active: "Boolean",
    when: "DateTime",
    payload: "Json",
    blob: "Bytes",
    big: "BigInt",
    money: "Decimal",
    note: "String",
    role: "Role", // enum-like → string verbatim
  };

  it("serializes DateTime to ISO string and restores a Date", () => {
    const d = new Date("2026-06-22T12:34:56.000Z");
    const ser = serializeRow({ when: d }, types);
    expect(ser.when).toBe("2026-06-22T12:34:56.000Z");
    const de = deserializeRow(ser, types);
    expect(de.when).toBeInstanceOf(Date);
    expect((de.when as Date).toISOString()).toBe(d.toISOString());
  });

  it("round-trips Bytes byte-identically via tagged base64", () => {
    const bytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
    const ser = serializeRow({ blob: bytes }, types);
    // NDJSON-safe: the tagged value is a plain object with a base64 string.
    expect(JSON.parse(JSON.stringify(ser)).blob).toHaveProperty("__metis_bytes_b64__");
    const de = deserializeRow(JSON.parse(JSON.stringify(ser)), types);
    expect(Buffer.isBuffer(de.blob)).toBe(true);
    expect(Buffer.compare(de.blob as Buffer, bytes)).toBe(0);
  });

  it("round-trips BigInt via decimal string", () => {
    const big = 9007199254740993n; // > Number.MAX_SAFE_INTEGER
    const ser = serializeRow({ big }, types);
    expect(ser.big).toBe("9007199254740993");
    const de = deserializeRow(JSON.parse(JSON.stringify(ser)), types);
    expect(de.big).toBe(big);
  });

  it("round-trips Decimal as a string", () => {
    const ser = serializeRow({ money: "123.45" }, types);
    expect(ser.money).toBe("123.45");
    expect(deserializeRow(ser, types).money).toBe("123.45");
    // Object with toString (Prisma.Decimal-like)
    const dec = { toString: () => "99.99" };
    expect(serializeRow({ money: dec }, types).money).toBe("99.99");
  });

  it("embeds Json verbatim and round-trips it", () => {
    const payload = { a: 1, b: [true, null, "x"], nested: { y: 2 } };
    const ser = serializeRow({ payload }, types);
    expect(ser.payload).toEqual(payload);
    const de = deserializeRow(JSON.parse(JSON.stringify(ser)), types);
    expect(de.payload).toEqual(payload);
  });

  it("preserves nulls for every type", () => {
    const row = { when: null, blob: null, big: null, money: null, payload: null, note: null };
    const ser = serializeRow(row, types);
    for (const k of Object.keys(row)) expect(ser[k]).toBeNull();
    const de = deserializeRow(ser, types);
    for (const k of Object.keys(row)) expect(de[k]).toBeNull();
  });

  it("passes String/Int/Float/Boolean/enum through verbatim", () => {
    const row = { id: "c1", count: 7, ratio: 1.5, active: true, note: "hi", role: "ADMIN" };
    expect(roundTripRow(row, types)).toEqual(row);
  });

  it("passes unknown (untyped) columns through verbatim", () => {
    const ser = serializeRow({ mystery: "value" }, {});
    expect(ser.mystery).toBe("value");
  });

  it("serializes Bytes from a plain Uint8Array, a string, and a fallback value", () => {
    // Uint8Array (not a Buffer instance) path.
    const u8 = Uint8Array.from([1, 2, 3]);
    const fromU8 = serializeRow({ blob: u8 }, types).blob as { __metis_bytes_b64__: string };
    expect(Buffer.from(fromU8.__metis_bytes_b64__, "base64")).toEqual(Buffer.from([1, 2, 3]));
    // String path (some drivers hand back a string for a Bytes column).
    const fromStr = serializeRow({ blob: "abc" }, types).blob as { __metis_bytes_b64__: string };
    expect(Buffer.from(fromStr.__metis_bytes_b64__, "base64").toString("utf8")).toBe("abc");
    // Fallback path (number) — coerced via String().
    const fromNum = serializeRow({ blob: 42 }, types).blob as { __metis_bytes_b64__: string };
    expect(Buffer.from(fromNum.__metis_bytes_b64__, "base64").toString("utf8")).toBe("42");
  });

  it("deserialize leaves a non-tagged Bytes value untouched", () => {
    // Defensive: if a Bytes column wasn't tagged, pass it through rather than crash.
    expect(deserializeRow({ blob: "raw" }, types).blob).toBe("raw");
  });

  it("deserialize coerces a Decimal object to string and a non-string DateTime through", () => {
    expect(deserializeRow({ money: { toString: () => "1.50" } }, types).money).toBe("1.50");
    const d = new Date("2025-01-01T00:00:00.000Z");
    expect(deserializeRow({ when: d }, types).when).toBe(d); // non-string DateTime passthrough
  });

  it("serialize coerces a non-Date DateTime value to String", () => {
    expect(serializeRow({ when: "already-iso" }, types).when).toBe("already-iso");
  });

  it("full round-trip preserves a mixed row", () => {
    const row = {
      id: "c1",
      count: 3,
      active: false,
      when: new Date("2025-01-02T03:04:05.000Z"),
      payload: { k: "v" },
      blob: Buffer.from("hello"),
      big: 42n,
      money: "0.01",
      note: null,
    };
    const wire = JSON.parse(JSON.stringify(serializeRow(row, types)));
    const de = deserializeRow(wire, types);
    expect(de.id).toBe("c1");
    expect(de.count).toBe(3);
    expect((de.when as Date).toISOString()).toBe(row.when.toISOString());
    expect(de.payload).toEqual({ k: "v" });
    expect(Buffer.compare(de.blob as Buffer, Buffer.from("hello"))).toBe(0);
    expect(de.big).toBe(42n);
    expect(de.money).toBe("0.01");
    expect(de.note).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Exclusion registry
// ════════════════════════════════════════════════════════════════════════════

describe("exclusion registry", () => {
  it("has no whole-model exclusions in the current schema", () => {
    expect(Object.keys(EXCLUDED_MODELS)).toEqual([]);
    expect(isModelExcluded("KnowledgeChunk")).toBe(false);
  });

  it("has no field exclusions in the current schema", () => {
    expect(Object.keys(EXCLUDED_FIELDS)).toEqual([]);
    expect(isFieldExcluded("Anything", "anyField")).toBe(false);
  });

  it("stripExcludedFields is a no-op when nothing is excluded", () => {
    const row = { id: "x", a: 1, b: 2 };
    expect(stripExcludedFields("Anything", row)).toEqual(row);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Logical manifest
// ════════════════════════════════════════════════════════════════════════════

describe("logical manifest", () => {
  it("builds and re-parses a valid manifest", () => {
    const m = buildLogicalManifest({
      provider: "sqlite",
      schemaVersion: "0.1.0",
      rowCounts: { Workspace: 2, Project: 5 },
      includedModels: ["Workspace", "Project"],
      loadOrder: ["Workspace", "Project"],
      deferredFks: [],
    });
    expect(m.format).toBe("metis-logical-dump");
    expect(m.version).toBe(1);
    expect(() => parseLogicalManifest(m)).not.toThrow();
    expect(parseLogicalManifest(m).rowCounts.Project).toBe(5);
  });

  it("rejects a manifest with the wrong format tag", () => {
    expect(() => parseLogicalManifest({ format: "nope" })).toThrow(/Invalid logical-dump manifest/);
  });

  it("rejects negative row counts", () => {
    const bad = {
      format: "metis-logical-dump",
      version: 1,
      createdAt: new Date().toISOString(),
      provider: "sqlite",
      schemaVersion: "0.1.0",
      rowCounts: { X: -1 },
      includedModels: [],
      excludedModels: [],
      excludedFields: [],
      loadOrder: [],
      deferredFks: [],
    };
    expect(() => parseLogicalManifest(bad)).toThrow();
  });
});
