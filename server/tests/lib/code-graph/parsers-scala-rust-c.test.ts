/**
 * Issue #161 — Scala, Rust, C and C++ parser tests.
 *
 * Each language is parsed through the public `parseSource` entry point with the
 * tree-sitter grammars booted, as the ingest pipeline does, and the fixture's
 * symbols (modules/files, types, functions/methods) and edges (calls, imports,
 * constructor references) are asserted. Without a booted grammar these
 * languages record the module alone (no regex fallback), which is asserted too.
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

const SCALA_FILE = "src/main/scala/example/orders/OrderService.scala";
const SCALA = `package example.orders

import example.billing.Invoice
import scala.util.{Try, Success => Ok}
import example.util._

// WHY: every order is priced before it is billed.
trait OrderRepository {
  def save(order: Order): Order
}

case class Order(id: String, total: BigDecimal)

enum OrderStatus { case Open, Closed }

object OrderService {
  val MaxItems = 50

  def place(order: Order): Order = {
    require(order.total > 0, "total must be positive")
    val saved = repository.save(order)
    audit(saved)
    this.notifyAll()
    new Invoice(saved.id)
    saved
  }

  private def audit(order: Order): Unit = println(order)
}

def topLevel(x: Int): Int = x * 2
`;

const RUST_FILE = "src/orders/service.rs";
const RUST = `use crate::billing::Invoice;
use std::collections::{HashMap, HashSet as Set};

// WHY: totals are validated before an order is stored.
pub struct Order {
    pub total: u32,
}

pub enum Status {
    Open,
    Closed,
}

pub trait Repository {
    fn save(&self, order: Order) -> Order;
}

impl Order {
    pub fn new(total: u32) -> Self {
        Order { total }
    }

    pub fn place(&self) -> Result<(), String> {
        validate(self.total);
        self.audit();
        Invoice::create(1);
        Ok(())
    }

    fn audit(&self) {}
}

impl Repository for Store {
    fn save(&self, order: Order) -> Order {
        order
    }
}

mod tests {
    fn helper() {}
}

fn validate(total: u32) {}
`;

const C_FILE = "src/orders.c";
const C_SOURCE = `#include <stdio.h>
#include "orders.h"
#define MAX_ITEMS 50

struct order { int total; };
typedef struct { int x; } point_t;
enum status { OPEN, CLOSED };

static int helper(int x);

// WHY: a non-positive total is rejected.
int place(struct order *o) {
    if (o->total <= 0) return -1;
    helper(o->total);
    o->ops->save(o);
    return 0;
}

static int helper(int x) { return x; }
`;

const CPP_FILE = "src/order.cpp";
const CPP = `#include <vector>
#include "billing/invoice.hpp"

namespace shop {
class Order : public Base {
public:
    Order(int total);
    int total() const { return total_; }
    void place();
private:
    int total_;
};

enum class Status { Open, Closed };

void Order::place() {
    validate(total_);
    this->audit();
    repository.save(*this);
    Invoice::create(1);
    auto invoice = new Invoice(2);
    std::sort(items.begin(), items.end());
}

template <typename T> T twice(T x) { return x * 2; }
}
`;

const names = (r: ParsedFile, kind: string): string[] =>
  r.symbols.filter((s) => s.kind === kind).map((s) => s.name);
const edgeTargets = (r: ParsedFile, kind: string): string[] =>
  r.edges.filter((e) => e.kind === kind).map((e) => e.toQualifiedName);
const qname = (r: ParsedFile, name: string): string =>
  r.symbols.find((s) => s.name === name)!.qualifiedName;

describe("detectLanguage — Scala, Rust, C, C++ (#161)", () => {
  it("maps each extension to its language; a .h header reads as C++", () => {
    expect(detectLanguage("a/B.scala")).toBe("scala");
    expect(detectLanguage("src/lib.rs")).toBe("rs");
    expect(detectLanguage("src/main.c")).toBe("c");
    expect(detectLanguage("include/orders.h")).toBe("cpp");
    for (const ext of ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "CPP"]) {
      expect(detectLanguage(`src/x.${ext}`)).toBe("cpp");
    }
  });
});

describe("Scala / Rust / C / C++ without a booted grammar", () => {
  it("records the module alone rather than guessing", () => {
    expect(isTreeSitterReady()).toBe(false);
    for (const [file, src, lang] of [
      [SCALA_FILE, SCALA, "scala"],
      [RUST_FILE, RUST, "rs"],
      [C_FILE, C_SOURCE, "c"],
      [CPP_FILE, CPP, "cpp"],
    ] as const) {
      const r = parseSource(file, src, lang);
      expect(r.unparseable).toBeFalsy();
      expect(r.language).toBe(lang);
      expect(r.symbols.map((s) => s.kind)).toEqual(["module"]);
      expect(r.symbols[0].qualifiedName).toBe(file);
      expect(r.edges).toEqual([]);
    }
  });
});

describe("tree-sitter parsers — Scala, Rust, C, C++ (#161)", () => {
  beforeAll(async () => {
    await initCodeGraphParsers();
  }, 30_000);
  afterAll(() => {
    __resetCodeGraphParsersForTests();
  });

  describe("Scala", () => {
    it("records types, methods and top-level functions", () => {
      const r = parseSource(SCALA_FILE, SCALA, "scala");
      expect(r.unparseable).toBeFalsy();
      expect(names(r, "module")).toEqual(["OrderService.scala"]);
      expect(names(r, "interface")).toEqual(["OrderRepository"]);
      expect(names(r, "class")).toEqual(["Order", "OrderService"]);
      expect(names(r, "type")).toEqual(["OrderStatus"]);
      expect(names(r, "method")).toEqual(["save", "place", "audit"]);
      expect(names(r, "function")).toEqual(["topLevel"]);
      expect(qname(r, "place")).toBe(`${SCALA_FILE}::OrderService::place`);
      const place = r.symbols.find((s) => s.name === "place")!;
      expect([place.startLine, place.endLine]).toEqual([19, 26]);
    });

    it("emits one import per selector, calls with receivers, and `new` as a reference", () => {
      const r = parseSource(SCALA_FILE, SCALA, "scala");
      expect(edgeTargets(r, "imports")).toEqual([
        "example.billing.Invoice",
        "scala.util.Try",
        "scala.util.Success",
        "example.util._",
      ]);
      const calls = r.edges.filter((e) => e.kind === "calls");
      const save = calls.find((e) => e.toQualifiedName === "save")!;
      expect(save.receiver).toBe("repository");
      expect(save.fromQualifiedName).toBe(`${SCALA_FILE}::OrderService::place`);
      expect(calls.find((e) => e.toQualifiedName === "audit")!.receiver).toBeUndefined();
      expect(calls.find((e) => e.toQualifiedName === "notifyAll")!.receiver).toBe("this");
      expect(edgeTargets(r, "references")).toEqual(["Invoice"]);
    });

    it("anchors every defines edge on a symbol of the file", () => {
      const r = parseSource(SCALA_FILE, SCALA, "scala");
      const known = new Set(r.symbols.map((s) => s.qualifiedName));
      const defines = r.edges.filter((e) => e.kind === "defines");
      expect(defines).toHaveLength(r.symbols.length - 1);
      expect(defines.every((e) => known.has(e.fromQualifiedName))).toBe(true);
    });

    it("captures a `// WHY:` rationale hint", () => {
      const r = parseSource(SCALA_FILE, SCALA, "scala");
      expect(r.rationaleHints.map((h) => h.tag)).toEqual(["WHY"]);
    });
  });

  describe("Rust", () => {
    it("records structs, enums, traits, impl methods under their type, and functions", () => {
      const r = parseSource(RUST_FILE, RUST, "rs");
      expect(r.unparseable).toBeFalsy();
      expect(names(r, "class")).toEqual(["Order"]);
      expect(names(r, "type")).toEqual(["Status"]);
      expect(names(r, "interface")).toEqual(["Repository"]);
      expect(names(r, "method")).toEqual(["save", "new", "place", "audit", "save"]);
      expect(names(r, "function")).toEqual(["helper", "validate"]);
      expect(qname(r, "place")).toBe(`${RUST_FILE}::Order::place`);
      const saves = r.symbols.filter((s) => s.name === "save").map((s) => s.qualifiedName);
      expect(saves).toEqual([`${RUST_FILE}::Repository::save`, `${RUST_FILE}::Store::save`]);
    });

    it("anchors an impl for a type declared elsewhere on the module", () => {
      const r = parseSource(RUST_FILE, RUST, "rs");
      const known = new Set(r.symbols.map((s) => s.qualifiedName));
      const defines = r.edges.filter((e) => e.kind === "defines");
      expect(defines.every((e) => known.has(e.fromQualifiedName))).toBe(true);
      const storeSave = defines.find((e) => e.toQualifiedName === `${RUST_FILE}::Store::save`)!;
      expect(storeSave.fromQualifiedName).toBe(RUST_FILE);
      const place = defines.find((e) => e.toQualifiedName === `${RUST_FILE}::Order::place`)!;
      expect(place.fromQualifiedName).toBe(`${RUST_FILE}::Order`);
    });

    it("expands use lists and records calls with receivers and struct literals", () => {
      const r = parseSource(RUST_FILE, RUST, "rs");
      expect(edgeTargets(r, "imports")).toEqual([
        "crate::billing::Invoice",
        "std::collections::HashMap",
        "std::collections::HashSet",
      ]);
      const calls = r.edges.filter((e) => e.kind === "calls");
      expect(calls.find((e) => e.toQualifiedName === "validate")!.receiver).toBeUndefined();
      expect(calls.find((e) => e.toQualifiedName === "audit")!.receiver).toBe("self");
      const create = calls.find((e) => e.toQualifiedName === "create")!;
      expect(create.receiver).toBe("Invoice");
      expect(create.fromQualifiedName).toBe(`${RUST_FILE}::Order::place`);
      expect(edgeTargets(r, "references")).toEqual(["Order"]);
    });
  });

  describe("C", () => {
    it("records struct/typedef/enum bodies and function definitions, not prototypes", () => {
      const r = parseSource(C_FILE, C_SOURCE, "c");
      expect(r.unparseable).toBeFalsy();
      expect(names(r, "class")).toEqual(["order", "point_t"]);
      expect(names(r, "type")).toEqual(["status"]);
      expect(names(r, "function")).toEqual(["place", "helper"]);
      // The prototype on line 9 is not a symbol; the definition on line 19 is.
      expect(r.symbols.find((s) => s.name === "helper")!.startLine).toBe(19);
    });

    it("records includes (quoted ones relative to the file) and calls", () => {
      const r = parseSource(C_FILE, C_SOURCE, "c");
      expect(edgeTargets(r, "imports")).toEqual(["stdio.h", "./orders.h"]);
      const calls = r.edges.filter((e) => e.kind === "calls");
      const helper = calls.find((e) => e.toQualifiedName === "helper")!;
      expect(helper.receiver).toBeUndefined();
      expect(helper.fromQualifiedName).toBe(`${C_FILE}::place`);
      expect(calls.find((e) => e.toQualifiedName === "save")!.receiver).toBe("<expr>");
    });
  });

  describe("C++", () => {
    it("records classes, inline and out-of-line methods, enums and templates", () => {
      const r = parseSource(CPP_FILE, CPP, "cpp");
      expect(r.unparseable).toBeFalsy();
      expect(names(r, "class")).toEqual(["Order"]);
      expect(names(r, "type")).toEqual(["Status"]);
      expect(names(r, "method")).toEqual(["total", "place"]);
      expect(names(r, "function")).toEqual(["twice"]);
      expect(qname(r, "total")).toBe(`${CPP_FILE}::Order::total`);
      expect(qname(r, "place")).toBe(`${CPP_FILE}::Order::place`);
      const known = new Set(r.symbols.map((s) => s.qualifiedName));
      expect(
        r.edges.filter((e) => e.kind === "defines").every((e) => known.has(e.fromQualifiedName)),
      ).toBe(true);
    });

    it("records calls with receivers, qualified calls, and `new` as a reference", () => {
      const r = parseSource(CPP_FILE, CPP, "cpp");
      expect(edgeTargets(r, "imports")).toEqual(["vector", "./billing/invoice.hpp"]);
      const calls = r.edges.filter((e) => e.kind === "calls");
      const from = `${CPP_FILE}::Order::place`;
      expect(calls.find((e) => e.toQualifiedName === "validate")).toMatchObject({
        fromQualifiedName: from,
      });
      expect(calls.find((e) => e.toQualifiedName === "audit")!.receiver).toBe("this");
      expect(calls.find((e) => e.toQualifiedName === "save")!.receiver).toBe("repository");
      expect(calls.find((e) => e.toQualifiedName === "create")!.receiver).toBe("Invoice");
      expect(calls.find((e) => e.toQualifiedName === "sort")!.receiver).toBe("std");
      expect(edgeTargets(r, "references")).toEqual(["Invoice"]);
    });

    it("parses a C header's declarations with the C++ grammar", () => {
      const header = [
        "#ifndef ORDERS_H",
        "#define ORDERS_H",
        "struct order { int total; };",
        "static inline int order_total(const struct order *o) { return o->total; }",
        "int place(struct order *o);",
        "#endif",
      ].join("\n");
      const r = parseSource("include/orders.h", header, detectLanguage("include/orders.h")!);
      expect(r.language).toBe("cpp");
      expect(names(r, "class")).toEqual(["order"]);
      expect(names(r, "function")).toEqual(["order_total"]);
    });
  });
});
