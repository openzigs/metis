/**
 * Issue #900 (Epic #883) — C#/.NET parser tests.
 *
 * Proves `.cs` files parse into the standard `ParsedFile` shape (classes,
 * methods, properties, using-imports) via BOTH backends: the deterministic
 * regex fallback (no tree-sitter boot) and the `web-tree-sitter` grammar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectLanguage, parseSource } from "../../../src/lib/code-graph/parsers.js";
import {
  __resetCodeGraphParsersForTests,
  findStringLiterals,
  initCodeGraphParsers,
  isTreeSitterReady,
} from "../../../src/lib/code-graph/parsers-tree-sitter.js";

const SAMPLE = `namespace Shop.Data;

using System.Data;
using Microsoft.EntityFrameworkCore;

// WHY: EF Core entity mapped to a physical table.
[Table("customers")]
public class Customer
{
    [Column("customer_id")]
    public int Id { get; set; }
    public string FullName { get; set; }
}

public interface IRepository
{
    Customer Find(int id);
}

public enum Status { Active, Closed }

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers { get; set; }

    public Customer Find(int id)
    {
        var cmd = new SqlCommand("SELECT * FROM orders WHERE id = @id");
        return Customers.Where(x => x.Id == id).First();
    }
}
`;

describe("C# — detectLanguage", () => {
  it("maps .cs and .csx to the `cs` language", () => {
    expect(detectLanguage("src/Shop/Customer.cs")).toBe("cs");
    expect(detectLanguage("script.csx")).toBe("cs");
  });
});

describe("C# regex fallback parser (no tree-sitter boot)", () => {
  it("captures classes, interface, enum and methods as symbols", () => {
    // This describe runs before the tree-sitter describe boots the grammars,
    // so `parseSource` exercises the deterministic regex fallback here.
    expect(isTreeSitterReady()).toBe(false);
    const r = parseSource("Customer.cs", SAMPLE, "cs");
    expect(r.language).toBe("cs");
    expect(r.unparseable).toBeFalsy();
    const byName = (k: string) => r.symbols.filter((s) => s.kind === k).map((s) => s.name);
    expect(byName("class")).toEqual(expect.arrayContaining(["Customer", "ShopContext"]));
    expect(byName("interface")).toContain("IRepository");
    expect(byName("type")).toContain("Status");
    expect(byName("method")).toContain("Find");
  });

  it("emits `using` directives as import edges and skips resource-usings", () => {
    const r = parseSource("Customer.cs", SAMPLE, "cs");
    const imports = r.edges.filter((e) => e.kind === "imports").map((e) => e.toQualifiedName);
    expect(imports).toEqual(
      expect.arrayContaining(["System.Data", "Microsoft.EntityFrameworkCore"]),
    );
    // `var cmd = new SqlCommand(...)` must NOT be read as an import.
    expect(imports).not.toContain("var");
  });

  it("captures a `// WHY:` rationale hint", () => {
    const r = parseSource("Customer.cs", SAMPLE, "cs");
    expect(r.rationaleHints.some((h) => h.tag === "WHY")).toBe(true);
  });

  it("always emits exactly one module symbol", () => {
    const r = parseSource("Customer.cs", SAMPLE, "cs");
    expect(r.symbols.filter((s) => s.kind === "module")).toHaveLength(1);
  });
});

describe("C# tree-sitter parser", () => {
  beforeAll(async () => {
    await initCodeGraphParsers();
  }, 30_000);
  afterAll(() => {
    __resetCodeGraphParsersForTests();
  });

  it("loads the C# grammar", () => {
    expect(isTreeSitterReady()).toBe(true);
  });

  it("captures nested class members (properties + methods) the regex path may miss", () => {
    const r = parseSource("Customer.cs", SAMPLE, "cs");
    expect(r.unparseable).toBeFalsy();
    const classes = r.symbols.filter((s) => s.kind === "class").map((s) => s.name);
    expect(classes).toEqual(expect.arrayContaining(["Customer", "ShopContext"]));
    // The EF `DbSet<Customer> Customers` property is captured as a member.
    const members = r.symbols.map((s) => s.name);
    expect(members).toContain("Customers");
    // Interface + enum.
    expect(r.symbols.some((s) => s.kind === "interface" && s.name === "IRepository")).toBe(true);
    expect(r.symbols.some((s) => s.kind === "type" && s.name === "Status")).toBe(true);
  });

  it("emits `calls` edges for LINQ/DbSet invocations", () => {
    const r = parseSource("Customer.cs", SAMPLE, "cs");
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.toQualifiedName);
    expect(calls).toEqual(expect.arrayContaining(["Where", "First"]));
  });

  it("emits `references` edges for generic and qualified `new` expressions", () => {
    const src = `namespace N {
class Builder {
  void Make() {
    var list = new List<Customer>();
    var sb = new System.Text.StringBuilder();
    var cmd = new SqlCommand("x");
    var all = repo.GetAll<Customer>();
  }
} }`;
    const r = parseSource("Builder.cs", src, "cs");
    const refs = r.edges.filter((e) => e.kind === "references").map((e) => e.toQualifiedName);
    // generic_name `new List<Customer>()`, qualified `new System.Text.StringBuilder()`,
    // and plain `new SqlCommand()`.
    expect(refs).toEqual(expect.arrayContaining(["List", "StringBuilder", "SqlCommand"]));
    // A generic invocation `repo.GetAll<Customer>()` resolves its callee name.
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.toQualifiedName);
    expect(calls).toContain("GetAll");
  });

  it("finds embedded SQL string literals (ADO.NET/Dapper candidates)", () => {
    const lits = findStringLiterals(SAMPLE, "cs");
    expect(lits.some((l) => /SELECT \* FROM orders/i.test(l.text))).toBe(true);
  });

  it("strips C# verbatim/interpolated string prefixes", () => {
    const src = `class C { void M() {
      var a = @"C:\\temp\\SELECT";
      var b = $"SELECT * FROM t WHERE id = {id}";
    } }`;
    const lits = findStringLiterals(src, "cs");
    const verbatim = lits.find((l) => l.text.startsWith("C:"));
    expect(verbatim).toBeTruthy();
    const interpolated = lits.find((l) => l.text.startsWith("SELECT * FROM t"));
    expect(interpolated?.dynamic).toBe(true);
  });
});
