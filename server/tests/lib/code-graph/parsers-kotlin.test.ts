/**
 * Issue #159 — Kotlin parser tests.
 *
 * Proves `.kt` / `.kts` files parse into the standard `ParsedFile` shape
 * (symbols, calls, imports) via BOTH backends: the regex fallback (no
 * tree-sitter boot) and the `@tree-sitter-grammars/tree-sitter-kotlin` grammar.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectLanguage,
  parseSource,
  type ParsedFile,
} from "../../../src/lib/code-graph/parsers.js";
import {
  __resetCodeGraphParsersForTests,
  initCodeGraphParsers,
  isTreeSitterReady,
} from "../../../src/lib/code-graph/parsers-tree-sitter.js";

const FILE = "src/main/kotlin/com/acme/orders/OrderService.kt";
const SAMPLE = `package com.acme.orders

import com.acme.billing.Invoice
import kotlinx.coroutines.*
import com.acme.util.Money as Cash

// WHY: orders are validated before they reach billing.
data class OrderRequest(
    @field:NotBlank val customerId: String,
    @field:Min(1) val quantity: Int,
    note: String,
)

interface OrderRepository {
    fun save(order: Order): Order
}

enum class OrderStatus { PENDING, SHIPPED }

class OrderService(private val repo: OrderRepository) {
    val maxItems = 50

    fun place(request: OrderRequest): Receipt {
        require(request.quantity > 0) { "quantity must be positive" }
        val order = Order(request.customerId)
        val saved = repo.save(order)
        this.audit(saved)
        return Receipt(saved.id)
    }

    private fun audit(order: Order) = println(order)

    companion object {
        fun create(): OrderService = OrderService(InMemoryRepo())
    }
}

object Registry {
    fun lookup(id: String) = id.trim()
}

fun topLevel(x: Int): Int = x * 2
`;

const names = (r: ParsedFile, kind: string): string[] =>
  r.symbols.filter((s) => s.kind === kind).map((s) => s.name);
const edgeTargets = (r: ParsedFile, kind: string): string[] =>
  r.edges.filter((e) => e.kind === kind).map((e) => e.toQualifiedName);

describe("Kotlin — detectLanguage", () => {
  it("maps .kt and .kts to the `kt` language", () => {
    expect(detectLanguage("src/main/kotlin/Order.kt")).toBe("kt");
    expect(detectLanguage("build.gradle.kts")).toBe("kt");
    expect(detectLanguage("Order.KT")).toBe("kt");
  });
});

describe("Kotlin regex fallback parser (no tree-sitter boot)", () => {
  it("captures classes, object, interface, enum, and functions", () => {
    expect(isTreeSitterReady()).toBe(false);
    const r = parseSource(FILE, SAMPLE, "kt");
    expect(r.language).toBe("kt");
    expect(r.unparseable).toBeFalsy();
    expect(names(r, "class")).toEqual(
      expect.arrayContaining(["OrderRequest", "OrderService", "Registry"]),
    );
    expect(names(r, "interface")).toEqual(["OrderRepository"]);
    expect(names(r, "type")).toEqual(["OrderStatus"]);
    expect(names(r, "function")).toEqual(["topLevel"]);
    expect(names(r, "method")).toEqual(
      expect.arrayContaining(["save", "place", "audit", "create", "lookup"]),
    );
    expect(r.symbols.filter((s) => s.kind === "module")).toHaveLength(1);
  });

  it("ends an expression-bodied function on its own line", () => {
    const r = parseSource(FILE, SAMPLE, "kt");
    const audit = r.symbols.find((s) => s.name === "audit")!;
    expect(audit.endLine).toBe(audit.startLine);
    const place = r.symbols.find((s) => s.name === "place")!;
    expect(place.endLine - place.startLine).toBe(6);
  });

  it("does not let an expression body borrow the next declaration's block", () => {
    const r = parseSource(FILE, `fun a() = 1\nfun b() {\n    a()\n}\n`, "kt");
    const a = r.symbols.find((s) => s.name === "a")!;
    expect([a.startLine, a.endLine]).toEqual([1, 1]);
    const b = r.symbols.find((s) => s.name === "b")!;
    expect([b.startLine, b.endLine]).toEqual([2, 4]);
  });

  it("emits import edges, including wildcard and aliased imports", () => {
    const r = parseSource(FILE, SAMPLE, "kt");
    expect(edgeTargets(r, "imports")).toEqual([
      "com.acme.billing.Invoice",
      "kotlinx.coroutines.*",
      "com.acme.util.Money",
    ]);
  });

  it("captures a `// WHY:` rationale hint", () => {
    const r = parseSource(FILE, SAMPLE, "kt");
    expect(r.rationaleHints.map((h) => h.tag)).toEqual(["WHY"]);
  });
});

describe("Kotlin tree-sitter parser", () => {
  beforeAll(async () => {
    await initCodeGraphParsers();
  }, 30_000);
  afterAll(() => {
    __resetCodeGraphParsersForTests();
  });

  it("loads the Kotlin grammar and parses without falling back", () => {
    expect(isTreeSitterReady()).toBe(true);
    const r = parseSource(FILE, SAMPLE, "kt");
    expect(r.unparseable).toBeFalsy();
    expect(r.language).toBe("kt");
  });

  it("records types with nested qualified names", () => {
    const r = parseSource(FILE, SAMPLE, "kt");
    expect(names(r, "class")).toEqual(["OrderRequest", "OrderService", "Registry"]);
    expect(names(r, "interface")).toEqual(["OrderRepository"]);
    expect(names(r, "type")).toEqual(["OrderStatus"]);
    expect(names(r, "function")).toEqual(["topLevel"]);
    const place = r.symbols.find((s) => s.name === "place")!;
    expect(place.kind).toBe("method");
    expect(place.qualifiedName).toMatch(/OrderService.*place$/);
    // Companion members are named on the enclosing class.
    const create = r.symbols.find((s) => s.name === "create")!;
    expect(create.qualifiedName).toMatch(/OrderService.*create$/);
    expect(create.qualifiedName).not.toMatch(/Companion/);
  });

  it("records type properties and val/var constructor parameters, not locals", () => {
    const r = parseSource(FILE, SAMPLE, "kt");
    const members = names(r, "method");
    expect(members).toEqual(expect.arrayContaining(["customerId", "quantity", "repo", "maxItems"]));
    // `note` has no val/var — a plain constructor parameter, not a property.
    expect(members).not.toContain("note");
    // Locals inside `place` are not symbols.
    expect(members).not.toContain("order");
    expect(members).not.toContain("saved");
    // The annotated parameter's range starts at its annotation line.
    const customerId = r.symbols.find((s) => s.name === "customerId")!;
    expect(SAMPLE.split("\n")[customerId.startLine - 1]).toContain("@field:NotBlank");
  });

  it("emits calls with receivers, and constructor calls as references", () => {
    const r = parseSource(FILE, SAMPLE, "kt");
    const calls = r.edges.filter((e) => e.kind === "calls");
    const save = calls.find((e) => e.toQualifiedName === "save")!;
    expect(save.receiver).toBe("repo");
    expect(save.fromQualifiedName).toMatch(/place$/);
    expect(calls.find((e) => e.toQualifiedName === "audit")!.receiver).toBe("this");
    const require = calls.find((e) => e.toQualifiedName === "require")!;
    expect(require.receiver).toBeUndefined();
    expect(edgeTargets(r, "calls")).toEqual(expect.arrayContaining(["trim", "println"]));
    expect(edgeTargets(r, "references")).toEqual(
      expect.arrayContaining(["Order", "Receipt", "OrderService", "InMemoryRepo"]),
    );
    expect(edgeTargets(r, "calls")).not.toContain("Order");
  });

  it("emits import edges and module-level defines", () => {
    const r = parseSource(FILE, SAMPLE, "kt");
    expect(edgeTargets(r, "imports")).toEqual([
      "com.acme.billing.Invoice",
      "kotlinx.coroutines.*",
      "com.acme.util.Money",
    ]);
    const defines = r.edges.filter((e) => e.kind === "defines");
    expect(defines.length).toBeGreaterThanOrEqual(r.symbols.length - 1);
  });

  it("captures KDoc and `// WHY:` rationale hints", () => {
    const r = parseSource(FILE, `/**\n * Places orders.\n */\nclass A\n${SAMPLE}`, "kt");
    expect(r.rationaleHints.map((h) => h.tag)).toEqual(["JSDOC", "WHY"]);
  });

  it("parses a Kotlin script (.kts)", () => {
    const r = parseSource(
      "build.gradle.kts",
      `plugins {\n    kotlin("jvm") version "2.0.0"\n}\ndependencies {\n    implementation("x:y:1")\n}\n`,
      "kt",
    );
    expect(r.unparseable).toBeFalsy();
    expect(edgeTargets(r, "calls")).toEqual(
      expect.arrayContaining(["plugins", "kotlin", "dependencies", "implementation"]),
    );
  });
});
