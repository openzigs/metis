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
  goDefaultImportName,
  parseGoModulePath,
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

  it("a directory that holds the WHOLE import path under `src` is it, for a file of that workspace (a GOPATH layout)", () => {
    const inWorkspace = "src/example.org/app/cmd/main.go";
    expect(
      goVerdicts(
        {
          "src/example.org/app/store/s.go": STORE,
          [inWorkspace]: main('"example.org/app/store"'),
        },
        [],
      ).get(`${inWorkspace}:6:Save`),
    ).toBe("package src/example.org/app/store/s.go::Save");
    // From a file outside that `src`, the directory is only one named `src`
    // (PR #1104 review cycle 7).
    expect(
      at({
        "src/example.org/app/store/s.go": STORE,
        "cmd/main.go": main('"example.org/app/store"'),
      }),
    ).toBe("unknown");
  });

  // PR #1104, review cycle 5: this used to bind. A directory that is only a
  // tail of the path cannot be told from a dependency spelled the same way.
  it("an import path that ends in a directory of two segments or more is undecided", () => {
    expect(at({ "b/store/s.go": STORE, "cmd/main.go": main('"example.org/app/b/store"') })).toBe(
      "unknown",
    );
  });

  it("the tree root as the GOPATH's `src`: a directory that IS the import path is it", () => {
    expect(
      at({
        "example.org/app/b/store/s.go": STORE,
        "cmd/main.go": main('"example.org/app/b/store"'),
      }),
    ).toBe("package example.org/app/b/store/s.go::Save");
  });

  // PR #1104, review cycle 4. The LONGEST such directory used to be bound. But
  // two directories the path ends in are two readings of the layout: with the
  // tree root as the module `example.org/a`, Go means `b/store`; with it as a
  // GOPATH's `src/example.org`, it means `a/b/store`. The type checker shows
  // the shorter one right in the oracle corpus (`legacy-package-root`,
  // `example.org/legacy/internal/storage`), so the longer one was a guess.
  it("two directories the path ends in are two readings of the layout: undecided", () => {
    expect(
      at({
        "b/store/s.go": STORE,
        "a/b/store/s.go": STORE,
        "cmd/main.go": main('"example.org/a/b/store"'),
      }),
    ).toBe("unknown");
  });

  it("the reviewer's tree: `internal/storage` beside `app/internal/storage`", () => {
    const tree = (dirs: string[]): GoTree => ({
      ...Object.fromEntries(dirs.map((d) => [`${d}/s.go`, STORE.replace("store", "storage")])),
      "cmd/main.go":
        'package main\n\nimport "example.org/app/internal/storage"\n\n' +
        "func main() {\n\tstorage.Save()\n}\n",
    });
    expect(
      goVerdicts(tree(["internal/storage", "app/internal/storage"]), []).get("cmd/main.go:6:Save"),
    ).toBe("unknown");
    // Either directory ALONE is still only a tail of the path (review cycle 5).
    expect(goVerdicts(tree(["internal/storage"]), []).get("cmd/main.go:6:Save")).toBe("unknown");
    expect(goVerdicts(tree(["app/internal/storage"]), []).get("cmd/main.go:6:Save")).toBe(
      "unknown",
    );
    // The directory that holds the whole path under `src` is the one reading
    // there is — for a file of that GOPATH workspace.
    const inWorkspace = "src/example.org/app/cmd/main.go";
    expect(
      goVerdicts(
        {
          "src/example.org/app/internal/storage/s.go": STORE.replace("store", "storage"),
          [inWorkspace]:
            'package main\n\nimport "example.org/app/internal/storage"\n\n' +
            "func main() {\n\tstorage.Save()\n}\n",
        },
        [],
      ).get(`${inWorkspace}:6:Save`),
    ).toBe("package src/example.org/app/internal/storage/s.go::Save");
  });

  it("a ONE-segment directory the path ends in is a second reading too", () => {
    expect(
      at({
        "store/s.go": STORE,
        "b/store/s.go": STORE,
        "cmd/main.go": main('"example.org/app/b/store"'),
      }),
    ).toBe("unknown");
  });

  it("three of them are no better than two", () => {
    expect(
      at({
        "store/s.go": STORE,
        "b/store/s.go": STORE,
        "a/b/store/s.go": STORE,
        "cmd/main.go": main('"example.org/a/b/store"'),
      }),
    ).toBe("unknown");
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

  it("the directory that IS the import path is it when a DOMAIN comes first, and is not also 'a directory it ends in'", () => {
    expect(
      at({ "example.org/store/s.go": STORE, "cmd/main.go": main('"example.org/store"') }),
    ).toBe("package example.org/store/s.go::Save");
    // Without a dot in the first segment nothing says the tree root is a
    // GOPATH `src` (PR #1104 review cycle 7): this used to bind.
    expect(at({ "org/store/s.go": STORE, "cmd/main.go": main('"org/store"') })).toBe("unknown");
  });

  it("nothing matched, but library code at the tree root: its import path is unknown, so is this", () => {
    expect(
      at({ "lib.go": "package lib\n\nfunc L() {}\n", "cmd/main.go": main('"example.org/store"') }),
    ).toBe("unknown");
  });
});

describe("a module path of one segment, or of one letter", () => {
  it("is found like any other: the import's leading segments are tried down to the first", () => {
    const tree = {
      "lib/l.go": "package lib\n\nfunc L() {}\n",
      "cmd/main.go": 'package main\n\nimport "x/lib"\n\nfunc main() {\n\tlib.L()\n}\n',
    };
    expect(goVerdicts(tree, [{ dir: "", path: "x" }]).get("cmd/main.go:6:L")).toBe(
      "package lib/l.go::L",
    );
    // And a path that only STARTS with those letters is not in the module.
    expect(goVerdicts(tree, [{ dir: "", path: "x/li" }]).get("cmd/main.go:6:L")).toBe(
      "unbound external",
    );
  });

  it("…from ANOTHER module too, where only the declared path can place the import", () => {
    const tree = {
      "xm/lib/l.go": "package lib\n\nfunc L() {}\n",
      "ym/cmd/main.go": 'package main\n\nimport "x/lib"\n\nfunc main() {\n\tlib.L()\n}\n',
    };
    const modules = [
      { dir: "xm", path: "x" },
      { dir: "ym", path: "y" },
    ];
    expect(goVerdicts(tree, modules).get("ym/cmd/main.go:6:L")).toBe("package xm/lib/l.go::L");
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

describe("only the budget is swallowed", () => {
  it("any other throw while resolving a call reaches the caller, which counts and names it", () => {
    // Ingest reports a throw as `goBinding.errors` with the call's place; an
    // over-budget call as `overBudget`. A resolver bug must not pass for the latter.
    const parsed = parseSource("p/p.go", "package p\n\nfunc f() {}\n", "go");
    const resolver = createGoResolver(
      [{ filePath: "p/p.go", facts: parsed.goFacts!, isTest: false }],
      GO_TEST_MODULE,
    );
    const poisoned = {
      e: "sel" as const,
      name: "M",
      get x(): never {
        throw new Error("a resolver bug");
      },
    };
    expect(() => resolver.resolveCall("p/p.go", poisoned)).toThrow("a resolver bug");
    // And the resolver is usable afterwards.
    expect(resolver.resolveCall("p/p.go", { e: "name", name: "f" })).toEqual({
      kind: "bound",
      qualifiedName: "p/p.go::f",
      via: "same-package",
    });
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
describe("walker rules a compiling corpus cannot state", () => {
  it("a function declared without a body (implemented in assembly) is a symbol, and the file is still walked", () => {
    const parsed = parseSource(
      "p/p.go",
      "package p\n\nfunc asm(x int) int\n\nfunc g() {}\n\nfunc f() {\n\tasm(1)\n\tg()\n}\n",
      "go",
    );
    expect(parsed.unparseable).toBeFalsy();
    expect(parsed.symbols.filter((s) => s.kind === "function").map((s) => s.name)).toEqual([
      "asm",
      "g",
      "f",
    ]);
    const v = goVerdicts({
      "p/p.go":
        "package p\n\nfunc asm(x int) int\n\nfunc g() {}\n\nfunc f() {\n\tasm(1)\n\tg()\n}\n",
    });
    expect(v.get("p/p.go:8:asm")).toBe("same-package p/p.go::asm");
    expect(v.get("p/p.go:9:g")).toBe("same-package p/p.go::g");
  });

  it("a doc comment that merely ends in the word `ignore` is not a build constraint", () => {
    // `// Package ignore` is as long as `//go:build` plus ` ignore`: only the
    // directive itself, matched as a word at the start of the line, counts.
    for (const comment of ["// Package ignore", "// go:build ignore", "//go:buildx ignore"]) {
      const v = goVerdicts({
        "ignore/a.go": `${comment}\npackage ignore\n\nfunc helper() {}\n`,
        "ignore/b.go": "package ignore\n\nfunc use() {\n\thelper()\n}\n",
      });
      expect(v.get("ignore/b.go:4:helper"), comment).toBe("same-package ignore/a.go::helper");
    }
    const ignored = goVerdicts({
      "ignore/a.go": "//go:build ignore\n\npackage ignore\n\nfunc helper() {}\n",
      "ignore/b.go": "package ignore\n\nfunc use() {\n\thelper()\n}\n",
    });
    expect(ignored.get("ignore/b.go:4:helper")).toBe("unbound external");
  });

  it("an import edge is recorded on the line of its spec", () => {
    const parsed = parseSource(
      "p/p.go",
      'package p\n\nimport "fmt"\n\nimport (\n\t"os"\n\n\tq "example.com/app/q"\n)\n\nvar _ = fmt.Sprint\nvar _ = os.Args\nvar _ = q.X\n',
      "go",
    );
    expect(
      parsed.edges.filter((e) => e.kind === "imports").map((e) => `${e.line} ${e.toQualifiedName}`),
    ).toEqual(["3 fmt", "6 os", "8 example.com/app/q"]);
  });

  describe("a value the walker does not model, assigned to an inferred local, drops what was inferred", () => {
    // `x := NewT()` types x by the call. Assigning something the walker cannot
    // read says nothing about the type: in Go that compiles it is the same
    // type, but the rule is for the walker's own mistakes — undecided.
    const after = (assignment: string, extra = ""): string | undefined =>
      goVerdicts({
        "p/p.go": `package p

type T struct{}

func (T) M() {}

func NewT() *T { return nil }

func fs() []func() *T { return nil }

func ff() func() *T { return nil }
${extra}
func use(y *T) {
	x := NewT()
	${assignment}
	x.M()
}
`,
      }).get("p/p.go:16:M");

    it("unchanged, and after an assignment the walker can read: still bound", () => {
      expect(after("_ = y")).toBe("receiver-type p/p.go::T::M");
      expect(after("x = NewT()")).toBe("receiver-type p/p.go::T::M");
      expect(after("x = nil")).toBe("receiver-type p/p.go::T::M");
    });

    it.each([
      ["a unary operation", "x = -y"],
      ["a binary operation", "x = y + y"],
      ["the result of calling a call result", "x = ff()()"],
      ["the result of calling an indexed element", "x = fs()[0]()"],
      ["the result of calling a parenthesised callee", "x = (NewT)()"],
      ["a conversion to a type written in place", "x = interface{ M() }(y)"],
      // A WRITTEN type, where the local was typed by a call: the two cannot be
      // compared from here, so nothing is claimed.
      ["a value of a written type", "x = y"],
      [
        "a func literal called on the spot, whose result type is written",
        "x = func() *T { return nil }()",
      ],
    ])("%s", (_what, assignment) => {
      expect(after(assignment)).toBe("unknown");
    });
  });
});
describe("reading a go.mod and guessing an import's name", () => {
  it("the module path: the first `module` directive, however it is spaced or quoted", () => {
    expect(parseGoModulePath("module example.com/app\n\ngo 1.22\n")).toBe("example.com/app");
    expect(parseGoModulePath("// header\n\nmodule\texample.com/app // comment\n")).toBe(
      "example.com/app",
    );
    expect(parseGoModulePath('module "example.com/app"\n')).toBe("example.com/app");
    expect(parseGoModulePath("module `example.com/app`\n")).toBe("example.com/app");
    // Not the directive: a word that merely starts like it, or nothing after it.
    expect(parseGoModulePath("modules example.com/app\n")).toBeNull();
    expect(parseGoModulePath("module\n")).toBeNull();
    expect(parseGoModulePath('module ""\n')).toBeNull();
    expect(parseGoModulePath("module // nothing\n")).toBeNull();
    expect(parseGoModulePath("go 1.22\n")).toBeNull();
    // A comment whose seventh character is a space is not the directive either.
    expect(parseGoModulePath("// the path\nmodule example.com/app\n")).toBe("example.com/app");
    // The first directive wins over a later line.
    expect(parseGoModulePath("modulex a\nmodule b\nmodule c\n")).toBe("b");
  });

  it("the default name of an import outside the tree: its last segment, past a version", () => {
    expect(goDefaultImportName("github.com/go-chi/chi")).toBe("chi");
    expect(goDefaultImportName("github.com/go-chi/chi/v5")).toBe("chi");
    expect(goDefaultImportName("github.com/go-chi/chi/v0")).toBe("chi");
    expect(goDefaultImportName("github.com/go-chi/chi/v19")).toBe("chi");
    expect(goDefaultImportName("gopkg.in/yaml.v3")).toBe("yaml");
    expect(goDefaultImportName("gopkg.in/yaml.v39")).toBe("yaml");
    // Not versions: one segment only, a `v` with no digits, a letter after it.
    expect(goDefaultImportName("v5")).toBe("v5");
    expect(goDefaultImportName("example.com/v")).toBe("v");
    expect(goDefaultImportName("example.com/tool/vx")).toBe("vx");
    expect(goDefaultImportName("example.com/tool/v1a")).toBe("v1a");
    expect(goDefaultImportName("example.com/v/")).toBe("");
    expect(goDefaultImportName("example.com/tool/v:")).toBe("v:");
    expect(goDefaultImportName("example.com/pkg.vx")).toBe("pkg.vx");
    expect(goDefaultImportName("example.com/.v3")).toBe(".v3");
    expect(goDefaultImportName("example.com/a.v")).toBe("a.v");
    expect(goDefaultImportName("example.com/a.v3")).toBe("a");
  });
});

describe("more of what an embedded interface holds", () => {
  it("an interface that embeds itself in a ring still holds only the ring's methods", () => {
    const v = goVerdicts({
      "p/p.go": `package p

type A interface {
	B
	One()
}

type B interface {
	A
	Two()
}

type S struct{ A }

func use(s S) {
	s.One()
	s.Two()
	s.Neither()
}
`,
    });
    expect(v.get("p/p.go:16:One")).toBe("unbound interface");
    expect(v.get("p/p.go:17:Two")).toBe("unbound interface");
    // A ring read once is CLOSED: a name it does not hold is nobody's.
    expect(v.get("p/p.go:18:Neither")).toBe("unknown");
  });

  it("a ring that does not pass through the interface asked about is read once too", () => {
    const v = goVerdicts({
      "p/p.go": `package p

type A interface{ B }

type B interface {
	C
	Two()
}

type C interface {
	B
	Three()
}

type S struct{ A }

func use(s S) {
	s.Two()
	s.Three()
	s.Neither()
}
`,
    });
    expect(v.get("p/p.go:18:Two")).toBe("unbound interface");
    expect(v.get("p/p.go:19:Three")).toBe("unbound interface");
    expect(v.get("p/p.go:20:Neither")).toBe("unknown");
  });

  it("an interface embedding something that is not an interface is not known in full", () => {
    // `Num` is a constraint element here, not a method set this module reads.
    const v = goVerdicts({
      "p/p.go": `package p

type Num int

type N interface {
	Num
	M()
}

type S struct{}

func (S) Foo() {}

type Both struct {
	N
	S
}

func use(b Both) {
	b.Foo()
	b.M()
}
`,
    });
    expect(v.get("p/p.go:20:Foo")).toBe("unknown");
    expect(v.get("p/p.go:21:M")).toBe("unbound interface");
  });
});

describe("more of what a test file adds", () => {
  it("test-file methods at two depths: the shallower one, not a tie", () => {
    const v = goVerdicts({
      "p/p.go": "package p\n\ntype S struct{ A }\n\ntype A struct{ B }\n\ntype B struct{}\n",
      "p/export_test.go": "package p\n\nfunc (A) M() {}\n\nfunc (B) M() {}\n",
      "p/p_test.go": "package p\n\nfunc probe(s S) {\n\ts.M()\n}\n",
    });
    expect(v.get("p/p_test.go:4:M")).toBe("receiver-type p/export_test.go::A::M");
  });

  it("…whichever of the two types the search meets first", () => {
    // B is embedded directly AND through A: B.M sits at depth 1, A's at 1 too — a tie.
    const tie = goVerdicts({
      "p/p.go": "package p\n\ntype S struct {\n\tB\n\tA\n}\n\ntype A struct{}\n\ntype B struct{}\n",
      "p/export_test.go": "package p\n\nfunc (A) M() {}\n\nfunc (B) M() {}\n",
      "p/p_test.go": "package p\n\nfunc probe(s S) {\n\ts.M()\n}\n",
    });
    expect(tie.get("p/p_test.go:4:M")).toBe("unbound ambiguous");
    // The deeper one is listed FIRST among the directory's types and still loses.
    const deeperFirst = goVerdicts({
      "p/p.go":
        "package p\n\ntype S struct {\n\tC\n}\n\ntype C struct {\n\tB\n}\n\ntype B struct{}\n",
      "p/export_test.go": "package p\n\nfunc (B) M() {}\n\nfunc (C) M() {}\n",
      "p/p_test.go": "package p\n\nfunc probe(s S) {\n\ts.M()\n}\n",
    });
    expect(deeperFirst.get("p/p_test.go:4:M")).toBe("receiver-type p/export_test.go::C::M");
  });

  it("a function only another package's test file declares is nobody's from outside", () => {
    const v = goVerdicts({
      "b/b.go": "package b\n\nfunc Real() {}\n",
      "b/export_test.go": "package b\n\nfunc Helper() {}\n",
      "a/a_test.go":
        'package a\n\nimport "example.com/app/b"\n\nfunc probe() {\n\tb.Helper()\n\tb.Real()\n}\n',
    });
    // Go does not compile this call; what matters is that it is not bound.
    expect(v.get("a/a_test.go:6:Helper")).toBe("unbound external");
    expect(v.get("a/a_test.go:7:Real")).toBe("package b/b.go::Real");
  });
});

describe("a build-ignored file's own package", () => {
  const GEN =
    "//go:build ignore\n\npackage main\n\nfunc main() {\n\thelper()\n\tmissing()\n}\n\nfunc helper() {}\n";

  it("the one ignored file of a directory is read in full: an undeclared name is nobody's", () => {
    const v = goVerdicts({
      "gen/gen.go": GEN,
      "gen/lib.go": "package gen\n\nfunc missing() {}\n",
    });
    expect(v.get("gen/gen.go:6:helper")).toBe("same-package gen/gen.go::helper");
    // The library's `missing` is another package's: not this program's.
    expect(v.get("gen/gen.go:7:missing")).toBe("unbound external");
  });

  it("beside ANOTHER ignored file the program is whatever `go run` is given: undecided", () => {
    const v = goVerdicts({
      "gen/gen.go": GEN,
      "gen/more.go": "//go:build ignore\n\npackage main\n\nfunc missing() {}\n",
      "gen/lib.go": "package gen\n",
    });
    expect(v.get("gen/gen.go:6:helper")).toBe("same-package gen/gen.go::helper");
    expect(v.get("gen/gen.go:7:missing")).toBe("unknown");
  });
});

describe("an indexed name whose type is not known", () => {
  it("a package variable is still a variable: an element of it is a func value", () => {
    const v = goVerdicts({
      "p/p.go": `package p

func pick[T any]() T {
	var zero T
	return zero
}

var hs = pick[[]func()]()

type T struct{ fs []func() }

func use(t T) {
	hs[0]()
	t.unknown[0]()
	t.fs[0]()
}
`,
    });
    expect(v.get("p/p.go:13:hs")).toBe("unbound func-value");
    // A member nothing declares: nothing is decided.
    expect(v.get("p/p.go:14:unknown")).toBe("unknown");
    expect(v.get("p/p.go:15:fs")).toBe("unbound func-value");
  });
});

describe("the depth limits are exact: twelve links, not thirteen", () => {
  const chain = (links: number, link: (i: number) => string): string => {
    let src = "";
    for (let i = links; i >= 1; i -= 1) src += link(i);
    return src;
  };
  const HEAD = "package p\n\ntype T struct{}\n\nfunc (T) M() {}\n\n";
  const last = (tree: Record<string, string>): string => goVerdicts(tree).values().at(-1)!;
  const BOUND = "receiver-type p/p.go::T::M";

  it.each([12, 13])("a chain of %i defined types down to a struct", (links) => {
    const src = `${HEAD}type D0 struct{ F *T }\n${chain(links, (i) => `type D${i} D${i - 1}\n`)}
func use(x D${links}) {
	x.F.M()
}
`;
    expect(last({ "p/p.go": src })).toBe(links === 12 ? BOUND : "unknown");
  });

  it.each([12, 13])("a chain of %i defined types down to a slice", (links) => {
    const src = `${HEAD}type L0 []*T\n${chain(links, (i) => `type L${i} L${i - 1}\n`)}
func use(x L${links}) {
	x[0].M()
}
`;
    expect(last({ "p/p.go": src })).toBe(links === 12 ? BOUND : "unknown");
  });

  it.each([12, 13])("a method promoted through %i embeddings", (depth) => {
    let src = HEAD;
    for (let i = 0; i < depth; i += 1) src += `type S${i} struct{ S${i + 1} }\n`;
    src += `type S${depth} struct{ T }\n\nfunc use(x S1) {\n\tx.M()\n}\n`;
    // From S1, T sits `depth` levels down.
    expect(last({ "p/p.go": src })).toBe(depth === 12 ? BOUND : "unknown");
  });
});
