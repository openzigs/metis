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
    // The constraint may sit below other comments: a licence header, a generator note.
    ["// Copyright 2026 The Authors.\n// SPDX-License-Identifier: MIT\n\n//go:build ignore", true],
    ["// Code generated by gen. DO NOT EDIT.\n\n// +build ignore", true],
    ["/* licence */\n//go:build ignore", true],
    ["// Copyright 2026 The Authors.\n\n//go:build linux", false],
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

  it("the importer's own module wins over a MORE SPECIFIC module path declared elsewhere", () => {
    // svc1 carves `storage` out as its own module, `app/storage`. From svc2
    // that path still means svc2's own `storage/` directory.
    const v = verdicts(tree, [...modules, { dir: "svc1/storage", path: "app/storage" }]);
    expect(v.get("svc2/cmd/main.go:6:Open")).toBe("package svc2/storage/s.go::Open");
    expect(v.get("svc2/cmd/main.go:7:Only1")).toBe("unbound external");
    expect(v.get("svc1/cmd/main.go:7:Only1")).toBe("package svc1/storage/s.go::Only1");
  });

  it("a module nested in another of the same path: the NEAREST go.mod is the importer's own", () => {
    const nested: GoModule[] = [
      { dir: "", path: "app" },
      { dir: "svc2", path: "app" },
    ];
    const v = verdicts(
      {
        "storage/s.go": "package storage\n\nfunc Open() {}\nfunc Only1() {}\n",
        "svc2/storage/s.go": "package storage\n\nfunc Open() {}\n",
        "cmd/main.go": caller,
        "svc2/cmd/main.go": caller,
      },
      nested,
    );
    expect(v.get("cmd/main.go:7:Only1")).toBe("package storage/s.go::Only1");
    expect(v.get("svc2/cmd/main.go:6:Open")).toBe("package svc2/storage/s.go::Open");
    expect(v.get("svc2/cmd/main.go:7:Only1")).toBe("unbound external");
  });

  it("a path the importer's own module does NOT hold goes to the more specific module elsewhere", () => {
    // `ex/app/tools` is a sibling checkout, not a directory under `app/`.
    const v = verdicts(
      {
        "tools/gen/g.go": "package gen\n\nfunc Make() {}\n",
        "app/cmd/main.go":
          'package main\n\nimport "ex/app/tools/gen"\n\nfunc main() {\n\tgen.Make()\n}\n',
      },
      [
        { dir: "app", path: "ex/app" },
        { dir: "tools", path: "ex/app/tools" },
      ],
    );
    expect(v.get("app/cmd/main.go:6:Make")).toBe("package tools/gen/g.go::Make");
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
      "tw/a_other.go":
        "//go:build !linux\n\npackage tw\n\ntype Conn int\n\nfunc conv() {\n\tConn(1)\n}\n",
      "tw/x.go": "package tw\n\nfunc untagged() {\n\tConn()\n}\n",
    });
    expect(v.get("tw/x.go:4:Conn")).toBe("unbound ambiguous");
    // The file that declares the type sees a conversion.
    expect(v.get("tw/a_other.go:8:Conn")).toBe("unbound conversion");
  });

  it("three twins of one name, two of them in ONE file's reach, stay ambiguous", () => {
    const v = verdicts({
      "tw/a.go": "//go:build a\n\npackage tw\n\nfunc Hook() {}\n\nfunc here() {\n\tHook()\n}\n",
      "tw/b.go": "//go:build b\n\npackage tw\n\nfunc Hook() {}\n",
      "tw/c.go": "//go:build c\n\npackage tw\n\nvar Hook = 1\n",
      "tw/x.go": "package tw\n\nfunc untagged() {\n\tHook()\n}\n",
    });
    expect(v.get("tw/x.go:4:Hook")).toBe("unbound ambiguous");
    expect(v.get("tw/a.go:8:Hook")).toBe("same-package tw/a.go::Hook");
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

describe("a value from outside the tree whose type nothing examined", () => {
  // Each method called is also declared on a project type; none may bind it,
  // and none is proven external either.
  const v = () =>
    verdicts({
      "p/p.go": `package p

import (
	"net/http"

	"github.com/acme/queue"
)

type impl struct{}

func (i *impl) Len() int      { return 0 }
func (i *impl) GetBody()      {}
func (i *impl) Run()          {}
func (i *impl) Foo()          {}

// A defined type over an external one keeps that type's FIELDS.
type Req http.Request

// A package variable of a third-party function type.
var factory queue.Factory

type A interface{ Foo() }
type B interface{ Foo() }

// Two project interfaces embedded at one depth.
type both struct {
	A
	B
}

func use(r *http.Request, q *Req, hs []http.Header, s both) {
	r.Header["Accept"].Len()
	q.GetBody()
	factory().Run()
	hs[0].Get("a")
	s.Foo()
}
`,
    });

  it("an ELEMENT of an external value", () => {
    expect(v().get("p/p.go:32:Len")).toBe("unbound external-assumed");
  });

  it("a member of a defined type over an external type", () => {
    expect(v().get("p/p.go:33:GetBody")).toBe("unbound external-assumed");
  });

  it("the result of calling a value of an external function type", () => {
    expect(v().get("p/p.go:34:Run")).toBe("unbound external-assumed");
  });

  it("control: an element whose type IS named in the source is examined: external, proven", () => {
    // `hs[0]` is an `http.Header`, a standard-library type that is not an interface.
    expect(v().get("p/p.go:35:Get")).toBe("unbound external");
  });

  it("two embedded project interfaces at one depth: which one declares the method is not known", () => {
    expect(v().get("p/p.go:36:Foo")).toBe("unbound ambiguous");
  });
});

describe("a conversion to a type of ANOTHER package", () => {
  it("is a value of that package's type: its methods are looked up there, not in the caller's package", () => {
    const v = verdicts({
      "model/tags.go":
        'package model\n\ntype Tags []string\n\nfunc (t Tags) Join() string { return "" }\n',
      "api/api.go": `package api

import "example.com/app/model"

type Tags struct{}

func (t Tags) Join() {}

func use(raw []string) {
	model.Tags(raw).Join()
	Tags{}.Join()
}
`,
    });
    expect(v.get("api/api.go:10:Join")).toBe("receiver-type model/tags.go::Tags::Join");
    expect(v.get("api/api.go:11:Join")).toBe("receiver-type api/api.go::Tags::Join");
  });
});

describe("an embedded interface holds the methods it declares and embeds, no others", () => {
  // PR #1104 review cycle 3 (L5) and its third panel: the parser records an
  // interface's own method names, so an embedded interface is not a type that
  // "answers to any name". A method exactly one member of the level declares
  // is that member's; only a real tie is ambiguous.
  const v = (extra = "") =>
    verdicts({
      "p/p.go": `package p

type I interface{ Bar() }

type S struct{}

func (s S) Foo() {}

type both struct {
	I
	S
}

func use(b both) {
	b.Foo()
	b.Bar()
}
${extra}`,
    });

  it("a method the STRUCT beside it declares binds to the struct's", () => {
    expect(v().get("p/p.go:15:Foo")).toBe("receiver-type p/p.go::S::Foo");
  });

  it("a method the interface declares is dispatched", () => {
    expect(v().get("p/p.go:16:Bar")).toBe("unbound interface");
  });

  it("two embedded interfaces: each method is the one interface's that declares it", () => {
    const two = v(`
type Store interface{ Save() }
type Logger interface{ Log() }
type Svc struct {
	Store
	Logger
}
func svc(s Svc) {
	s.Save()
	s.Log()
	s.Neither()
}
`);
    expect(two.get("p/p.go:26:Save")).toBe("unbound interface");
    expect(two.get("p/p.go:27:Log")).toBe("unbound interface");
    // Nobody declares it: nothing is decided, and nothing is guessed.
    expect(two.get("p/p.go:28:Neither")).toBe("unknown");
  });

  it("an interface's methods include those of the interfaces it embeds, at its own depth", () => {
    const nested = v(`
type Reader interface{ Read() }
type Closer interface{ Close() }
type ReadCloser interface {
	Reader
	Closer
	Flush()
}
type T struct{}
func (T) Own() {}
type W struct {
	ReadCloser
	T
}
func w(x W, rc ReadCloser) {
	x.Read()
	x.Close()
	x.Flush()
	x.Own()
	rc.Read()
}
`);
    expect(nested.get("p/p.go:33:Read")).toBe("unbound interface");
    expect(nested.get("p/p.go:34:Close")).toBe("unbound interface");
    expect(nested.get("p/p.go:35:Flush")).toBe("unbound interface");
    expect(nested.get("p/p.go:36:Own")).toBe("receiver-type p/p.go::T::Own");
    expect(nested.get("p/p.go:37:Read")).toBe("unbound interface");
  });

  it("a genuine tie — the interface AND the struct declare it — is ambiguous", () => {
    const tie = v(`
type J interface{ Foo() }
type tied struct {
	J
	S
}
func t(x tied) {
	x.Foo()
}
`);
    expect(tie.get("p/p.go:25:Foo")).toBe("unbound ambiguous");
  });

  it("an interface whose method set is NOT known in full leaves a sibling's method undecided", () => {
    // `io.Closer` is not read, a union is not a method set: the interface may
    // hold any name. That is an open question, not a tie — so `unknown`, which
    // a name-based reader may still follow, never the decided `ambiguous`.
    const open = verdicts({
      "p/p.go": `package p

import "io"

type S struct{}

func (S) Foo() {}

type Open interface {
	io.Closer
	Extra()
}

type Mixed struct {
	Open
	S
}

type Union interface{ ~int | ~string }

func use(m Mixed) {
	m.Foo()
	m.Extra()
	m.Close()
}
`,
    });
    expect(open.get("p/p.go:22:Foo")).toBe("unknown");
    expect(open.get("p/p.go:23:Extra")).toBe("unbound interface");
    // Only the open interface can hold a name nobody declares.
    expect(open.get("p/p.go:24:Close")).toBe("unbound interface");
  });

  it("an interface that embeds itself, directly or in a ring, is read once", () => {
    const ring = verdicts({
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
}
`,
    });
    expect(ring.get("p/p.go:16:One")).toBe("unbound interface");
    expect(ring.get("p/p.go:17:Two")).toBe("unbound interface");
  });
});

describe("walker rules: types as written", () => {
  const TYPES = `package p

type T struct{ next *T }

func (t *T) M() *T { return t }

type Other struct{}

func (o *Other) M() {}
`;
  const body = (src: string, extra = "") =>
    verdicts({
      "p/t.go": TYPES,
      "p/use.go": `package p\n\n${extra}\nfunc use(x *T, raw []any) {\n${src}\n}\n`,
    });

  it("a parenthesised type is the type inside it", () => {
    const v = body("\tvar y (*T)\n\ty.M()");
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("a conversion written with a composite type yields that type", () => {
    const v = body('\t[]*T(nil)[0].M()\n\tmap[string]*T(nil)["a"].M()');
    expect(v.get("p/use.go:5:M")).toBe("receiver-type p/t.go::T::M");
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("a map's KEY and its VALUE are told apart", () => {
    const v = body(
      "\tvar m map[*Other]*T\n\tfor k, e := range m {\n\t\tk.M()\n\t\te.M()\n\t}\n\tm[nil].M()",
    );
    expect(v.get("p/use.go:7:M")).toBe("receiver-type p/t.go::Other::M");
    expect(v.get("p/use.go:8:M")).toBe("receiver-type p/t.go::T::M");
    expect(v.get("p/use.go:10:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("a slice's index is not its element, and a channel carries its element", () => {
    const v = body(
      "\tvar xs []*T\n\tvar ch chan *T\n\tfor i, e := range xs {\n\t\t_ = i\n\t\te.M()\n\t}\n\t(<-ch).M()",
    );
    expect(v.get("p/use.go:9:M")).toBe("receiver-type p/t.go::T::M");
    expect(v.get("p/use.go:11:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("a function-typed value's result is the type its signature writes", () => {
    const v = body(
      "\tvar mk func() *T\n\tmk().M()\n\tvar pair func() (*Other, *T)\n\t_, b := pair()\n\tb.M()",
    );
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/t.go::T::M");
    expect(v.get("p/use.go:9:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("`a, b T` declares both names with that type, for parameters and for struct fields", () => {
    const v = verdicts({
      "p/t.go": TYPES,
      "p/use.go": `package p

type pair struct{ first, second *T }

func use(a, b *T, p pair) {
	b.M()
	p.second.M()
}
`,
    });
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/t.go::T::M");
    expect(v.get("p/use.go:7:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("a method's receiver may be written in parentheses", () => {
    const parsed = parseSource(
      "p/x.go",
      "package p\n\ntype S struct{}\n\nfunc (s (*S)) Save() {}\n",
      "go",
    );
    expect(parsed.symbols.map((s) => s.qualifiedName)).toContain("p/x.go::S::Save");
  });

  it("type parameters end with their declaration, for what follows at package level too", () => {
    const v = verdicts({
      "p/use.go": `package p

type T struct{}

func (t T) Save() {}

func Generic[T any](x T) {}

var afterFunc T

type Box[T any] struct{ item T }

var afterType T

func use() {
	afterFunc.Save()
	afterType.Save()
}
`,
    });
    // Each `T` is the package type again once the declaration that shadowed it ends.
    expect(v.get("p/use.go:16:Save")).toBe("receiver-type p/use.go::T::Save");
    expect(v.get("p/use.go:17:Save")).toBe("receiver-type p/use.go::T::Save");
  });

  it("a struct's type parameters end with the struct", () => {
    const v = verdicts({
      "p/use.go": `package p

type Box[T any] struct{ item T }

type T struct{}

func (t T) Save() {}

func use(x T) {
	x.Save()
}
`,
    });
    // `T` after `Box[T any]` is the package type again.
    expect(v.get("p/use.go:10:Save")).toBe("receiver-type p/use.go::T::Save");
  });

  it("an embedded field of a type-parameter type still occupies a promotion depth", () => {
    const v = verdicts({
      "p/use.go": `package p

type Inner struct{}

func (i Inner) Save() {}

type Mid struct{ Inner }

type Outer[T any] struct {
	T
	Mid
}

func use(o Outer[int]) {
	o.Save()
}
`,
    });
    // `T` may declare `Save` at depth 1, which would win over Mid.Inner.Save at depth 2.
    expect(v.get("p/use.go:15:Save")).toBe("unknown");
  });
});

describe("walker rules: declarations", () => {
  const TYPES = `package p

type T struct{}

func (t *T) M() {}

type Other struct{}

func (o *Other) M() {}

func mk() *T                 { return nil }
func two() (*Other, *T)      { return nil, nil }
`;

  it("a local named like a builtin is the local, not the builtin", () => {
    const v = verdicts({
      "p/t.go": TYPES,
      "p/use.go": `package p

func use() {
	new := func(o *Other) *T { return nil }
	x := new(nil)
	x.M()
	make := mk
	y := make()
	y.M()
}
`,
    });
    // Read as the builtin, `new(nil)` would be a value of the type `nil`.
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/t.go::T::M");
    expect(v.get("p/use.go:9:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("a const block repeats the previous spec's TYPE only where a spec has no value of its own", () => {
    const v = verdicts({
      "p/use.go": `package p

type Level int

func (l Level) Name() string { return "" }

const (
	Low Level = iota
	Mid
	Label = "x"
)

func use() {
	Low.Name()
	Mid.Name()
	Label.Name()
}
`,
    });
    expect(v.get("p/use.go:14:Name")).toBe("receiver-type p/use.go::Level::Name");
    expect(v.get("p/use.go:15:Name")).toBe("receiver-type p/use.go::Level::Name");
    // `Label` has its own value: it is not a Level.
    expect(v.get("p/use.go:16:Name")).toBe("unknown");
  });

  it("a package variable takes the result at ITS position of a multi-result call", () => {
    const v = verdicts({
      "p/t.go": TYPES,
      "p/use.go":
        "package p\n\nvar first, second = two()\n\nfunc use() {\n\tfirst.M()\n\tsecond.M()\n}\n",
    });
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/t.go::Other::M");
    expect(v.get("p/use.go:7:M")).toBe("receiver-type p/t.go::T::M");
  });

  it("a LOCAL variable of a type the walker does not model is not typed by its initialiser", () => {
    const v = verdicts({
      "p/t.go": TYPES,
      "p/use.go":
        "package p\n\nfunc use() {\n\tvar store interface{ M() } = &T{}\n\tstore.M()\n}\n",
    });
    // An interface value: `T::M` is only what it holds right now.
    expect(v.get("p/use.go:5:M")).toBe("unknown");
  });

  it("a type declared INSIDE a function is not a declaration of its package", () => {
    const v = verdicts({
      "p/t.go": TYPES,
      "p/use.go": `package p

func shadows() {
	type T struct{ n int }
	type Other = int
}

func use(x *T, o *Other) {
	x.M()
	o.M()
}
`,
    });
    // Recorded as package declarations, each would be a twin of the real
    // type and leave these two calls undecided.
    expect(v.get("p/use.go:9:M")).toBe("receiver-type p/t.go::T::M");
    expect(v.get("p/use.go:10:M")).toBe("receiver-type p/t.go::Other::M");
  });

  it("a package variable of a type the walker does not model is not typed by its initialiser", () => {
    const v = verdicts({
      "p/t.go": TYPES,
      "p/use.go":
        "package p\n\nvar store interface{ M() } = &T{}\n\nfunc use() {\n\tstore.M()\n}\n",
    });
    // The variable is an interface value; `T::M` is only what it holds right now.
    expect(v.get("p/use.go:6:M")).toBe("unknown");
  });

  it("records the calls made in a declaration's initialiser, and from where", () => {
    const parsed = parseSource(
      "p/use.go",
      `package p

func mk() int { return 0 }

func first() {
	x := mk()
	var y = mk()
	_, _ = x, y
}

var atPackageLevel = mk()

func second() {}
`,
      "go",
    );
    const calls = parsed.edges
      .filter((e) => e.kind === "calls")
      .map((e) => `${e.line} ${e.fromQualifiedName} > ${e.toQualifiedName}`);
    expect(calls).toEqual([
      "6 p/use.go::first > mk",
      "7 p/use.go::first > mk",
      // After `first` ends, a call is the file's again — not the last function's.
      "11 p/use.go > mk",
    ]);
  });

  it("a call nested in another call's arguments is recorded too", () => {
    const parsed = parseSource(
      "p/use.go",
      "package p\n\nfunc a(int) {}\nfunc b() int { return 0 }\n\nfunc use() {\n\ta(b())\n}\n",
      "go",
    );
    expect(parsed.edges.filter((e) => e.kind === "calls").map((e) => e.toQualifiedName)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("walker rules: every block is a scope", () => {
  const TYPES = `package p

type T struct{}

func (t *T) M() {}

type Other struct{}

func (o *Other) M() {}

func other() *Other { return nil }
`;
  const after = (block: string) =>
    verdicts({
      "p/t.go": TYPES,
      "p/use.go": `package p\n\nfunc use(x *T, ch chan int) {\n${block}\n\tx.M()\n}\n`,
    });
  const last = (v: ReturnType<typeof after>) => v.all("p/use.go:M").at(-1);
  const T_M = "receiver-type p/t.go::T::M";

  // In each, `x := other()` inside the block must not outlive it.
  it.each([
    ["a bare block", "\t{\n\t\tx := other()\n\t\t_ = x\n\t}"],
    ["an if body", "\tif true {\n\t\tx := other()\n\t\t_ = x\n\t}"],
    ["an if initialiser", "\tif x := other(); x != nil {\n\t}"],
    ["an else body", "\tif false {\n\t} else {\n\t\tx := other()\n\t\t_ = x\n\t}"],
    ["a for body", "\tfor {\n\t\tx := other()\n\t\t_ = x\n\t\tbreak\n\t}"],
    ["a for initialiser", "\tfor x := other(); x != nil; {\n\t\tbreak\n\t}"],
    ["a range clause", "\tfor _, x := range []*Other{} {\n\t\t_ = x\n\t}"],
    ["a switch initialiser", "\tswitch x := other(); {\n\tcase x != nil:\n\t}"],
    ["a switch case", "\tswitch {\n\tcase true:\n\t\tx := other()\n\t\t_ = x\n\t}"],
    ["a switch default", "\tswitch {\n\tdefault:\n\t\tx := other()\n\t\t_ = x\n\t}"],
    ["a select case", "\tselect {\n\tcase <-ch:\n\t\tx := other()\n\t\t_ = x\n\t}"],
    ["a select receive", "\tselect {\n\tcase x := <-ch:\n\t\t_ = x\n\t}"],
    ["a select default", "\tselect {\n\tdefault:\n\t\tx := other()\n\t\t_ = x\n\t}"],
    [
      "a type-switch case",
      "\tswitch any(nil).(type) {\n\tcase int:\n\t\tx := other()\n\t\t_ = x\n\t}",
    ],
    ["a closure body", "\tf := func() {\n\t\tx := other()\n\t\t_ = x\n\t}\n\t_ = f"],
  ])("%s", (_label, block) => {
    expect(last(after(block))).toBe(T_M);
  });

  // And inside the construct, a name its header declares is the one in scope.
  const OTHER_M = "receiver-type p/t.go::Other::M";
  it.each([
    ["an if initialiser", "\tif x := other(); x != nil {\n\t\tx.M()\n\t}"],
    ["an else branch of that if", "\tif x := other(); x == nil {\n\t} else {\n\t\tx.M()\n\t}"],
    ["a for initialiser", "\tfor x := other(); x != nil; {\n\t\tx.M()\n\t\tbreak\n\t}"],
    ["a switch initialiser", "\tswitch x := other(); {\n\tcase true:\n\t\tx.M()\n\t}"],
    [
      "a type-switch initialiser",
      "\tswitch x := other(); any(x).(type) {\n\tcase int:\n\t\tx.M()\n\t}",
    ],
  ])("%s declares for the whole statement", (_label, block) => {
    expect(after(block).all("p/use.go:M")).toEqual([OTHER_M, T_M]);
  });

  it("a declaration in one clause is not in scope in the next", () => {
    // `default` first: its `x` must not reach the `case` after it.
    const sw = after(
      "\tswitch {\n\tdefault:\n\t\tx := other()\n\t\t_ = x\n\tcase true:\n\t\tx.M()\n\t}",
    );
    expect(sw.all("p/use.go:M")).toEqual([T_M, T_M]);
    const sel = after(
      "\tselect {\n\tcase <-ch:\n\t\tx := other()\n\t\t_ = x\n\tcase <-ch:\n\t\tx.M()\n\t}",
    );
    expect(sel.all("p/use.go:M")).toEqual([T_M, T_M]);
    const ts = after(
      "\tswitch any(nil).(type) {\n\tcase int:\n\t\tx := other()\n\t\t_ = x\n\tcase string:\n\t\tx.M()\n\t}",
    );
    expect(ts.all("p/use.go:M")).toEqual([T_M, T_M]);
  });

  it("control: the same declaration IN the function's own block does replace it", () => {
    const v = verdicts({
      "p/t.go": TYPES,
      "p/use.go": "package p\n\nfunc use() {\n\tx := other()\n\tx.M()\n}\n",
    });
    expect(v.get("p/use.go:5:M")).toBe("receiver-type p/t.go::Other::M");
  });

  it("inside the block the inner declaration is the one in scope", () => {
    const v = after("\tif true {\n\t\tx := other()\n\t\tx.M()\n\t}");
    expect(v.all("p/use.go:M")).toEqual(["receiver-type p/t.go::Other::M", T_M]);
  });
});
