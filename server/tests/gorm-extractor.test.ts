/**
 * Issue #899 (Epic #883) — Go GORM model→physical-table lineage: entity
 * resolution (GORM struct -> physical table), NOT SQL parsing. Covers
 * pluralization, struct/table/column parsing (default + `TableName()` override
 * + `gorm:"column:"` tag + embedded `gorm.Model` + `gorm:"-"` ignore), the
 * reused framework-agnostic resolver factory, GORM call-site detection, and
 * edge persistence anchored to the real enclosing Go function symbol (mirrors
 * `jooq-extractor.test.ts`'s coverage of #897).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- lightweight in-memory Prisma fakes */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildGormEntityResolver,
  defaultGormTableName,
  findGormCallSites,
  parseGormModels,
  persistGormCallSiteEdges,
  pluralize,
} from "../src/lib/code-graph/gorm-extractor.js";
import { SchemaGraphWriter } from "../src/lib/code-graph/schema-graph.js";

const FIX = join(__dirname, "fixtures", "gorm");
const modelsSrc = readFileSync(join(FIX, "models.go"), "utf8");
const repoSrc = readFileSync(join(FIX, "repo.go"), "utf8");

describe("pluralize", () => {
  it("adds -s for regular words", () => {
    expect(pluralize("user")).toBe("users");
    expect(pluralize("credit_card")).toBe("credit_cards");
  });

  it("adds -es for sibilant endings", () => {
    expect(pluralize("bus")).toBe("buses");
    expect(pluralize("box")).toBe("boxes");
    expect(pluralize("match")).toBe("matches");
    expect(pluralize("dish")).toBe("dishes");
  });

  it("turns consonant+y into -ies", () => {
    expect(pluralize("category")).toBe("categories");
    expect(pluralize("company")).toBe("companies");
  });

  it("keeps vowel+y as -s", () => {
    expect(pluralize("day")).toBe("days");
  });

  it("returns the empty string unchanged", () => {
    expect(pluralize("")).toBe("");
  });
});

describe("defaultGormTableName", () => {
  it("snake_cases then pluralizes the struct name", () => {
    expect(defaultGormTableName("User")).toBe("users");
    expect(defaultGormTableName("CreditCard")).toBe("credit_cards");
    expect(defaultGormTableName("Category")).toBe("categories");
  });
});

describe("parseGormModels", () => {
  const models = parseGormModels(modelsSrc);

  it("finds every struct and maps it to its table", () => {
    const byName = new Map(models.map((m) => [m.structName, m]));
    expect(byName.get("User")?.table).toBe("users");
    expect(byName.get("CreditCard")?.table).toBe("credit_cards");
    // TableName() override wins over the default `profiles`.
    expect(byName.get("Profile")?.table).toBe("account_profiles");
  });

  it('resolves columns from the gorm:"column:" tag, else snake_case', () => {
    const user = parseGormModels(modelsSrc).find((m) => m.structName === "User")!;
    expect(user.fields.get("name")).toBe("full_name"); // explicit column tag
    expect(user.fields.get("email")).toBe("email"); // snake_case default
    expect(user.fields.get("age")).toBe("age");
  });

  it("expands an embedded gorm.Model to the standard columns", () => {
    const user = parseGormModels(modelsSrc).find((m) => m.structName === "User")!;
    expect(user.fields.get("id")).toBe("id");
    expect(user.fields.get("createdat")).toBe("created_at");
    expect(user.fields.get("updatedat")).toBe("updated_at");
    expect(user.fields.get("deletedat")).toBe("deleted_at");
  });

  it('ignores a gorm:"-" field', () => {
    const user = parseGormModels(modelsSrc).find((m) => m.structName === "User")!;
    expect(user.fields.has("notes")).toBe(false);
  });

  it("returns [] for a file with no struct", () => {
    expect(parseGormModels("package p\nfunc main() {}\n")).toEqual([]);
  });
});

describe("buildGormEntityResolver (#899, reuses #896 resolver)", () => {
  const resolver = buildGormEntityResolver(new Map([["models.go", modelsSrc]]));

  it("resolves a struct name to its physical table", () => {
    expect(resolver.resolveEntity("User")).toEqual({ table: "users", schema: undefined });
    expect(resolver.resolveEntity("CreditCard")).toEqual({
      table: "credit_cards",
      schema: undefined,
    });
    expect(resolver.resolveEntity("Profile")).toEqual({
      table: "account_profiles",
      schema: undefined,
    });
  });

  it("resolves a field to its column", () => {
    expect(resolver.resolveField("User", "name")).toEqual({
      table: "users",
      schema: undefined,
      column: "full_name",
    });
  });

  it("returns null for an unknown struct", () => {
    expect(resolver.resolveEntity("Nope")).toBeNull();
  });

  it("skips sources with no struct without throwing", () => {
    const empty = buildGormEntityResolver(new Map([["x.go", "package p\n"]]));
    expect(empty.resolveEntity("User")).toBeNull();
  });
});

describe("findGormCallSites", () => {
  const resolver = buildGormEntityResolver(new Map([["models.go", modelsSrc]]));

  it("detects a Model() read chain -> reads users", () => {
    const sites = findGormCallSites(
      'db.Model(&User{}).Where("age > ?", 18).Find(&users)',
      resolver,
    );
    expect(sites).toEqual([
      { line: 1, op: "Find", kind: "reads", target: { table: "users", schema: undefined } },
    ]);
  });

  it("detects a composite-literal Create -> writes users", () => {
    const sites = findGormCallSites("db.Create(&User{Name: name})", resolver);
    expect(sites[0]).toMatchObject({ kind: "writes", target: { table: "users" } });
  });

  it("treats a chain with a write verb as a write even after a Model() read setup", () => {
    const sites = findGormCallSites(
      'db.Model(&User{}).Where("id = ?", id).Update("full_name", name)',
      resolver,
    );
    expect(sites[0]).toMatchObject({ kind: "writes", target: { table: "users" } });
  });

  it("resolves a slice-type Delete -> writes credit_cards", () => {
    const sites = findGormCallSites("db.Delete(&CreditCard{}, id)", resolver);
    expect(sites[0]).toMatchObject({ kind: "writes", target: { table: "credit_cards" } });
  });

  it('resolves an explicit .Table("...") literal directly, without a model', () => {
    const sites = findGormCallSites(
      'db.Table("users").Where("age > ?", 21).Find(&users)',
      resolver,
    );
    expect(sites[0]).toMatchObject({ kind: "reads", target: { table: "users" } });
  });

  it("skips a finisher line whose model type is not statically resolvable", () => {
    // `users` is a variable declared elsewhere — no type literal on the line.
    expect(findGormCallSites("db.Find(&users)", resolver)).toEqual([]);
  });

  it("skips a finisher line referencing an unknown struct", () => {
    expect(findGormCallSites("db.Model(&Widget{}).Find(&ws)", resolver)).toEqual([]);
  });

  it("skips a line with no GORM finisher verb", () => {
    expect(findGormCallSites('x := &User{Name: "a"}', resolver)).toEqual([]);
  });
});

function fakeWriter() {
  const symbols: any[] = [];
  const edges: any[] = [];
  let n = 0;
  const prisma = {
    codeSymbol: {
      create: async ({ data }: any) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      },
    },
    codeEdge: {
      create: async ({ data }: any) => {
        edges.push(data);
        return undefined;
      },
    },
  };
  return { writer: new SchemaGraphWriter(prisma as never, "g", "p"), symbols, edges };
}

describe("persistGormCallSiteEdges", () => {
  const resolver = buildGormEntityResolver(new Map([["models.go", modelsSrc]]));

  it("persists reads/writes edges FROM the real enclosing symbol, source = orm", async () => {
    const { writer, edges } = fakeWriter();
    const written = await persistGormCallSiteEdges(writer, "repo.go", repoSrc, resolver, [
      { id: "fn-FindAllUsers", startLine: 10, endLine: 14 },
      { id: "fn-CreateUser", startLine: 17, endLine: 19 },
      { id: "fn-RenameUser", startLine: 22, endLine: 24 },
      { id: "fn-DeleteCard", startLine: 27, endLine: 29 },
      { id: "fn-FindProfiles", startLine: 32, endLine: 36 },
      { id: "fn-FindByTable", startLine: 39, endLine: 43 },
    ]);
    expect(written).toBeGreaterThan(0);
    expect(edges.every((e: any) => e.source === "orm")).toBe(true);
    const read = edges.find((e: any) => e.fromSymbolId === "fn-FindAllUsers");
    expect(read.kind).toBe("reads");
    const write = edges.find((e: any) => e.fromSymbolId === "fn-CreateUser");
    expect(write.kind).toBe("writes");
    const profile = edges.find((e: any) => e.fromSymbolId === "fn-FindProfiles");
    expect(profile.toQualifiedName).toBe("account_profiles");
  });

  it("dedupes repeated (from, table, kind) call sites within one enclosing symbol", async () => {
    const { writer, edges } = fakeWriter();
    const src = [
      "func twoReads(db *gorm.DB) {", // line 1
      "  db.Model(&User{}).Find(&a)", // read
      "  db.Model(&User{}).Find(&b)", // read, same (from, table, kind) — deduped
      "}",
    ].join("\n");
    const written = await persistGormCallSiteEdges(writer, "x.go", src, resolver, [
      { id: "fn", startLine: 1, endLine: 4 },
    ]);
    expect(written).toBe(1);
    expect(edges).toHaveLength(1);
  });

  it("skips call sites with no enclosing persisted symbol — never fabricates origins", async () => {
    const { writer, edges } = fakeWriter();
    const written = await persistGormCallSiteEdges(
      writer,
      "x.go",
      "db.Model(&User{}).Find(&users)",
      resolver,
      [],
    );
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
  });

  it("is a no-op when there are no call sites", async () => {
    const { writer, edges } = fakeWriter();
    const written = await persistGormCallSiteEdges(writer, "x.go", "// nothing here", resolver, [
      { id: "fn", startLine: 1, endLine: 1 },
    ]);
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
  });
});
