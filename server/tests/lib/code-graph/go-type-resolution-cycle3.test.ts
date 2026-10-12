/**
 * #1071 (PR #1104, review cycle 3) — the rules this round added or corrected,
 * each stated on the smallest tree that shows it.
 *
 * The guard against a WRONG binding is the oracle corpus
 * (`go-oracle-corpus.test.ts`): what the Go type checker says, call by call.
 * These tests are for what a corpus that compiles cannot hold — Go that does
 * not compile (a tie, a twin), a tree with no `go.mod`, a file too large to
 * read in budget — and for reading: one rule, one fixture, one sentence.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  createGoResolver,
  GO_CALL_STEP_BUDGET,
  type GoCallVerdict,
} from "../../../src/lib/code-graph/go-type-resolution.js";
import { initCodeGraphParsers, parseSource } from "../../../src/lib/code-graph/parsers.js";
import { GO_TEST_MODULE, goVerdicts, type GoTree } from "../../helpers/go-verdicts.js";

beforeAll(async () => {
  await initCodeGraphParsers();
});

describe("a method declared in a `_test.go` file exists for the tests of ITS directory, at any depth", () => {
  // The reviewer's fixture (L4): Go selects E.M (depth 1) in p3's test build,
  // and F.M (depth 2) everywhere else.
  const tree: GoTree = {
    "p3/t.go": `package p3

type S struct{ E }

type E struct{ F }

type F struct{}

func (F) M() {}

func use(s S) {
	s.M()
}
`,
    "p3/export_test.go": `package p3

func (E) M() {}
`,
    "p3/s_test.go": `package p3

func probe(s S) {
	s.M()
}
`,
    "p3/x_test.go": `package p3_test

import "example.com/app/p3"

func probe(s p3.S) {
	s.M()
}
`,
    "q/q.go": `package q

import "example.com/app/p3"

func use(s p3.S) {
	s.M()
}
`,
    "q/q_test.go": `package q

import "example.com/app/p3"

func probe(s p3.S) {
	s.M()
}
`,
  };

  it("a test file of the package reaches the test-only method on the EMBEDDED type", () => {
    expect(goVerdicts(tree).get("p3/s_test.go:4:M")).toBe("receiver-type p3/export_test.go::E::M");
  });

  it("so does the external test package of that directory", () => {
    expect(goVerdicts(tree).get("p3/x_test.go:6:M")).toBe("receiver-type p3/export_test.go::E::M");
  });

  it("a non-test file of the package does not", () => {
    expect(goVerdicts(tree).get("p3/t.go:12:M")).toBe("receiver-type p3/t.go::F::M");
  });

  it("nor does ANOTHER package — not even from its own test file", () => {
    const v = goVerdicts(tree);
    expect(v.get("q/q.go:6:M")).toBe("receiver-type p3/t.go::F::M");
    expect(v.get("q/q_test.go:6:M")).toBe("receiver-type p3/t.go::F::M");
  });

  it("the answer does not depend on who asked first", () => {
    const parsed = Object.entries(tree).map(([filePath, src]) => parseSource(filePath, src, "go"));
    const files = parsed.map((p) => ({
      filePath: p.filePath,
      facts: p.goFacts!,
      isTest: p.filePath.endsWith("_test.go"),
    }));
    const calls = parsed.flatMap((p) =>
      p.edges
        .filter((e) => e.kind === "calls")
        .map((e) => ({ file: p.filePath, callee: e.goCallee! })),
    );
    const ask = (order: typeof calls): Map<string, GoCallVerdict> => {
      const resolver = createGoResolver(files, GO_TEST_MODULE);
      const out = new Map<string, GoCallVerdict>();
      for (const c of order) out.set(c.file, resolver.resolveCall(c.file, c.callee));
      // A second pass over the warm resolver.
      for (const c of order)
        expect(resolver.resolveCall(c.file, c.callee)).toEqual(out.get(c.file));
      return out;
    };
    const forward = ask(calls);
    const reverse = ask([...calls].reverse());
    expect([...reverse].sort()).toEqual([...forward].sort());
  });
});

describe("a test-file method against what the package already holds", () => {
  const withTest = (code: string, test: string): GoTree => ({
    "p/p.go": `package p\n\n${code}\nfunc use(s S) {\n\ts.M()\n}\n`,
    "p/export_test.go": `package p\n\n${test}`,
    "p/p_test.go": "package p\n\nfunc probe(s S) {\n\ts.M()\n}\n",
  });
  const fromTest = (tree: GoTree) => goVerdicts(tree).get("p/p_test.go:4:M");
  const fromCode = (tree: GoTree) => goVerdicts(tree).get("p/p.go:M");

  it("deeper than a method the package ships: the shipped one still wins", () => {
    const tree = withTest(
      "type S struct{ A }\ntype A struct{ B }\ntype B struct{}\nfunc (A) M() {}\n",
      "func (B) M() {}\n",
    );
    expect(fromTest(tree)).toBe("receiver-type p/p.go::A::M");
    expect(fromCode(tree)).toBe("receiver-type p/p.go::A::M");
  });

  it("at the SAME depth as another embedded type's method: a tie for the tests only", () => {
    const tree = withTest(
      "type S struct {\n\tA\n\tB\n}\ntype A struct{}\ntype B struct{}\nfunc (A) M() {}\n",
      "func (B) M() {}\n",
    );
    expect(fromTest(tree)).toBe("unbound ambiguous");
    expect(fromCode(tree)).toBe("receiver-type p/p.go::A::M");
  });

  it("on the type that already declares it: twins, and neither is chosen", () => {
    const tree = withTest(
      "type S struct{ A }\ntype A struct{}\nfunc (A) M() {}\n",
      "func (A) M() {}\n",
    );
    expect(fromTest(tree)).toBe("unbound ambiguous");
    expect(fromCode(tree)).toBe("receiver-type p/p.go::A::M");
  });

  it("two test-file methods at one depth: a tie", () => {
    const tree = withTest(
      "type S struct {\n\tA\n\tB\n}\ntype A struct{}\ntype B struct{}\n",
      "func (A) M() {}\n\nfunc (B) M() {}\n",
    );
    expect(fromTest(tree)).toBe("unbound ambiguous");
    expect(fromCode(tree)).toBe("unknown");
  });

  it("on the type itself, over a promoted one: the type's own", () => {
    const tree = withTest(
      "type S struct{ A }\ntype A struct{}\nfunc (A) M() {}\n",
      "func (S) M() {}\n",
    );
    expect(fromTest(tree)).toBe("receiver-type p/export_test.go::S::M");
    expect(fromCode(tree)).toBe("receiver-type p/p.go::A::M");
  });

  it("beside a type whose members are not known, at the same depth: undecided, not a tie", () => {
    const tree = withTest(
      'import "io"\n\ntype Open interface {\n\tio.Closer\n}\ntype S struct {\n\tOpen\n\tA\n}\ntype A struct{}\n',
      "func (A) M() {}\n",
    );
    expect(fromTest(tree)).toBe("unknown");
    // For everyone else only the open interface can hold it.
    expect(fromCode(tree)).toBe("unbound interface");
  });

  it("shallower than a type whose members are not known: decided", () => {
    const tree = withTest(
      'import "io"\n\ntype Open interface {\n\tio.Closer\n}\ntype S struct{ Open }\n',
      "func (S) M() {}\n",
    );
    expect(fromTest(tree)).toBe("receiver-type p/export_test.go::S::M");
    expect(fromCode(tree)).toBe("unbound interface");
  });

  it("a type only the tests declare, with its methods, is theirs alone", () => {
    const v = goVerdicts({
      "p/p.go": "package p\n\ntype A struct{}\n\nfunc (A) Own() {}\n",
      "p/p_test.go": `package p

type mock struct{ A }

func (mock) M() {}

func probe(m mock) {
	m.M()
	m.Own()
}
`,
    });
    expect(v.get("p/p_test.go:8:M")).toBe("receiver-type p/p_test.go::mock::M");
    expect(v.get("p/p_test.go:9:Own")).toBe("receiver-type p/p.go::A::Own");
  });
});

describe("what a package declares in its `_test.go` files is invisible from another directory", () => {
  // A test of package a is compiled against package b as it SHIPS.
  const tree: GoTree = {
    "b/b.go": "package b\n\ntype S struct{ E }\n\ntype E struct{}\n\nfunc (E) M() {}\n",
    "b/export_test.go": "package b\n\nfunc (S) M() {}\n\nfunc Helper() *S { return nil }\n",
    "b/b_test.go": "package b\n\nfunc probe(s S) {\n\ts.M()\n\tHelper()\n}\n",
    "a/a_test.go": `package a

import "example.com/app/b"

func probe(s b.S) {
	s.M()
}
`,
  };

  it("b's own test sees the method b's test file declares on S, and its helper", () => {
    const v = goVerdicts(tree);
    expect(v.get("b/b_test.go:4:M")).toBe("receiver-type b/export_test.go::S::M");
    expect(v.get("b/b_test.go:5:Helper")).toBe("same-package b/export_test.go::Helper");
  });

  it("a's test does not: it reaches the method b ships", () => {
    expect(goVerdicts(tree).get("a/a_test.go:6:M")).toBe("receiver-type b/b.go::E::M");
  });
});

describe("a function read out of a package variable is called through the VALUE", () => {
  const v = () =>
    goVerdicts({
      "p/p.go": `package p

import "fmt"

type T struct{}

func (T) M() {}

type Saver interface{ Save() }

func run() *T { return nil }

var runner = run

var out = fmt.Println

var t T

var bound = t.M

var store Saver

var save = store.Save

func use() {
	runner()
	runner().M()
	out("x")
	bound()
	save()
	run()
}
`,
    });

  it("a variable initialised with a project function: func-value, never a binding to it", () => {
    expect(v().get("p/p.go:26:runner")).toBe("unbound func-value");
  });

  it("…while its RESULT is still the function's, so a chain through it binds", () => {
    expect(v().get("p/p.go:27:M")).toBe("receiver-type p/p.go::T::M");
  });

  it("a variable holding a function of another package, a method value, an interface's method", () => {
    expect(v().get("p/p.go:28:out")).toBe("unbound func-value");
    expect(v().get("p/p.go:29:bound")).toBe("unbound func-value");
    expect(v().get("p/p.go:30:save")).toBe("unbound func-value");
  });

  it("the function itself is still bound", () => {
    expect(v().get("p/p.go:31:run")).toBe("same-package p/p.go::run");
  });

  it("a variable initialised with a build-tagged TWIN is still a variable", () => {
    const twins = goVerdicts({
      "p/a_linux.go": "package p\n\nfunc impl() {}\n",
      "p/a_windows.go": "package p\n\nfunc impl() {}\n",
      "p/p.go": "package p\n\nvar hook = impl\n\nfunc use() {\n\thook()\n}\n",
      "q/q.go": 'package q\n\nimport "example.com/app/p"\n\nvar Hook = p.Missing\n',
    });
    expect(twins.get("p/p.go:6:hook")).toBe("unbound func-value");
  });
});

describe("an INDEXED callee: a generic function given its type argument, or an element called", () => {
  const v = () =>
    goVerdicts({
      "lib/lib.go": "package lib\n\nfunc Gen[V any](v V) V { return v }\n\nvar Table []func()\n",
      "p/p.go": `package p

import (
	"slices"

	"example.com/app/lib"
)

type T struct{}

func (T) M() {}

type Box[V any] struct{ v V }

func Make[V any](v V) V { return v }

func Two[A, B any](a A, b B) {}

func None[V any]() {}

var handlers []func()

var table map[string]func() *T

func use(local []func()) {
	Make[int](1)
	Two[int, T](1, T{})
	None[T]()
	handlers[0]()
	table["k"]()
	local[0]()
	_ = Box[int](Box[int]{})
	lib.Gen[int](1)
	lib.Table[0]()
	_ = slices.Clone[[]int](nil)
	Make[T](T{}).M()
}
`,
    });

  it("a generic function with an explicit type argument is the callee — one argument, several, none", () => {
    expect(v().get("p/p.go:26:Make")).toBe("same-package p/p.go::Make");
    expect(v().get("p/p.go:27:Two")).toBe("same-package p/p.go::Two");
    expect(v().get("p/p.go:28:None")).toBe("same-package p/p.go::None");
    expect(v().get("p/p.go:33:Gen")).toBe("package lib/lib.go::Gen");
  });

  it("an element of a slice or map of functions is a func value, whoever declares it", () => {
    expect(v().get("p/p.go:29:handlers")).toBe("unbound func-value");
    expect(v().get("p/p.go:30:table")).toBe("unbound func-value");
    expect(v().get("p/p.go:31:local")).toBe("unbound func-value");
    expect(v().get("p/p.go:34:Table")).toBe("unbound func-value");
  });

  it("a generic TYPE given its argument converts", () => {
    expect(v().get("p/p.go:32:Box")).toBe("unbound conversion");
  });

  it("an indexed member of a package outside the tree is only ASSUMED external", () => {
    // `slices.Clone[[]int]` is a generic function; `pkg.Handlers[0]` would be an
    // element of a variable. Nothing read says which.
    expect(v().get("p/p.go:35:Clone")).toBe("unbound external-assumed");
  });

  it("the result of a generic function is of its type parameter: nothing is bound through it", () => {
    expect(v().all("p/p.go:Make")).toEqual([
      "same-package p/p.go::Make",
      "same-package p/p.go::Make",
    ]);
    expect(v().get("p/p.go:36:M")).toBe("unknown");
  });
});

describe("the standard library: a promoted interface method, and a func variable", () => {
  const v = () =>
    goVerdicts({
      "p/p.go": `package p

import (
	"debug/elf"
	"flag"
)

func use(sec *elf.Section) {
	sec.ReadAt(nil, 0)
	sec.Open()
	sec.Data()
	flag.Usage()
	flag.Parse()
}
`,
    });

  it("a method a struct only PROMOTES from an interface it embeds is dispatched, not external", () => {
    // `elf.Section` embeds `io.ReaderAt`: whatever reader sits in that field
    // runs — very possibly a project type (the third panel's finding).
    expect(v().get("p/p.go:9:ReadAt")).toBe("unbound interface");
  });

  it("the struct's own methods stay external", () => {
    expect(v().get("p/p.go:10:Open")).toBe("unbound external");
    expect(v().get("p/p.go:11:Data")).toBe("unbound external");
  });

  it("a package-level variable of a func type is called through its value", () => {
    expect(v().get("p/p.go:12:Usage")).toBe("unbound func-value");
    expect(v().get("p/p.go:13:Parse")).toBe("unbound external");
  });
});

describe("with no go.mod, an import is matched by whole path SEGMENTS, never by letters", () => {
  const main = (imp: string) =>
    `package main\n\nimport ${imp}\n\nfunc main() {\n\tstore.Save()\n}\n`;
  const STORE = "package store\n\nfunc Save() {}\n";
  const at = (tree: GoTree) => goVerdicts(tree, []).get("cmd/main.go:6:Save");

  it("`x/ab/store` does not end in the directory `b/store` (the third panel's mutant)", () => {
    expect(at({ "b/store/s.go": STORE, "cmd/main.go": main('"x/ab/store"') })).toBe(
      "unbound external",
    );
  });

  it("the directory `mystore` does not end in the import path `store`", () => {
    expect(at({ "mystore/s.go": STORE, "cmd/main.go": main('"store"') })).toBe("unbound external");
  });

  it("a directory that ends in the WHOLE import path is it (a GOPATH layout)", () => {
    expect(
      at({
        "src/example.org/app/store/s.go": STORE,
        "cmd/main.go": main('"example.org/app/store"'),
      }),
    ).toBe("package src/example.org/app/store/s.go::Save");
  });

  it("an import path that ends in a directory of two segments or more is it", () => {
    expect(at({ "b/store/s.go": STORE, "cmd/main.go": main('"example.org/app/b/store"') })).toBe(
      "package b/store/s.go::Save",
    );
  });

  it("…the LONGEST such directory, when two end it", () => {
    expect(
      at({
        "b/store/s.go": STORE,
        "a/b/store/s.go": STORE,
        "cmd/main.go": main('"example.org/a/b/store"'),
      }),
    ).toBe("package a/b/store/s.go::Save");
  });

  it("one segment is not evidence: undecided", () => {
    expect(at({ "store/s.go": STORE, "cmd/main.go": main('"example.org/app/store"') })).toBe(
      "unknown",
    );
  });

  it("two directories ending in the whole path: undecided", () => {
    expect(
      at({
        "a/org/store/s.go": STORE,
        "b/org/store/s.go": STORE,
        "cmd/main.go": main('"org/store"'),
      }),
    ).toBe("unknown");
  });

  it("a directory holding the path AND a shorter one it ends in: undecided", () => {
    expect(
      at({
        "x/store/s.go": STORE,
        "v/org/x/store/s.go": STORE,
        "cmd/main.go": main('"org/x/store"'),
      }),
    ).toBe("unknown");
  });

  it("the directory that IS the import path is it, and is not also 'a directory it ends in'", () => {
    expect(at({ "org/store/s.go": STORE, "cmd/main.go": main('"org/store"') })).toBe(
      "package org/store/s.go::Save",
    );
  });

  it("nothing matched, but library code at the tree root: its import path is unknown, so is this", () => {
    expect(
      at({ "lib.go": "package lib\n\nfunc L() {}\n", "cmd/main.go": main('"example.org/store"') }),
    ).toBe("unknown");
  });
});

describe("dot imports are read once each", () => {
  it("one dot import past the budget: the import block is not read, and every call says so", () => {
    let src = "package p\n\nimport (\n";
    for (let i = 0; i <= GO_CALL_STEP_BUDGET; i += 1) src += '\t. "example.com/app/lib"\n';
    src += ")\n\nfunc f() {\n\tL()\n\tmissing()\n}\n";
    const parsed = [
      parseSource("lib/l.go", "package lib\n\nfunc L() {}\n", "go"),
      parseSource("p/p.go", src, "go"),
    ];
    const resolver = createGoResolver(
      parsed.map((p) => ({ filePath: p.filePath, facts: p.goFacts!, isTest: false })),
      GO_TEST_MODULE,
    );
    const calls = parsed[1].edges.filter((e) => e.kind === "calls").map((e) => e.goCallee!);
    // The file has more imports than the budget allows it to read: nothing of
    // it is read, the same for every call (see the next suite).
    expect(calls.map((c) => resolver.resolveCall("p/p.go", c))).toEqual([
      { kind: "unknown", why: "budget" },
      { kind: "unknown", why: "budget" },
    ]);
  });

  it("ten thousand dot imports of ONE package are one lookup: the name is found, and a missing one costs no budget", () => {
    let src = "package p\n\nimport (\n";
    for (let i = 0; i < GO_CALL_STEP_BUDGET; i += 1) src += '\t. "example.com/app/lib"\n';
    src += ")\n\nfunc f() {\n\tL()\n\tmissing()\n}\n";
    const parsed = [
      parseSource("lib/l.go", "package lib\n\nfunc L() {}\n", "go"),
      parseSource("p/p.go", src, "go"),
    ];
    const resolver = createGoResolver(
      parsed.map((p) => ({ filePath: p.filePath, facts: p.goFacts!, isTest: false })),
      GO_TEST_MODULE,
    );
    const calls = parsed[1].edges.filter((e) => e.kind === "calls").map((e) => e.goCallee!);
    expect(calls.map((c) => resolver.resolveCall("p/p.go", c))).toEqual([
      { kind: "bound", qualifiedName: "lib/l.go::L", via: "package" },
      // Not `budget`: one package was consulted, and it does not declare it.
      { kind: "unknown" },
    ]);
  });

  it("a dot import of the standard library still leaves a bare name open, however often it is repeated", () => {
    const v = goVerdicts({
      "p/p.go":
        'package p\n\nimport (\n\t. "strings"\n\t. "strings"\n\t. "fmt"\n)\n\nfunc f() {\n\tToUpper("x")\n}\n',
    });
    expect(v.get("p/p.go:10:ToUpper")).toBe("unknown");
  });
});

describe("an import block longer than one call's budget is not read — for every call alike", () => {
  const withImports = (count: number): string => {
    let src = "package main\n\nimport (\n";
    for (let i = 0; i < count; i += 1) src += `\ta${i} "q/r${i}/x"\n`;
    return `${src})\n\nfunc declared() {}\n\nfunc main() {\n\ta0.Go()\n\tdeclared()\n\ta1.Go()\n}\n`;
  };
  const ask = (count: number, order: "forward" | "reverse"): GoCallVerdict[] => {
    const parsed = parseSource("cmd/main.go", withImports(count), "go");
    const resolver = createGoResolver(
      [{ filePath: "cmd/main.go", facts: parsed.goFacts!, isTest: false }],
      GO_TEST_MODULE,
    );
    const calls = parsed.edges.filter((e) => e.kind === "calls").map((e) => e.goCallee!);
    const list = order === "forward" ? calls : [...calls].reverse();
    const out = list.map((c) => resolver.resolveCall("cmd/main.go", c));
    return order === "forward" ? out : out.reverse();
  };

  it("at the budget every import is read", () => {
    expect(ask(GO_CALL_STEP_BUDGET, "forward")).toEqual([
      { kind: "unbound", reason: "external" },
      { kind: "bound", qualifiedName: "cmd/main.go::declared", via: "same-package" },
      { kind: "unbound", reason: "external" },
    ]);
  });

  it("one past it none is: a call through an import is undecided and says why; the package's own name still binds", () => {
    const expected: GoCallVerdict[] = [
      { kind: "unknown", why: "budget" },
      { kind: "bound", qualifiedName: "cmd/main.go::declared", via: "same-package" },
      { kind: "unknown", why: "budget" },
    ];
    expect(ask(GO_CALL_STEP_BUDGET + 1, "forward")).toEqual(expected);
    // Whatever is asked first: nothing kept depends on the order of calls.
    expect(ask(GO_CALL_STEP_BUDGET + 1, "reverse")).toEqual(expected);
  });

  it("a type written with a package of such a file is not resolved either", () => {
    let src = "package p\n\nimport (\n";
    for (let i = 0; i <= GO_CALL_STEP_BUDGET; i += 1) src += `\ta${i} "example.com/app/lib"\n`;
    src += ")\n\nfunc f(v a0.V) {\n\tv.M()\n}\n";
    const parsed = [
      parseSource("lib/l.go", "package lib\n\ntype V struct{}\n\nfunc (V) M() {}\n", "go"),
      parseSource("p/p.go", src, "go"),
    ];
    const resolver = createGoResolver(
      parsed.map((p) => ({ filePath: p.filePath, facts: p.goFacts!, isTest: false })),
      GO_TEST_MODULE,
    );
    const call = parsed[1].edges.find((e) => e.kind === "calls")!.goCallee!;
    expect(resolver.resolveCall("p/p.go", call)).toEqual({ kind: "unknown" });
  });
});

describe("the first value of a range over a channel is its element", () => {
  it("binds through it", () => {
    const v = goVerdicts({
      "p/p.go": `package p

type T struct{}

func (T) M() {}

func use(ch chan *T, xs []*T, m map[string]*T) {
	for v := range ch {
		v.M()
	}
	for i := range xs {
		i.M()
	}
	for k := range m {
		k.M()
	}
}
`,
    });
    expect(v.get("p/p.go:9:M")).toBe("receiver-type p/p.go::T::M");
    // A slice's index and a map's key are not its elements.
    expect(v.get("p/p.go:12:M")).toBe("unknown");
    expect(v.get("p/p.go:15:M")).toBe("unbound external");
  });
});

describe("a type whose members are not known, beside one that declares the name", () => {
  const v = () =>
    goVerdicts({
      "p/p.go": `package p

import "example.net/acme/queue"

type S struct{}

func (S) Foo() {}

type Mine queue.Client

type Yours queue.Stats

type One struct {
	Mine
	S
}

type Two struct {
	Mine
	Yours
}

func use(o One, t Two) {
	o.Foo()
	o.Hook()
	t.Anything()
}
`,
    });

  it("a defined type over a dependency's struct beside a struct: the struct's method is undecided, not a tie", () => {
    expect(v().get("p/p.go:24:Foo")).toBe("unknown");
  });

  it("a name only the unknown type can hold is assumed its own", () => {
    expect(v().get("p/p.go:25:Hook")).toBe("unbound external-assumed");
  });

  it("two such types: which of them holds a name is not known", () => {
    expect(v().get("p/p.go:26:Anything")).toBe("unknown");
  });
});
