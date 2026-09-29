/**
 * #346 — a PATCH schema must leave an omitted field omitted.
 *
 * The guard at the bottom walks EVERY exported `update*Schema` / `patch*Schema`
 * of this package, so a new one built as `createSchema.partial()` over a
 * `.default()` fails here rather than silently overwriting stored fields.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as shared from "./index.js";
import { keysFilledWhenAbsent, patchSchemaOf, withoutDefaults } from "./zod-patch.js";

const create = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  note: z.string().nullable().default(null),
  maybe: z.boolean().optional().default(false),
  later: z.number().default(3).optional(),
  pre: z.string().prefault("x"),
  plain: z.string().optional(),
});

describe("patchSchemaOf (#346)", () => {
  it("documents the zod 4 behaviour it exists for: .partial() still applies defaults", () => {
    expect(create.partial().parse({})).toMatchObject({ enabled: true, config: {}, note: null });
  });

  it("parses {} to {}", () => {
    expect(patchSchemaOf(create).parse({})).toEqual({});
  });

  it("keeps the fields a caller names, including an explicit false and null", () => {
    expect(patchSchemaOf(create).parse({ enabled: false, note: null, name: "n" })).toEqual({
      enabled: false,
      note: null,
      name: "n",
    });
  });

  it("keeps every validation rule", () => {
    const patch = patchSchemaOf(create);
    expect(patch.safeParse({ name: "" }).success).toBe(false);
    expect(patch.safeParse({ enabled: "yes" }).success).toBe(false);
    expect(patch.safeParse({ plain: 1 }).success).toBe(false);
  });

  it("keeps the object's unknown-key policy", () => {
    const strict = z.object({ a: z.string().default("a") }).strict();
    expect(patchSchemaOf(strict).safeParse({ b: 1 }).success).toBe(false);
  });

  it("does not change the create schema", () => {
    patchSchemaOf(create);
    expect(create.parse({ name: "n" })).toMatchObject({ enabled: true, config: {}, note: null });
  });

  it("withoutDefaults leaves required fields required", () => {
    const stripped = withoutDefaults(create);
    expect(stripped.safeParse({ name: "n" }).success).toBe(false);
    expect(keysFilledWhenAbsent(stripped)).toEqual([]);
  });
});

describe("keysFilledWhenAbsent (#346)", () => {
  it("names every key that takes a value when absent", () => {
    expect(keysFilledWhenAbsent(create.partial()).sort()).toEqual(
      ["config", "enabled", "later", "maybe", "note", "pre"].sort(),
    );
  });

  it("is empty for a default-free schema", () => {
    expect(keysFilledWhenAbsent(z.object({ a: z.string().optional() }))).toEqual([]);
  });
});

/** Every exported update/patch object schema of @metis/shared. */
function exportedPatchSchemas(): Array<[string, z.ZodObject]> {
  return Object.entries(shared).filter(
    (entry): entry is [string, z.ZodObject] =>
      /^(update|patch)\w*Schema$/i.test(entry[0]) && entry[1] instanceof z.ZodObject,
  );
}

describe("guard: no exported PATCH schema fills an omitted field (#346)", () => {
  it("finds the schemas it is meant to guard", () => {
    const names = exportedPatchSchemas().map(([n]) => n);
    // A regex that silently matched nothing would make the guard below vacuous.
    for (const expected of [
      "updateProjectSchema",
      "updateRepoConnectorSchema",
      "updateScheduledJobSchema",
      "updateUserSchema",
      "updateStakeholderSchema",
      "updateDatabaseConnectorSchema",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(exportedPatchSchemas())("%s leaves an omitted field omitted", (_name, schema) => {
    expect(keysFilledWhenAbsent(schema)).toEqual([]);
  });
});

describe("patchSchemaOf fails loudly on a default it cannot strip (#346 review round 2)", () => {
  it("throws, naming the key, for a .default() nested inside a .transform()", () => {
    const create = z.object({
      name: z.string(),
      tag: z
        .string()
        .default("x")
        .transform((v) => v.toUpperCase()),
    });
    // Demonstrates the gap the throw closes: the plain strip leaves it filled.
    expect(keysFilledWhenAbsent(withoutDefaults(create).partial())).toEqual(["tag"]);
    expect(() => patchSchemaOf(create)).toThrow(/tag/);
  });

  it("throws for a .default() nested inside a .pipe()", () => {
    const create = z.object({ n: z.string().default("1").pipe(z.coerce.number()) });
    expect(() => patchSchemaOf(create)).toThrow(/patchSchemaOf: field\(s\) n /);
  });

  it("still builds for a transform with no default inside", () => {
    const create = z.object({
      name: z.string().transform((v) => v.trim()),
      enabled: z.boolean().default(true),
    });
    const patch = patchSchemaOf(create);
    expect(patch.parse({})).toEqual({});
    expect(patch.parse({ name: " a " })).toEqual({ name: "a" });
  });
});
