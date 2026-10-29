import { YAMLException } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  YAML_MAX_ALIASES,
  YAML_MAX_TOTAL_MERGE_KEYS,
  loadYamlDocument,
  type YamlSchemaName,
} from "./yaml-load.js";

const ALL_SCHEMAS: YamlSchemaName[] = ["failsafe", "core", "core-merge"];

describe("loadYamlDocument (#915, js-yaml 5)", () => {
  describe.each(ALL_SCHEMAS)("schema %s", (schema) => {
    it.each(["", "   \n", "# only a comment\n", "---\n"])(
      "returns null for an empty stream or document %j",
      (text) => {
        expect(loadYamlDocument(text, { schema })).toBeNull();
      },
    );

    it("reads an empty value as null, as js-yaml 4 did, but keeps an explicit '' a string", () => {
      expect(loadYamlDocument("a:\nb: ''\nc: x", { schema })).toEqual({ a: null, b: "", c: "x" });
      expect(loadYamlDocument("- \n- x", { schema })).toEqual([null, "x"]);
      expect(loadYamlDocument("{a: , b}", { schema })).toEqual({ a: null, b: null });
    });

    it("rejects a multi-document stream, as v4's load() did", () => {
      expect(() => loadYamlDocument("a: 1\n---\nb: 2", { schema })).toThrow(YAMLException);
    });

    it("still rejects duplicate keys", () => {
      expect(() => loadYamlDocument("a: 1\na: 2", { schema })).toThrow(/duplicated mapping key/);
    });

    it("never constructs JS types from tags", () => {
      expect(() => loadYamlDocument('f: !!js/function "function () {}"', { schema })).toThrow(
        /unknown/,
      );
      expect(() => loadYamlDocument("r: !!js/regexp /x/", { schema })).toThrow(/unknown/);
    });

    it("does not pollute Object.prototype through a __proto__ key", () => {
      const parsed = loadYamlDocument("__proto__: {polluted: yes}", { schema });
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it(`caps aliases at ${YAML_MAX_ALIASES} per document unless the caller raises it`, () => {
      const refs = (n: number) =>
        `a: &a 1\nb: [${Array.from({ length: n }, () => "*a").join(", ")}]`;
      const atCap = loadYamlDocument(refs(YAML_MAX_ALIASES), { schema }) as { b: unknown[] };
      expect(atCap.b).toHaveLength(YAML_MAX_ALIASES);
      expect(() => loadYamlDocument(refs(YAML_MAX_ALIASES + 1), { schema })).toThrow(/maxAliases/);
      expect(() =>
        loadYamlDocument(refs(YAML_MAX_ALIASES + 1), { schema, maxAliases: YAML_MAX_ALIASES + 1 }),
      ).not.toThrow();
    });
  });

  it("failsafe keeps every other scalar a string", () => {
    expect(loadYamlDocument("n: 3\nb: true\nz: ~\nl: null", { schema: "failsafe" })).toEqual({
      n: "3",
      b: "true",
      z: "~",
      l: "null",
    });
    expect(() => loadYamlDocument("a: !!null x", { schema: "failsafe" })).toThrow(YAMLException);
  });

  it("core resolves scalars the way js-yaml 4's JSON_SCHEMA did", () => {
    expect(
      loadYamlDocument("a: ~\nb: True\nc: 0x1F\nd: .5\ne: NULL\nf: yes", { schema: "core" }),
    ).toEqual({ a: null, b: true, c: 31, d: 0.5, e: null, f: "yes" });
  });
});

describe("core-merge", () => {
  it("keeps v4's << merge keys", () => {
    const doc = loadYamlDocument("base: &b {k: 1}\nuse:\n  <<: *b\n  j: 2", {
      schema: "core-merge",
    });
    expect(doc).toEqual({ base: { k: 1 }, use: { k: 1, j: 2 } });
  });

  it("keeps a date-looking scalar a string (no Date from untrusted text)", () => {
    expect(loadYamlDocument("d: 2024-01-01", { schema: "core-merge" })).toEqual({
      d: "2024-01-01",
    });
  });

  it("does not pollute Object.prototype through a merged __proto__ key", () => {
    const doc = loadYamlDocument(
      "x: &x {__proto__: {polluted: 1}, k: 1}\nb:\n  <<: *x\nc:\n  <<: {__proto__: {p2: 1}}",
      { schema: "core-merge" },
    ) as Record<string, Record<string, unknown>>;
    for (const merged of [doc.b, doc.c]) {
      expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    }
    expect(doc.b.k).toBe(1);
    expect(doc.b.polluted).toBeUndefined();
    expect(doc.c.p2).toBeUndefined();
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(probe.p2).toBeUndefined();
  });

  it(`caps merge expansion at ${YAML_MAX_TOTAL_MERGE_KEYS} keys per load`, () => {
    expect(YAML_MAX_TOTAL_MERGE_KEYS).toBe(10_000);
    const mergeOf = (keys: number) =>
      `a: &a {${Array.from({ length: keys }, (_, i) => `k${i}: 1`).join(", ")}}\nb:\n  <<: *a\n`;
    const under = loadYamlDocument(mergeOf(YAML_MAX_TOTAL_MERGE_KEYS - 1), {
      schema: "core-merge",
    }) as Record<string, Record<string, unknown>>;
    expect(Object.keys(under.b)).toHaveLength(YAML_MAX_TOTAL_MERGE_KEYS - 1);
    expect(() =>
      loadYamlDocument(mergeOf(YAML_MAX_TOTAL_MERGE_KEYS + 1), { schema: "core-merge" }),
    ).toThrow(/maxTotalMergeKeys \(10000\)/);
  });
});
