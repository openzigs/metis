import { CORE_SCHEMA, FAILSAFE_SCHEMA, JSON_SCHEMA, YAMLException } from "js-yaml";
import { describe, expect, it } from "vitest";
import { CORE_WITH_MERGE_SCHEMA, loadYamlDocument } from "./yaml-load.js";

describe("loadYamlDocument (#915, js-yaml 5)", () => {
  it.each(["", "   \n", "# only a comment\n"])(
    "returns null for an empty stream %j instead of throwing",
    (text) => {
      expect(loadYamlDocument(text, { schema: FAILSAFE_SCHEMA })).toBeNull();
    },
  );

  it("returns null for an explicit empty document", () => {
    expect(loadYamlDocument("---\n", { schema: CORE_SCHEMA })).toBeNull();
  });

  it("parses a single document with the given schema", () => {
    expect(loadYamlDocument("a: 1\nb: true", { schema: JSON_SCHEMA })).toEqual({ a: 1, b: true });
    expect(loadYamlDocument("a: 1\nb: true", { schema: FAILSAFE_SCHEMA })).toEqual({
      a: "1",
      b: "true",
    });
  });

  it("rejects a multi-document stream, as v4's load() did", () => {
    expect(() => loadYamlDocument("a: 1\n---\nb: 2", { schema: CORE_SCHEMA })).toThrow(
      YAMLException,
    );
  });

  it("still rejects duplicate keys", () => {
    expect(() => loadYamlDocument("a: 1\na: 2", { schema: JSON_SCHEMA })).toThrow(
      /duplicated mapping key/,
    );
  });

  it.each([FAILSAFE_SCHEMA, JSON_SCHEMA, CORE_WITH_MERGE_SCHEMA])(
    "never constructs JS types from tags (schema %#)",
    (schema) => {
      expect(() => loadYamlDocument('f: !!js/function "function () {}"', { schema })).toThrow(
        /unknown/,
      );
      expect(() => loadYamlDocument("r: !!js/regexp /x/", { schema })).toThrow(/unknown/);
    },
  );

  it("does not pollute Object.prototype through a __proto__ key", () => {
    const parsed = loadYamlDocument("__proto__: {polluted: yes}", { schema: CORE_SCHEMA });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("CORE_WITH_MERGE_SCHEMA", () => {
  it("keeps v4's << merge keys", () => {
    const doc = loadYamlDocument("base: &b {k: 1}\nuse:\n  <<: *b\n  j: 2", {
      schema: CORE_WITH_MERGE_SCHEMA,
    });
    expect(doc).toEqual({ base: { k: 1 }, use: { k: 1, j: 2 } });
  });

  it("keeps a date-looking scalar a string (no Date from untrusted text)", () => {
    expect(loadYamlDocument("d: 2024-01-01", { schema: CORE_WITH_MERGE_SCHEMA })).toEqual({
      d: "2024-01-01",
    });
  });
});
