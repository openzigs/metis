/**
 * Issue #900 (Epic #883) — EF Core lineage unit tests.
 *
 * Covers the three EF mapping-shape parsers (`ef-extractor.ts`), the shared
 * resolver factory (`buildEfCoreEntityResolver`, `entity-resolver.ts`), and the
 * DbSet/LINQ call-site scanner + persistence (`ef-callsite-extractor.ts`).
 * Pure static parsing — no SQL executed.
 */
import { describe, expect, it } from "vitest";
import {
  parseEfDbSets,
  parseEfEntities,
  parseEfFluentTables,
} from "../../../src/lib/code-graph/ef-extractor.js";
import { buildEfCoreEntityResolver } from "../../../src/lib/code-graph/entity-resolver.js";
import {
  buildEfDbSetTableMap,
  findEfCallSites,
  persistEfCallSiteEdges,
} from "../../../src/lib/code-graph/ef-callsite-extractor.js";
import { SchemaGraphWriter } from "../../../src/lib/code-graph/schema-graph.js";

const ENTITIES_CS = `namespace Shop.Domain;

using System.ComponentModel.DataAnnotations.Schema;

[Table("customers", Schema = "sales")]
public class Customer
{
    [Column("customer_id")]
    public int Id { get; set; }
    public string FullName { get; set; }
}

public class Product
{
    public int Id { get; set; }
    public string Name { get; set; }
}

[Table("legacy_orders")]
public class Order
{
    public int Id { get; set; }
}
`;

const CONTEXT_CS = `namespace Shop.Data;

using Microsoft.EntityFrameworkCore;
using Shop.Domain;

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers { get; set; }
    public DbSet<Product> Products { get; set; }
    public DbSet<Order> Orders { get; set; }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Order>().ToTable("orders_2024", "archive");
        modelBuilder.Entity<Product>(e =>
        {
            e.ToTable("catalog_products");
        });
    }
}
`;

describe("parseEfEntities", () => {
  it("parses [Table]/[Column] annotations and property fields", () => {
    const shapes = parseEfEntities(ENTITIES_CS);
    const customer = shapes.find((s) => s.className === "Customer");
    expect(customer?.attrTable).toBe("customers");
    expect(customer?.attrSchema).toBe("sales");
    // [Column] override + snake_case default for an unannotated property.
    expect(customer?.fields).toEqual(
      expect.arrayContaining([
        { field: "Id", column: "customer_id" },
        { field: "FullName", column: "full_name" },
      ]),
    );
    // A plain POCO still parses; it simply has no table attribute.
    expect(shapes.find((s) => s.className === "Product")?.attrTable).toBeNull();
  });
});

describe("parseEfDbSets", () => {
  it("links each DbSet property to its entity type", () => {
    const sets = parseEfDbSets(CONTEXT_CS);
    expect(sets).toEqual(
      expect.arrayContaining([
        { property: "Customers", entity: "Customer" },
        { property: "Products", entity: "Product" },
        { property: "Orders", entity: "Order" },
      ]),
    );
  });
});

describe("parseEfFluentTables", () => {
  it("parses direct-chain and lambda-form ToTable mappings incl. schema", () => {
    const fluent = parseEfFluentTables(CONTEXT_CS);
    expect(fluent).toEqual(
      expect.arrayContaining([
        { entity: "Order", table: "orders_2024", schema: "archive" },
        { entity: "Product", table: "catalog_products", schema: null },
      ]),
    );
  });

  it("does not misattribute one entity's ToTable to another", () => {
    const src = `modelBuilder.Entity<A>();
      modelBuilder.Entity<B>().ToTable("b_tbl");`;
    const fluent = parseEfFluentTables(src);
    // A has no ToTable in its window; only B resolves.
    expect(fluent).toEqual([{ entity: "B", table: "b_tbl", schema: null }]);
  });
});

describe("buildEfCoreEntityResolver — precedence fluent > attribute > DbSet-name > class", () => {
  const resolver = buildEfCoreEntityResolver(
    new Map([
      ["Domain/Entities.cs", ENTITIES_CS],
      ["Data/ShopContext.cs", CONTEXT_CS],
    ]),
  );

  it("uses the [Table] attribute + schema when no fluent override exists", () => {
    expect(resolver.resolveEntity("Customer")).toEqual({ table: "customers", schema: "sales" });
  });

  it("uses the DbSet property-name convention for an unmapped entity", () => {
    // Product has no [Table]; fluent maps it to catalog_products (fluent wins).
    expect(resolver.resolveEntity("Product")).toEqual({ table: "catalog_products" });
  });

  it("lets a fluent ToTable override a [Table] attribute", () => {
    // Order carries [Table("legacy_orders")] but fluent ToTable("orders_2024").
    expect(resolver.resolveEntity("Order")).toEqual({ table: "orders_2024", schema: "archive" });
  });

  it("resolves [Column]-mapped fields", () => {
    expect(resolver.resolveField("Customer", "Id")).toEqual({
      table: "customers",
      schema: "sales",
      column: "customer_id",
    });
  });

  it("returns null for an entity with no EF signal at all", () => {
    expect(resolver.resolveEntity("NotAnEntity")).toBeNull();
  });

  it("falls back to the class name when only a bare DbSet exists (no attr, no fluent)", () => {
    const r = buildEfCoreEntityResolver(
      new Map([["Ctx.cs", `class Db : DbContext { public DbSet<Widget> Gadgets { get; set; } }`]]),
    );
    // DbSet property name convention: table = "gadgets".
    expect(r.resolveEntity("Widget")).toEqual({ table: "gadgets" });
  });
});

describe("buildEfDbSetTableMap + findEfCallSites", () => {
  const resolver = buildEfCoreEntityResolver(
    new Map([
      ["Domain/Entities.cs", ENTITIES_CS],
      ["Data/ShopContext.cs", CONTEXT_CS],
    ]),
  );
  const dbSets = buildEfDbSetTableMap(new Map([["Data/ShopContext.cs", CONTEXT_CS]]), resolver);

  it("maps each DbSet property to its resolved physical table", () => {
    expect(dbSets.get("Customers")).toEqual({ table: "customers", schema: "sales" });
    expect(dbSets.get("Products")).toEqual({ table: "catalog_products" });
  });

  it("detects read vs write DbSet call sites regardless of receiver, and nothing else", () => {
    const src = [
      "var a = context.Customers.Where(x => x.Id == 1).First();", // read
      "_db.Products.Add(newProduct);", // write
      "await this.Db.Customers.ToListAsync();", // read
      "context.Customers.SomethingElse();", // not an EF op — ignored
      "helper.Where(x => x);", // not a DbSet property — ignored
    ].join("\n");
    const sites = findEfCallSites(src, dbSets);
    expect(sites.map((s) => `${s.property}.${s.op}:${s.kind}`)).toEqual([
      "Customers.Where:reads",
      "Products.Add:writes",
      "Customers.ToListAsync:reads",
    ]);
  });

  it("is empty when there are no DbSets", () => {
    expect(findEfCallSites("context.Customers.Where(x => x);", new Map())).toEqual([]);
  });

  it("dedupes a repeated DbSet property and skips a DbSet whose entity is ambiguous", () => {
    // `Thing` is ambiguous: two classes claim the name with DIFFERENT tables, so
    // the resolver returns null and the DbSet is omitted. `Customers` is declared
    // twice (two partial DbContext files) — the second declaration is deduped.
    const ambiguous = buildEfCoreEntityResolver(
      new Map([
        ["a.cs", `[Table("t_one")] public class Thing { }`],
        ["b.cs", `[Table("t_two")] public class Thing { }`],
      ]),
    );
    const map = buildEfDbSetTableMap(
      new Map([
        ["ctx1.cs", `class Db1 : DbContext { public DbSet<Thing> Things { get; set; } }`],
        ["ctx2.cs", `class Db2 : DbContext { public DbSet<Customer> Customers { get; set; } }`],
        ["ctx3.cs", `class Db3 : DbContext { public DbSet<Order> Customers { get; set; } }`],
      ]),
      buildEfCoreEntityResolver(
        new Map([
          ["a.cs", `[Table("t_one")] public class Thing { }`],
          ["b.cs", `[Table("t_two")] public class Thing { }`],
          ["ent.cs", ENTITIES_CS],
        ]),
      ),
    );
    // Ambiguous `Thing` omitted.
    expect(ambiguous.resolveEntity("Thing")).toBeNull();
    expect(map.has("Things")).toBe(false);
    // `Customers` property declared twice — first (Customer entity) wins.
    expect(map.get("Customers")).toEqual({ table: "customers", schema: "sales" });
  });
});

/** Minimal fake writer capturing created symbols + edges. */
function fakeWriter() {
  const symbols: { kind: string; name: string }[] = [];
  const edges: { kind: string; source: string; fromSymbolId: string }[] = [];
  let n = 0;
  const prisma = {
    codeSymbol: {
      create: async ({ data }: { data: { kind: string; name: string } }) => {
        symbols.push(data);
        return { id: `${data.kind}-${++n}` };
      },
    },
    codeEdge: {
      create: async ({
        data,
      }: {
        data: { kind: string; source: string; fromSymbolId: string };
      }) => {
        edges.push(data);
        return undefined;
      },
    },
  };
  return { writer: new SchemaGraphWriter(prisma as never, "g", "p"), symbols, edges };
}

describe("persistEfCallSiteEdges", () => {
  const resolver = buildEfCoreEntityResolver(
    new Map([
      ["ctx.cs", CONTEXT_CS],
      ["ent.cs", ENTITIES_CS],
    ]),
  );
  const dbSets = buildEfDbSetTableMap(new Map([["ctx.cs", CONTEXT_CS]]), resolver);

  it("emits reads/writes edges from the enclosing symbol, source=orm, deduped", async () => {
    const { writer, symbols, edges } = fakeWriter();
    const src = [
      "public void Handle() {", // line 1
      "  context.Customers.Where(x => x.Id == 1);", // read
      "  context.Customers.ToList();", // read — same (from,table,kind), deduped
      "  context.Customers.Add(c);", // write — distinct kind, kept
      "}",
    ].join("\n");
    const written = await persistEfCallSiteEdges(writer, "Svc.cs", src, dbSets, [
      { id: "fn-handle", startLine: 1, endLine: 5 },
    ]);
    expect(written).toBe(2); // one reads + one writes (ToList deduped into the read)
    expect(edges.map((e) => e.kind).sort()).toEqual(["reads", "writes"]);
    expect(edges.every((e) => e.fromSymbolId === "fn-handle" && e.source === "orm")).toBe(true);
    // Only the table symbol is created — no synthetic origin symbols.
    expect(symbols.map((s) => s.kind)).toEqual(["table"]);
  });

  it("skips call sites with no enclosing persisted symbol — never fabricates origins", async () => {
    const { writer, edges } = fakeWriter();
    const written = await persistEfCallSiteEdges(
      writer,
      "Svc.cs",
      "context.Customers.Add(c);",
      dbSets,
      [],
    );
    expect(written).toBe(0);
    expect(edges).toHaveLength(0);
  });
});
