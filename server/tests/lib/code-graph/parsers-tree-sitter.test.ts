/**
 * Issue #322 — `web-tree-sitter` parser regression tests.
 *
 * These exercise the AST-backed implementation of `parseSource`. We
 * `await initCodeGraphParsers()` in beforeAll so the dispatcher delegates
 * to tree-sitter. Each test targets a documented v1 limitation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSource } from "../../../src/lib/code-graph/parsers.js";
import {
  __resetCodeGraphParsersForTests,
  initCodeGraphParsers,
  isTreeSitterReady,
} from "../../../src/lib/code-graph/parsers-tree-sitter.js";

beforeAll(async () => {
  await initCodeGraphParsers();
}, 30_000);

afterAll(() => {
  __resetCodeGraphParsersForTests();
});

describe("tree-sitter init", () => {
  it("loads grammars for all five languages", () => {
    expect(isTreeSitterReady()).toBe(true);
  });
});

describe("TS parser — resolved v1 limitations", () => {
  it("captures methods inside a class as `method` symbols (v1 missed these)", () => {
    const src = `
export class Calculator {
  square(x: number): number { return x * x; }
  cube(x: number): number { return x * x * x; }
}
`;
    const r = parseSource("calc.ts", src, "ts");
    const methods = r.symbols.filter((s) => s.kind === "method");
    expect(methods.map((m) => m.name).sort()).toEqual(["cube", "square"]);
  });

  it("captures nested classes (v1 only saw the outer)", () => {
    const src = `
export class Outer {
  static Inner = class {};
}
class Sibling {
  static Nested = class {};
}
`;
    const r = parseSource("nested.ts", src, "ts");
    const classes = r.symbols.filter((s) => s.kind === "class");
    expect(classes.map((c) => c.name)).toContain("Outer");
    expect(classes.map((c) => c.name)).toContain("Sibling");
  });

  it("captures computed property method names (v1 dropped them)", () => {
    const src = `
const KEY = "x";
class Foo {
  [KEY]() { return 1; }
}
`;
    const r = parseSource("comp.ts", src, "ts");
    const methods = r.symbols.filter((s) => s.kind === "method");
    expect(methods.length).toBeGreaterThan(0);
  });

  it("records dynamic `import('mod')` as an import edge with metadata.dynamic=true", () => {
    const src = `
async function load() {
  const m = await import("./lazy");
  return m;
}
`;
    const r = parseSource("dyn.ts", src, "ts");
    const dyn = r.edges.find((e) => e.kind === "imports" && e.toQualifiedName === "./lazy");
    expect(dyn).toBeDefined();
    expect(dyn?.metadata?.dynamic).toBe(true);
  });

  it("records `export ... from` as a re-export imports edge", () => {
    const src = `export { foo } from "./reexports";\n`;
    const r = parseSource("re.ts", src, "ts");
    const reexp = r.edges.find((e) => e.kind === "imports" && e.toQualifiedName === "./reexports");
    expect(reexp).toBeDefined();
    expect(reexp?.metadata?.reExport).toBe(true);
  });

  it("captures generic arrow-function assignments — `const f = <T>(x: T) => ...`", () => {
    const src = `const id = <T>(x: T): T => x;\n`;
    const r = parseSource("g.ts", src, "ts");
    expect(r.symbols.find((s) => s.name === "id" && s.kind === "function")).toBeDefined();
  });
});

describe("Python parser — resolved v1 limitations", () => {
  it("captures methods inside a class with their enclosing class qualifier", () => {
    const src = `
class Registry:
    def register(self, name):
        return name
    def lookup(self, name):
        return name
`;
    const r = parseSource("svc.py", src, "py");
    const methods = r.symbols.filter((s) => s.kind === "function" && s.name !== "Registry");
    const qnames = methods.map((m) => m.qualifiedName);
    expect(qnames.some((q) => q.includes("Registry::register"))).toBe(true);
    expect(qnames.some((q) => q.includes("Registry::lookup"))).toBe(true);
  });

  it("recognises decorated function definitions", () => {
    const src = `
from dataclasses import dataclass

@dataclass
class Point:
    x: int
    y: int
`;
    const r = parseSource("p.py", src, "py");
    expect(r.symbols.find((s) => s.name === "Point" && s.kind === "class")).toBeDefined();
  });
});

describe("Java parser — resolved v1 limitations", () => {
  it("captures methods with multi-token return types (Map<String, List<Integer>>)", () => {
    const src = `
import java.util.List;
import java.util.Map;
public class Holder {
    public Map<String, List<Integer>> grouped() { return null; }
    public java.util.concurrent.Future<Boolean> async() { return null; }
}
`;
    const r = parseSource("Holder.java", src, "java");
    const methods = r.symbols.filter((s) => s.kind === "method");
    expect(methods.map((m) => m.name).sort()).toEqual(["async", "grouped"]);
  });

  it("captures methods inside nested classes", () => {
    const src = `
public class Outer {
    public static class Inner {
        public void doit() {}
    }
    public void outer() {}
}
`;
    const r = parseSource("Outer.java", src, "java");
    const methodNames = r.symbols
      .filter((s) => s.kind === "method")
      .map((m) => m.name)
      .sort();
    expect(methodNames).toEqual(["doit", "outer"]);
  });
});

describe("Go parser — symbols and edges", () => {
  it("captures funcs, methods, structs, interfaces, and imports", () => {
    const src = `package main

import (
    "fmt"
    "os"
)

type T struct { name string }
type S interface { String() string }

func (t *T) Name() string { return t.name }
func main() { fmt.Println("hi"); os.Exit(0) }
`;
    const r = parseSource("main.go", src, "go");
    expect(r.symbols.find((s) => s.name === "T" && s.kind === "class")).toBeDefined();
    expect(r.symbols.find((s) => s.name === "S" && s.kind === "interface")).toBeDefined();
    expect(r.symbols.find((s) => s.name === "main" && s.kind === "function")).toBeDefined();
    expect(r.symbols.find((s) => s.name === "Name")).toBeDefined();
    const imports = r.edges
      .filter((e) => e.kind === "imports")
      .map((e) => e.toQualifiedName)
      .sort();
    expect(imports).toEqual(["fmt", "os"]);
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.toQualifiedName);
    expect(calls).toContain("Println");
    expect(calls).toContain("Exit");
  });
});

describe("Cross-language behaviour", () => {
  it("retains the same fileHash regardless of which backend ran", () => {
    const src = `function noop() {}\n`;
    const r = parseSource("noop.ts", src, "ts");
    // sha256("function noop() {}\n")
    expect(r.fileHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("emits a module symbol per file (parity with the regex parsers)", () => {
    const r = parseSource("x.go", "package main\n", "go");
    expect(r.symbols[0]?.kind).toBe("module");
  });
});

describe("Edge cases — extra walker coverage", () => {
  it("TS — captures interface and type alias declarations", () => {
    const src = `
export interface User { id: string; name: string }
export type Maybe<T> = T | null;
`;
    const r = parseSource("types.ts", src, "ts");
    expect(r.symbols.find((s) => s.kind === "interface" && s.name === "User")).toBeDefined();
    expect(r.symbols.find((s) => s.kind === "type" && s.name === "Maybe")).toBeDefined();
  });

  it("TS — records `import type` with metadata.typeOnly=true", () => {
    const src = `import type { Foo } from "./foo";\n`;
    const r = parseSource("t.ts", src, "ts");
    const e = r.edges.find((x) => x.kind === "imports" && x.toQualifiedName === "./foo");
    expect(e?.metadata?.typeOnly).toBe(true);
  });

  it("TS — records member-call edges (e.g. obj.method())", () => {
    const src = `
function caller() {
  return obj.run();
}
`;
    const r = parseSource("c.ts", src, "ts");
    const calls = r.edges.filter((e) => e.kind === "calls").map((e) => e.toQualifiedName);
    expect(calls).toContain("run");
  });

  it("Python — captures import-from with module_name", () => {
    const src = `from typing import List, Dict\n`;
    const r = parseSource("imp.py", src, "py");
    expect(
      r.edges.find((e) => e.kind === "imports" && e.toQualifiedName === "typing"),
    ).toBeDefined();
  });

  it("Python — captures aliased imports", () => {
    const src = `import numpy as np\n`;
    const r = parseSource("np.py", src, "py");
    expect(
      r.edges.find((e) => e.kind === "imports" && e.toQualifiedName === "numpy"),
    ).toBeDefined();
  });

  it("Python — captures attribute calls (e.g. self.foo())", () => {
    const src = `
class A:
    def m(self):
        self.foo()
`;
    const r = parseSource("a.py", src, "py");
    expect(r.edges.find((e) => e.kind === "calls" && e.toQualifiedName === "foo")).toBeDefined();
  });

  it("Go — captures bare-identifier calls and parenthesised import block", () => {
    const src = `package x
import (
  "context"
)
func helper() {}
func main() { helper() }
`;
    const r = parseSource("x.go", src, "go");
    expect(
      r.edges.find((e) => e.kind === "imports" && e.toQualifiedName === "context"),
    ).toBeDefined();
    expect(r.edges.find((e) => e.kind === "calls" && e.toQualifiedName === "helper")).toBeDefined();
  });

  it("Java — captures imports including .* wildcard and static imports", () => {
    const src = `
import java.util.*;
import static java.lang.Math.PI;
public class C { void m() {} }
`;
    const r = parseSource("C.java", src, "java");
    const imports = r.edges.filter((e) => e.kind === "imports").map((e) => e.toQualifiedName);
    expect(imports).toContain("java.util.*");
    expect(imports).toContain("java.lang.Math.PI");
  });

  it("collects JSDoc and TODO/HACK rationale hints from TS sources", () => {
    const src = `
/**
 * Why we cache here: see issue #42.
 */
function cached() {}
// TODO: drop legacy path next quarter
function legacy() {}
`;
    const r = parseSource("hints.ts", src, "ts");
    expect(r.rationaleHints.find((h) => h.tag === "JSDOC")).toBeDefined();
    expect(r.rationaleHints.find((h) => h.tag === "TODO")).toBeDefined();
  });

  it("collects # WHY hints and triple-quoted docstrings from Python sources", () => {
    const src = `
# WHY: pinned to 3.10 for X
def f():
    """compact docstring"""
    return 1
`;
    const r = parseSource("hints.py", src, "py");
    expect(r.rationaleHints.find((h) => h.tag === "WHY")).toBeDefined();
    expect(r.rationaleHints.find((h) => h.tag === "DOCSTRING")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #383 — `references` edge emission per language.
// References are non-call symbol uses: `new Foo()`, `@Decorator`, JSX
// component tags, type annotations, Java annotations, and Java
// object-creation expressions. They feed the in-degree ranking on the
// project overview alongside `calls`.
// ---------------------------------------------------------------------------
describe("Issue #383 — references edge emission", () => {
  it("TS — emits a `references` edge for `new Foo()` with metadata.via='new'", () => {
    const src = `
import { Foo } from "./foo";
function caller() {
  return new Foo();
}
`;
    const r = parseSource("nx.ts", src, "ts");
    const ref = r.edges.find(
      (e) => e.kind === "references" && e.toQualifiedName === "Foo" && e.metadata?.via === "new",
    );
    expect(ref).toBeDefined();
    // Same `new Foo()` must NOT also appear as a `calls` edge.
    expect(r.edges.find((e) => e.kind === "calls" && e.toQualifiedName === "Foo")).toBeUndefined();
  });

  it("TS — emits a `references` edge for `@Decorator` (bare, no parens)", () => {
    const src = `
function Decorator(target: unknown) { return target; }
@Decorator
class Tagged {}
`;
    const r = parseSource("dec.ts", src, "ts");
    const ref = r.edges.find(
      (e) =>
        e.kind === "references" &&
        e.toQualifiedName === "Decorator" &&
        e.metadata?.via === "decorator",
    );
    expect(ref).toBeDefined();
  });

  it("TS — emits BOTH `references` and `calls` for parameterised decorator `@Foo()`", () => {
    const src = `
function Foo(arg: string) { return (target: unknown) => target; }
@Foo("x")
class C {}
`;
    const r = parseSource("dp.ts", src, "ts");
    expect(
      r.edges.find(
        (e) =>
          e.kind === "references" && e.toQualifiedName === "Foo" && e.metadata?.via === "decorator",
      ),
    ).toBeDefined();
    expect(r.edges.find((e) => e.kind === "calls" && e.toQualifiedName === "Foo")).toBeDefined();
  });

  it("TS — emits `references` for type annotations (return types, params, generics)", () => {
    const src = `
import { Buffer } from "node:buffer";
function fmt(input: Buffer): string { return input.toString(); }
`;
    const r = parseSource("ty.ts", src, "ts");
    const ref = r.edges.find(
      (e) =>
        e.kind === "references" && e.toQualifiedName === "Buffer" && e.metadata?.via === "type",
    );
    expect(ref).toBeDefined();
  });

  it("TS — does NOT emit a self-reference for the class declaration's own name", () => {
    const src = `class MyClass {}\n`;
    const r = parseSource("mc.ts", src, "ts");
    const selfRef = r.edges.find((e) => e.kind === "references" && e.toQualifiedName === "MyClass");
    expect(selfRef).toBeUndefined();
  });

  it("TS — emits `calls` edge for `super.foo()` (super-method invocation)", () => {
    const src = `
class Base { foo() { return 1; } }
class Derived extends Base {
  foo() { return super.foo() + 1; }
}
`;
    const r = parseSource("sup.ts", src, "ts");
    expect(r.edges.find((e) => e.kind === "calls" && e.toQualifiedName === "foo")).toBeDefined();
  });

  it("Python — emits a `references` edge for `@dataclass` decorator", () => {
    const src = `
from dataclasses import dataclass
@dataclass
class Point:
    x: int
`;
    const r = parseSource("p.py", src, "py");
    const ref = r.edges.find(
      (e) =>
        e.kind === "references" &&
        e.toQualifiedName === "dataclass" &&
        e.metadata?.via === "decorator",
    );
    expect(ref).toBeDefined();
  });

  it("Python — emits `references` for attribute decorators like `@app.route`", () => {
    const src = `
@app.route("/x")
def handler():
    return 1
`;
    const r = parseSource("h.py", src, "py");
    const ref = r.edges.find((e) => e.kind === "references" && e.toQualifiedName === "route");
    expect(ref).toBeDefined();
  });

  it("Java — emits a `references` edge for `new Foo()` object creation", () => {
    const src = `
public class C {
  public Object make() { return new Foo(); }
}
`;
    const r = parseSource("C.java", src, "java");
    const ref = r.edges.find(
      (e) => e.kind === "references" && e.toQualifiedName === "Foo" && e.metadata?.via === "new",
    );
    expect(ref).toBeDefined();
  });

  it("Java — emits a `references` edge for `@Override` annotation", () => {
    const src = `
public class C {
  @Override
  public String toString() { return ""; }
}
`;
    const r = parseSource("C.java", src, "java");
    const ref = r.edges.find(
      (e) =>
        e.kind === "references" &&
        e.toQualifiedName === "Override" &&
        e.metadata?.via === "decorator",
    );
    expect(ref).toBeDefined();
  });

  it("Java — captures generic-typed object creation (`new ArrayList<String>()`)", () => {
    const src = `
import java.util.ArrayList;
public class C {
  public Object make() { return new ArrayList<String>(); }
}
`;
    const r = parseSource("C.java", src, "java");
    const ref = r.edges.find((e) => e.kind === "references" && e.toQualifiedName === "ArrayList");
    expect(ref).toBeDefined();
  });
});

describe("call receivers are recorded for resolution (#17)", () => {
  const calls = (r: ReturnType<typeof parseSource>) =>
    Object.fromEntries(
      r.edges.filter((e) => e.kind === "calls").map((e) => [e.toQualifiedName, e.receiver]),
    );

  it("TS: bare, identifier, this, super and complex receivers", () => {
    const src = `
class A extends B {
  run(xs: string[]) {
    bare();
    xs.join(",");
    this.helper();
    super.save();
    getList().push(1);
    a.b.deep();
  }
}
`;
    expect(calls(parseSource("a.ts", src, "ts"))).toEqual({
      bare: undefined,
      join: "xs",
      helper: "this",
      save: "super",
      push: "<expr>",
      deep: "<expr>",
    });
  });

  it("TS: import statements carry the local names they bind", () => {
    const src = `import def, { join, resolve as res } from "node:path";\nimport * as fs from "fs";\nimport "./side-effect";\n`;
    const imports = parseSource("a.ts", src, "ts").edges.filter((e) => e.kind === "imports");
    expect(imports.map((e) => [e.toQualifiedName, e.importedNames])).toEqual([
      ["node:path", ["def", "join", "res"]],
      ["fs", ["fs"]],
      ["./side-effect", undefined],
    ]);
  });

  it("Python: self and module receivers", () => {
    const src = `class A:\n    def run(self):\n        self.helper()\n        util.fmt()\n        plain()\n`;
    expect(calls(parseSource("a.py", src, "py"))).toEqual({
      helper: "self",
      fmt: "util",
      plain: undefined,
    });
  });

  it("Go: package-qualified and bare calls", () => {
    const src = `package main\n\nfunc main() {\n\tbilling.Charge()\n\tlocal()\n}\n`;
    expect(calls(parseSource("main.go", src, "go"))).toEqual({
      Charge: "billing",
      local: undefined,
    });
  });

  it("Java: object, this and unqualified invocations", () => {
    const src = `class A {\n  void run() {\n    orders.placeOrder();\n    this.helper();\n    local();\n  }\n}\n`;
    expect(calls(parseSource("A.java", src, "java"))).toEqual({
      placeOrder: "orders",
      helper: "this",
      local: undefined,
    });
  });

  it("C#: member access, this and base", () => {
    const src = `class A : B {\n  void Run() {\n    orders.PlaceOrder();\n    this.Helper();\n    base.Save();\n    Local();\n  }\n}\n`;
    expect(calls(parseSource("A.cs", src, "cs"))).toEqual({
      PlaceOrder: "orders",
      Helper: "this",
      Save: "base",
      Local: undefined,
    });
  });
});
