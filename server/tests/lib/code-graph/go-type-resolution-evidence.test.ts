/**
 * #1071 (PR #1104, review cycle 2 and the second adversarial panel) — rules
 * whose WRONG form binds a call to the wrong function, or decides one that the
 * source leaves open, and which no test could catch.
 *
 * Two were hidden by the tests themselves: the helper they used keyed verdicts
 * by `file:callee`, so a later call of the same name overwrote the one under
 * test. Every case here reads a verdict by its line (`tests/helpers/go-verdicts.ts`
 * refuses a key that names two calls), and every case names the function a
 * careless rule WOULD bind, so a rule that binds goes red.
 *
 * Real Go source through the real walker and resolver throughout.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type GoModule,
  type GoResolverOptions,
} from "../../../src/lib/code-graph/go-type-resolution.js";
import { initCodeGraphParsers, parseSource } from "../../../src/lib/code-graph/parsers.js";
import { goVerdicts, type GoTree } from "../../helpers/go-verdicts.js";

const MODULE: GoModule[] = [{ dir: "", path: "example.com/app" }];
const verdicts = (tree: GoTree, modules: GoModule[] = MODULE, options?: GoResolverOptions) =>
  goVerdicts(tree, modules, options);

const STORE_PKG = `package store

type Storage struct{}

func Save() {}
`;

beforeAll(async () => {
  await initCodeGraphParsers();
});

describe("a type parameter is not the package type of the same name", () => {
  it("a call on a value of a type parameter never binds the package type's method", () => {
    const v = verdicts({
      "a/a.go": `package a

type T struct{}

func (t T) Save() {}

func Run[T interface{ Save() }](x T) {
	x.Save()
}
`,
    });
    // `T` here is the type parameter: `a/a.go::T::Save` is an unrelated method.
    expect(v.get("a/a.go:8:Save")).toBe("unknown");
  });

  it("nor on a method whose receiver names the type parameter", () => {
    const v = verdicts({
      "a/a.go": `package a

type T struct{}

func (t T) Save() {}

type Box[T interface{ Save() }] struct{ item T }

func (b *Box[T]) Run(x T) {
	x.Save()
	b.item.Save()
}
`,
    });
    expect(v.get("a/a.go:10:Save")).toBe("unknown");
    // The field's type was read while `T` was the struct's own type parameter.
    expect(v.get("a/a.go:11:Save")).toBe("unknown");
  });

  it("control: the same call on a value of the package type binds", () => {
    const v = verdicts({
      "a/a.go": `package a

type T struct{}

func (t T) Save() {}

func Run(x T) {
	x.Save()
}
`,
    });
    expect(v.get("a/a.go:8:Save")).toBe("receiver-type a/a.go::T::Save");
  });

  it("the type parameter is gone after the function that declared it", () => {
    const v = verdicts({
      "a/a.go": `package a

type T struct{}

func (t T) Save() {}

func Generic[T any](x T) {}

func After(x T) {
	x.Save()
}
`,
    });
    expect(v.get("a/a.go:10:Save")).toBe("receiver-type a/a.go::T::Save");
  });
});

describe("a name of a type the walker does not model is bound to unknown, not left to the package scope", () => {
  it("a parameter of an interface-literal type named like an imported package", () => {
    const v = verdicts({
      "store/store.go": STORE_PKG,
      "a/a.go": `package a

import "example.com/app/store"

var _ = store.Save

func Run(store interface{ Save() }) {
	store.Save()
}
`,
    });
    // Unbound as a local, `store.Save()` would be the package function.
    expect(v.get("a/a.go:8:Save")).toBe("unknown");
  });

  it("a parameter of a type-parameter type named like a package variable", () => {
    const v = verdicts({
      "a/a.go": `package a

type Storage struct{}

func (s *Storage) Save() {}

var store = &Storage{}

func Run[S interface{ Save() }](store S) {
	store.Save()
}
`,
    });
    // Unbound as a local, `store` would be the package variable of type *Storage.
    expect(v.get("a/a.go:10:Save")).toBe("unknown");
  });

  it("a local `var` of an interface-literal type named like an imported package", () => {
    const v = verdicts({
      "store/store.go": STORE_PKG,
      "a/a.go": `package a

import "example.com/app/store"

var _ = store.Save

func Run() {
	var store interface{ Save() }
	store.Save()
}
`,
    });
    expect(v.get("a/a.go:9:Save")).toBe("unknown");
  });

  it("a named result and a closure parameter of an unmodelled type shadow the same way", () => {
    const v = verdicts({
      "store/store.go": STORE_PKG,
      "a/a.go": `package a

import "example.com/app/store"

var _ = store.Save

func Named() (store struct{ Save func() }) {
	store.Save()
	return
}

func Closure() {
	f := func(store interface{ Save() }) {
		store.Save()
	}
	_ = f
}
`,
    });
    expect(v.get("a/a.go:8:Save")).toBe("unknown");
    expect(v.get("a/a.go:14:Save")).toBe("unknown");
  });

  it("control: with no local of that name, the package function binds", () => {
    const v = verdicts({
      "store/store.go": STORE_PKG,
      "a/a.go": `package a

import "example.com/app/store"

func Run() {
	store.Save()
}
`,
    });
    expect(v.get("a/a.go:6:Save")).toBe("package store/store.go::Save");
  });
});

describe("`//go:build ignore` is matched exactly", () => {
  const ignored = (src: string): boolean =>
    parseSource("a/gen.go", src, "go").goFacts?.buildIgnored === true;

  it("a constraint that only CONTAINS the word does not take the file out of its package", () => {
    const v = verdicts({
      "a/gen.go": "//go:build !ignore_autogenerated\n\npackage a\n\nfunc Helper() {}\n",
      "a/a.go": "package a\n\nfunc Run() {\n\tHelper()\n}\n",
    });
    // Read as ignored, `Helper` leaves package `a` and the call is a decided `external`.
    expect(v.get("a/a.go:4:Helper")).toBe("same-package a/gen.go::Helper");
  });

  it.each([
    ["//go:build ignore", true],
    ["//go:build   ignore  ", true],
    ["// +build ignore", true],
    ["//go:build !ignore", false],
    ["//go:build ignore_autogenerated", false],
    ["//go:build !ignore_autogenerated", false],
    ["//go:build ignore || linux", false],
    ["//go:build linux && ignore", false],
    ["//go:build ignorex", false],
    ["// +build !ignore", false],
    ["// +build ignored", false],
    ["//go:buildignore", false],
    ["//+buildignore", false],
    ["//+build ignore", true],
  ])("%s → ignored: %s", (constraint, expected) => {
    expect(ignored(`${constraint}\n\npackage a\n\nfunc Helper() {}\n`)).toBe(expected);
  });
});

describe("a type name its project package does not declare decides nothing", () => {
  const STORE = "package store\n\ntype Storage struct{}\n";
  const QUALIFIED = `package a

import "example.com/app/store"

func Run(x *store.Missing) {
	x.Save()
}
`;
  const OWN = "package a\n\nfunc Run(x *Missing) {\n\tx.Save()\n}\n";

  it("a qualified type missing from a fully read project package", () => {
    const v = verdicts({ "store/store.go": STORE, "a/a.go": QUALIFIED });
    expect(v.get("a/a.go:6:Save")).toBe("unknown");
  });

  it("the same when a file of that directory was not read", () => {
    const v = verdicts({ "store/store.go": STORE, "a/a.go": QUALIFIED }, MODULE, {
      incompleteDirs: new Set(["store"]),
    });
    expect(v.get("a/a.go:6:Save")).toBe("unknown");
  });

  it("a type of the caller's own package that no read file declares", () => {
    expect(verdicts({ "a/a.go": OWN }).get("a/a.go:4:Save")).toBe("unknown");
  });

  it("the same when a file of the caller's directory was not read", () => {
    const v = verdicts({ "a/a.go": OWN }, MODULE, { incompleteDirs: new Set(["a"]) });
    expect(v.get("a/a.go:4:Save")).toBe("unknown");
  });

  it("control: a predeclared type name is still external, and `error` an interface", () => {
    const v = verdicts({
      "a/a.go": "package a\n\nfunc Run(n int, err error) {\n\tn.Save()\n\terr.Error()\n}\n",
    });
    expect(v.get("a/a.go:4:Save")).toBe("unbound external");
    expect(v.get("a/a.go:5:Error")).toBe("unbound interface");
  });
});

describe("two go.mod files that declare the same module path", () => {
  // A services monorepo: each directory is its own `module app`.
  const modules: GoModule[] = [
    { dir: "svc1", path: "app" },
    { dir: "svc2", path: "app" },
  ];
  const caller = `package main

import "app/storage"

func main() {
	storage.Open()
	storage.Only1()
}
`;
  const tree: GoTree = {
    "svc1/storage/s.go": "package storage\n\nfunc Open() {}\nfunc Only1() {}\n",
    "svc2/storage/s.go": "package storage\n\nfunc Open() {}\n",
    "svc1/cmd/main.go": caller,
    "svc2/cmd/main.go": caller,
  };

  it("an import resolves in the importing file's OWN module", () => {
    const v = verdicts(tree, modules);
    expect(v.get("svc1/cmd/main.go:6:Open")).toBe("package svc1/storage/s.go::Open");
    expect(v.get("svc2/cmd/main.go:6:Open")).toBe("package svc2/storage/s.go::Open");
  });

  it("so a name only the OTHER module's package declares is not this one's", () => {
    const v = verdicts(tree, modules);
    expect(v.get("svc1/cmd/main.go:7:Only1")).toBe("package svc1/storage/s.go::Only1");
    // `svc2/storage` was read in full and declares no `Only1`.
    expect(v.get("svc2/cmd/main.go:7:Only1")).toBe("unbound external");
  });

  it("is undecided from a file that is in neither module", () => {
    const v = verdicts({ ...tree, "tools/t.go": caller }, modules);
    expect(v.get("tools/t.go:6:Open")).toBe("unknown");
    expect(v.get("tools/t.go:7:Only1")).toBe("unknown");
  });

  it("is undecided from a third module when two others claim the path", () => {
    const v = verdicts({ ...tree, "svc3/cmd/main.go": caller }, [
      ...modules,
      { dir: "svc3", path: "other" },
    ]);
    expect(v.get("svc3/cmd/main.go:6:Open")).toBe("unknown");
  });

  it("the importer's own module wins even when its directory has no such package yet", () => {
    // svc2 imports `app/extra`, which only svc1 holds: not svc1's — undecided.
    const v = verdicts(
      {
        "svc1/extra/e.go": "package extra\n\nfunc Do() {}\n",
        "svc2/cmd/main.go":
          'package main\n\nimport "app/extra"\n\nfunc main() {\n\textra.Do()\n}\n',
      },
      modules,
    );
    expect(v.get("svc2/cmd/main.go:6:Do")).toBe("unknown");
  });

  it("control: one go.mod per path resolves as before, nested modules included", () => {
    const v = verdicts(
      {
        "tools/gen/g.go": "package gen\n\nfunc Make() {}\n",
        "cmd/main.go":
          'package main\n\nimport "example.com/app/tools/gen"\n\nfunc main() {\n\tgen.Make()\n}\n',
      },
      [
        { dir: "", path: "example.com/app" },
        { dir: "tools", path: "example.com/app/tools" },
      ],
    );
    expect(v.get("cmd/main.go:6:Make")).toBe("package tools/gen/g.go::Make");
  });
});

describe("a directory with files the resolver did not read is incomplete", () => {
  const GEN =
    "//go:build ignore\n\npackage main\n\nfunc main() {\n\thelper()\n\town()\n}\n\nfunc own() {}\n";
  const HELPERS = "//go:build ignore\n\npackage main\n\nfunc helper() {}\n";

  it("a build-ignored file calling a function of a sibling ignored file is undecided", () => {
    // `go run generate.go gen_helpers.go`: the two are one program.
    const v = verdicts({ "gen/generate.go": GEN, "gen/gen_helpers.go": HELPERS });
    expect(v.get("gen/generate.go:6:helper")).toBe("unknown");
    expect(v.get("gen/generate.go:7:own")).toBe("same-package gen/generate.go::own");
  });

  it("an ignored file ALONE is its whole package: an undeclared name is external", () => {
    const v = verdicts({ "gen/generate.go": GEN });
    expect(v.get("gen/generate.go:6:helper")).toBe("unbound external");
  });

  it("an ignored file beside an UNREAD file is undecided too", () => {
    const v = verdicts({ "gen/generate.go": GEN }, MODULE, { incompleteDirs: new Set(["gen"]) });
    expect(v.get("gen/generate.go:6:helper")).toBe("unknown");
  });
});

describe("a name declared as two kinds of thing is twins behind build constraints", () => {
  const LINUX = "//go:build linux\n\npackage tw\n\nfunc Hook() {}\n\nfunc here() {\n\tHook()\n}\n";
  const OTHER =
    "//go:build !linux\n\npackage tw\n\nvar Hook = func() {}\n\nfunc there() {\n\tHook()\n}\n";
  const tree: GoTree = {
    "tw/hook_linux.go": LINUX,
    "tw/hook_other.go": OTHER,
    "tw/x.go": "package tw\n\nfunc untagged() {\n\tHook()\n}\n",
    "caller/c.go": 'package caller\n\nimport "example.com/app/tw"\n\nfunc f() {\n\ttw.Hook()\n}\n',
  };

  it("a function in one twin and a variable in the other: ambiguous from another package", () => {
    expect(verdicts(tree).get("caller/c.go:6:Hook")).toBe("unbound ambiguous");
  });

  it("and from an untagged file of the same package", () => {
    expect(verdicts(tree).get("tw/x.go:4:Hook")).toBe("unbound ambiguous");
  });

  it("each twin file sees its own declaration", () => {
    const v = verdicts(tree);
    expect(v.get("tw/hook_linux.go:8:Hook")).toBe("same-package tw/hook_linux.go::Hook");
    expect(v.get("tw/hook_other.go:8:Hook")).toBe("unbound func-value");
  });

  it("a function and a TYPE of one name are ambiguous the same way", () => {
    const v = verdicts({
      "tw/a_linux.go": "//go:build linux\n\npackage tw\n\nfunc Conn() {}\n",
      "tw/a_other.go": "//go:build !linux\n\npackage tw\n\ntype Conn int\n",
      "tw/x.go": "package tw\n\nfunc untagged() {\n\tConn()\n}\n",
    });
    expect(v.get("tw/x.go:4:Conn")).toBe("unbound ambiguous");
  });

  it("a field and a method of one name on one type are ambiguous, not the field", () => {
    const v = verdicts({
      "tw/t.go": "package tw\n\ntype T struct{ Hook func() }\n\nfunc use(t *T) {\n\tt.Hook()\n}\n",
      "tw/t_linux.go": "//go:build linux\n\npackage tw\n\nfunc (t *T) Hook() {}\n",
    });
    expect(v.get("tw/t.go:6:Hook")).toBe("unbound ambiguous");
  });

  it("control: a field alone is a function value, a method alone binds", () => {
    const field = verdicts({
      "tw/t.go": "package tw\n\ntype T struct{ Hook func() }\n\nfunc use(t *T) {\n\tt.Hook()\n}\n",
    });
    expect(field.get("tw/t.go:6:Hook")).toBe("unbound func-value");
    const method = verdicts({
      "tw/t.go": "package tw\n\ntype T struct{}\n\nfunc use(t *T) {\n\tt.Hook()\n}\n",
      "tw/t_linux.go": "//go:build linux\n\npackage tw\n\nfunc (t *T) Hook() {}\n",
    });
    expect(method.get("tw/t.go:6:Hook")).toBe("receiver-type tw/t_linux.go::T::Hook");
  });
});
