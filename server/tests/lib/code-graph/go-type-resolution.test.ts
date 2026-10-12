/**
 * #1071 — Go calls are bound by the types the source declares.
 *
 * Every case runs the real tree-sitter Go walker over a small tree and asks the
 * resolver for each call's verdict, so the two halves are tested as ingest uses
 * them: the walker's local inference (`x := NewFoo()`), the resolver's
 * cross-file lookups (a field declared in another file, a method declared in
 * another package).
 *
 * The cases that matter most are the ones that must NOT bind. A wrong `calls`
 * edge feeds the impact blast radius, Tested-by and the plan localisation walk.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  createGoResolver,
  goDefaultImportName,
  parseGoModulePath,
  type GoExpr,
  type GoModule,
} from "../../../src/lib/code-graph/go-type-resolution.js";
import { initCodeGraphParsers, parseSource } from "../../../src/lib/code-graph/parsers.js";
import { goVerdicts, showGoVerdict } from "../../helpers/go-verdicts.js";
import { expectLinearTime } from "../../helpers/linear-time.js";

type Tree = Record<string, string>;

const MODULE: GoModule[] = [{ dir: "", path: "example.com/app" }];

/** Every call of the tree, uniquely keyed: see `tests/helpers/go-verdicts.ts`. */
const verdicts = (tree: Tree, modules: GoModule[] = MODULE) => goVerdicts(tree, modules);
const show = showGoVerdict;

const STORAGE = `package storage

type Storage struct{ db *sql.DB }

func NewStorage() *Storage { return &Storage{} }

func (s *Storage) SetEntriesStatus(ids []int64) error { return nil }
func (s *Storage) NewBuilder() *Builder { return &Builder{} }
`;

const BUILDER = `package storage

type Builder struct{}

func (b *Builder) WithLimit(n int) *Builder { return b }
func (b *Builder) Run() ([]int, error) { return nil, nil }
`;

beforeAll(async () => {
  await initCodeGraphParsers();
});

describe("#1071 — a Go method is named after its receiver type", () => {
  const symbols = (src: string) =>
    parseSource("pkg/x.go", src, "go")
      .symbols.filter((s) => s.kind !== "module")
      .map((s) => `${s.kind} ${s.name} ${s.qualifiedName}`);

  it("qualifies pointer, value, unnamed and generic receivers by the base type", () => {
    expect(
      symbols(`package pkg

type Storage struct{}
type Named int
type List[T any] struct{}

func (s *Storage) Save() {}
func (n Named) String() string { return "" }
func (Named) Zero() {}
func (l *List[T]) Add(v T) {}
func Plain() {}
`),
    ).toEqual([
      "class Storage pkg/x.go::Storage",
      "type Named pkg/x.go::Named",
      "class List pkg/x.go::List",
      "function Save pkg/x.go::Storage::Save",
      "function String pkg/x.go::Named::String",
      "function Zero pkg/x.go::Named::Zero",
      "function Add pkg/x.go::List::Add",
      "function Plain pkg/x.go::Plain",
    ]);
  });

  it("gives two methods of one name in one file different qualified names", () => {
    const got = symbols(`package pkg

type A struct{}
type B struct{}

func (a *A) Close() error { return nil }
func (b *B) Close() error { return nil }
`);
    expect(got).toContain("function Close pkg/x.go::A::Close");
    expect(got).toContain("function Close pkg/x.go::B::Close");
  });

  it("files a method's calls under the method, not under its same-named twin", () => {
    const parsed = parseSource(
      "pkg/x.go",
      `package pkg

type A struct{}
type B struct{}

func (a *A) Close() { first() }
func (b *B) Close() { second() }
func first()  {}
func second() {}
`,
      "go",
    );
    const from = (callee: string) =>
      parsed.edges.find((e) => e.kind === "calls" && e.toQualifiedName === callee)
        ?.fromQualifiedName;
    expect(from("first")).toBe("pkg/x.go::A::Close");
    expect(from("second")).toBe("pkg/x.go::B::Close");
  });

  it("still records a type declared inside a function as a symbol", () => {
    expect(
      symbols(`package pkg

func F() {
	type local struct{}
	_ = local{}
}
`),
    ).toEqual(["function F pkg/x.go::F", "class local pkg/x.go::local"]);
  });
});

describe("#1071 — receiver, field and constructor types bind method calls", () => {
  it("binds a handler's call through a struct field to the storage method (the issue's case)", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "internal/api/handler.go": `package api

import "example.com/app/internal/storage"

type handler struct {
	store *storage.Storage
}
`,
      // The field is declared in another file of the package than the call.
      "internal/api/entry.go": `package api

func (h *handler) updateEntries(ids []int64) {
	h.store.SetEntriesStatus(ids)
}
`,
    });
    expect(v.get("internal/api/entry.go:SetEntriesStatus")).toBe(
      "receiver-type internal/storage/storage.go::Storage::SetEntriesStatus",
    );
  });

  it("binds a local from a constructor call, a composite literal, new() and a declared type", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "internal/storage/builder.go": BUILDER,
      "cmd/main.go": `package main

import "example.com/app/internal/storage"

func a() {
	s := storage.NewStorage()
	s.SetEntriesStatus(nil)
}
func b() {
	b := &storage.Builder{}
	b.WithLimit(1)
}
func c() {
	c := storage.Builder{}
	c.Run()
}
func d() {
	d := new(storage.Storage)
	d.NewBuilder()
}
`,
    });
    expect(v.get("cmd/main.go:SetEntriesStatus")).toBe(
      "receiver-type internal/storage/storage.go::Storage::SetEntriesStatus",
    );
    expect(v.get("cmd/main.go:WithLimit")).toBe(
      "receiver-type internal/storage/builder.go::Builder::WithLimit",
    );
    expect(v.get("cmd/main.go:Run")).toBe(
      "receiver-type internal/storage/builder.go::Builder::Run",
    );
    expect(v.get("cmd/main.go:NewBuilder")).toBe(
      "receiver-type internal/storage/storage.go::Storage::NewBuilder",
    );
  });

  it("binds through parameters, var declarations and the first of several results", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "internal/storage/builder.go": BUILDER,
      "internal/storage/open.go": `package storage

func Open() (*Storage, error) { return nil, nil }

func use(p *Storage) {
	p.SetEntriesStatus(nil)
	var b Builder
	b.WithLimit(1)
	s, err := Open()
	_ = err
	s.NewBuilder()
}
`,
    });
    expect(v.get("internal/storage/open.go:SetEntriesStatus")).toBe(
      "receiver-type internal/storage/storage.go::Storage::SetEntriesStatus",
    );
    expect(v.get("internal/storage/open.go:WithLimit")).toBe(
      "receiver-type internal/storage/builder.go::Builder::WithLimit",
    );
    expect(v.get("internal/storage/open.go:NewBuilder")).toBe(
      "receiver-type internal/storage/storage.go::Storage::NewBuilder",
    );
  });

  it("follows a fluent chain through each method's declared result", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "internal/storage/builder.go": BUILDER,
      "internal/ui/page.go": `package ui

import "example.com/app/internal/storage"

type handler struct{ store *storage.Storage }

func (h *handler) show() {
	h.store.NewBuilder().
		WithLimit(10).
		Run()
}
`,
    });
    expect(v.get("internal/ui/page.go:NewBuilder")).toBe(
      "receiver-type internal/storage/storage.go::Storage::NewBuilder",
    );
    expect(v.get("internal/ui/page.go:WithLimit")).toBe(
      "receiver-type internal/storage/builder.go::Builder::WithLimit",
    );
    expect(v.get("internal/ui/page.go:Run")).toBe(
      "receiver-type internal/storage/builder.go::Builder::Run",
    );
  });

  it("reads the element type of a slice, a map and a defined slice type", () => {
    const v = verdicts({
      "model/entry.go": `package model

type Entry struct{}
type Entries []*Entry

func (e *Entry) Touch() {}
func (e *Entry) Index() {}
func (e *Entry) Value() {}
func (e *Entry) First() {}
`,
      "model/use.go": `package model

func use(list Entries, byID map[int64]*Entry, raw []Entry) {
	for _, e := range list {
		e.Touch()
	}
	for _, e := range byID {
		e.Value()
	}
	raw[0].Index()
	list[0].First()
}
`,
    });
    expect(v.get("model/use.go:Touch")).toBe("receiver-type model/entry.go::Entry::Touch");
    expect(v.get("model/use.go:Value")).toBe("receiver-type model/entry.go::Entry::Value");
    expect(v.get("model/use.go:Index")).toBe("receiver-type model/entry.go::Entry::Index");
    expect(v.get("model/use.go:First")).toBe("receiver-type model/entry.go::Entry::First");
  });

  it("reads a package-level variable's declared type or initialiser, and a typed constant", () => {
    const v = verdicts({
      "config/config.go": `package config

type options struct{}

func (o *options) Port() int { return 0 }
func newOptions() *options  { return &options{} }

var Opts *options
var fallback = newOptions()

type Level int

func (l Level) Name() string { return "" }

const (
	Low Level = iota
	High
)
`,
      "cmd/main.go": `package main

import "example.com/app/config"

func main() {
	config.Opts.Port()
	config.High.Name()
}
`,
      "config/use.go": `package config

func use() { fallback.Port() }
`,
    });
    expect(v.get("cmd/main.go:Port")).toBe("receiver-type config/config.go::options::Port");
    expect(v.get("cmd/main.go:Name")).toBe("receiver-type config/config.go::Level::Name");
    expect(v.get("config/use.go:Port")).toBe("receiver-type config/config.go::options::Port");
  });

  it("narrows a type switch and a type assertion to the asserted type", () => {
    const v = verdicts({
      "p/t.go": `package p

type A struct{}
type B struct{}

func (a *A) OnA() {}
func (b *B) OnB() {}

func use(x any) {
	switch t := x.(type) {
	case *A:
		t.OnA()
	}
	b := x.(*B)
	b.OnB()
}
`,
    });
    expect(v.get("p/t.go:OnA")).toBe("receiver-type p/t.go::A::OnA");
    expect(v.get("p/t.go:OnB")).toBe("receiver-type p/t.go::B::OnB");
  });

  it("resolves a type alias to the type it names", () => {
    const v = verdicts({
      "p/t.go": `package p

type Real struct{}
type Alias = Real

func (r *Real) Do() {}

func use(a Alias) { a.Do() }
`,
    });
    expect(v.get("p/t.go:Do")).toBe("receiver-type p/t.go::Real::Do");
  });
});

describe("#1071 — the other ways Go gives a value its type", () => {
  const ENTRY = `package model

type Entry struct{ Tags Tags }
type Tags []string

func (e *Entry) Touch() {}
func (t Tags) Join() string { return "" }
func Load() (*Entry, error)  { return nil, nil }
func Both() (a, b *Entry)    { return nil, nil }
`;
  const use = (body: string, extra = "") =>
    verdicts({
      "model/entry.go": ENTRY,
      "model/use.go": `package model\n\n${extra}\nfunc use(in chan *Entry, byID map[string]*Entry, rest ...*Entry) {\n${body}\n}\n`,
    }).get("model/use.go:Touch");
  const TOUCH = "receiver-type model/entry.go::Entry::Touch";

  it("a channel receive, in a statement, a select case and a range", () => {
    expect(use("\te := <-in\n\te.Touch()")).toBe(TOUCH);
    expect(use("\te, ok := <-in\n\t_ = ok\n\te.Touch()")).toBe(TOUCH);
    expect(use("\tselect {\n\tcase e := <-in:\n\t\te.Touch()\n\t}")).toBe(TOUCH);
  });

  it("a map index, with and without the comma-ok form, and a variadic parameter", () => {
    expect(use('\tbyID["a"].Touch()')).toBe(TOUCH);
    expect(use('\te, ok := byID["a"]\n\t_ = ok\n\te.Touch()')).toBe(TOUCH);
    expect(use("\trest[0].Touch()")).toBe(TOUCH);
    expect(use("\tfor _, e := range rest {\n\t\te.Touch()\n\t}")).toBe(TOUCH);
  });

  it("make, new, append, a slice expression and a dereference keep the operand's type", () => {
    expect(use("\tlist := make([]*Entry, 0)\n\tlist[0].Touch()")).toBe(TOUCH);
    expect(use("\tlist := append(rest, nil)\n\tlist[1:][0].Touch()")).toBe(TOUCH);
    expect(use("\te := new(Entry)\n\t(*e).Touch()")).toBe(TOUCH);
    expect(use("\te := Entry{}\n\tp := &e\n\tp.Touch()")).toBe(TOUCH);
  });

  it("a var declaration with a value, several names, or several results", () => {
    expect(use("\tvar e = &Entry{}\n\te.Touch()")).toBe(TOUCH);
    expect(use("\tvar a, b *Entry\n\t_ = a\n\tb.Touch()")).toBe(TOUCH);
    expect(use("\tvar e, err = Load()\n\t_ = err\n\te.Touch()")).toBe(TOUCH);
    expect(use("\tvar a, b = &Entry{}, &Entry{}\n\t_ = a\n\tb.Touch()")).toBe(TOUCH);
    expect(use("\t_, second := Both()\n\tsecond.Touch()")).toBe(TOUCH);
  });

  it("a closure's parameters and declared result, and a function-typed value's result", () => {
    expect(use("\tf := func(e *Entry) { e.Touch() }\n\t_ = f")).toBe(TOUCH);
    expect(use("\tf := func() *Entry { return nil }\n\tf().Touch()")).toBe(TOUCH);
    expect(use("\tfunc() *Entry { return nil }().Touch()")).toBe(TOUCH);
    expect(use("", "func named() (mk *Entry) {\n\tmk.Touch()\n\treturn\n}\n")).toBe(TOUCH);
    expect(use("\tfactory().Touch()", "var factory func() *Entry\n")).toBe(TOUCH);
    expect(use("\tmake2().Touch()", "type maker func() *Entry\n\nvar make2 maker\n")).toBe(TOUCH);
  });

  it("a conversion written as a type expression, and a field of a defined slice type", () => {
    const v = verdicts({
      "model/entry.go": ENTRY,
      "model/use.go": `package model

func use(e *Entry, raw []string) {
	e.Tags.Join()
	Tags(raw).Join()
}
`,
    });
    // Line 4 is the field of a defined slice type, line 5 the conversion.
    expect(v.all("model/use.go:Join")).toEqual([
      "receiver-type model/entry.go::Tags::Join",
      "receiver-type model/entry.go::Tags::Join",
    ]);
  });

  it("an unnamed result, a local constant and a second comma-ok name stay unknown", () => {
    expect(use("\tconst limit = 3\n\tlimit.Touch()")).toBe("unknown");
    expect(use('\t_, ok := byID["a"]\n\tok.Touch()')).toBe("unknown");
    expect(use("\tvar x struct{ n int }\n\tx.Touch()")).toBe("unknown");
    expect(use("\tfor i := range rest {\n\t\ti.Touch()\n\t}")).toBe("unknown");
  });

  it("`for _, e = range` and `case e = <-ch` assign: inside them `e` is still the outer variable", () => {
    const tree = (body: string) =>
      verdicts({
        "model/entry.go": ENTRY,
        "model/use.go": `package model\n\ntype Other struct{}\n\nfunc (o *Other) Touch() {}\n\nfunc use(in chan *Entry, rest []*Entry) {\n\tvar e *Other\n${body}\n}\n`,
      }).get("model/use.go:Touch");
    const OTHER = "receiver-type model/use.go::Other::Touch";
    // Declared instead, `e` would be an *Entry inside the loop and the case.
    expect(tree("\tfor _, e = range rest {\n\t\te.Touch()\n\t}")).toBe(OTHER);
    expect(tree("\tselect {\n\tcase e = <-in:\n\t\te.Touch()\n\t}")).toBe(OTHER);
    // Control: with `:=` they declare.
    expect(tree("\tfor _, e := range rest {\n\t\te.Touch()\n\t}")).toBe(TOUCH);
    expect(tree("\tselect {\n\tcase e := <-in:\n\t\te.Touch()\n\t}")).toBe(TOUCH);
  });

  it("the `ok` of a comma-ok receive in a select case is not the value", () => {
    expect(use("\tselect {\n\tcase e, ok := <-in:\n\t\t_ = e\n\t\tok.Touch()\n\t}")).toBe(
      "unknown",
    );
    expect(use("\tselect {\n\tcase e, ok := <-in:\n\t\t_ = ok\n\t\te.Touch()\n\t}")).toBe(TOUCH);
  });

  it("assigning to existing variables in a range or a receive declares nothing", () => {
    const body =
      "\tvar e *Entry\n\tvar i any\n\tfor i, e = range rest {\n\t}\n\t_ = i\n\te.Touch()";
    expect(use(body)).toBe(TOUCH);
    expect(use("\tvar e *Entry\n\tselect {\n\tcase e = <-in:\n\t}\n\te.Touch()")).toBe(TOUCH);
  });

  it("records what an interface declares, and a struct's named and embedded fields", () => {
    const parsed = parseSource(
      "p/t.go",
      `package p

type Reader interface {
	Read() error
	Close() error
}

type Box struct {
	Reader
	*inner
	label, note string
	grid [4]int
}
`,
      "go",
    );
    expect(parsed.goFacts?.types).toEqual([
      { name: "Reader", form: "interface", methods: ["Read", "Close"] },
      {
        name: "Box",
        form: "struct",
        fields: [
          { name: "Reader", type: { k: "named", name: "Reader" }, embedded: true },
          { name: "inner", type: { k: "named", name: "inner" }, embedded: true },
          { name: "label", type: { k: "named", name: "string" } },
          { name: "note", type: { k: "named", name: "string" } },
          { name: "grid", type: { k: "list", elem: { k: "named", name: "int" } } },
        ],
      },
    ]);
  });

  it("records imports with their aliases, and the package clause", () => {
    const parsed = parseSource(
      "p/t.go",
      'package p\n\nimport "fmt"\n\nimport (\n\tst "x/storage"\n\t. "x/dot"\n\t_ "embed"\n)\n',
      "go",
    );
    expect(parsed.goFacts?.package).toBe("p");
    expect(parsed.goFacts?.imports).toEqual([
      { path: "fmt" },
      { path: "x/storage", alias: "st" },
      { path: "x/dot", alias: "." },
      { path: "embed", alias: "_" },
    ]);
    expect(parsed.edges.filter((e) => e.kind === "imports").map((e) => e.toQualifiedName)).toEqual([
      "fmt",
      "x/storage",
      "x/dot",
      "embed",
    ]);
  });
});

describe("#1071 — Go's scoping decides which declaration a name means", () => {
  it("lets an inner declaration shadow the outer one for its block only", () => {
    const parsed = parseSource(
      "p/t.go",
      `package p

type A struct{}
type B struct{}

func (a *A) Do() {}
func (b *B) Do() {}

func use() {
	x := &A{}
	if true {
		x := &B{}
		x.Do()
	}
	x.Do()
}
`,
      "go",
    );
    const resolver = createGoResolver(
      [{ filePath: "p/t.go", facts: parsed.goFacts!, isTest: false }],
      MODULE,
    );
    const calls = parsed.edges
      .filter((e) => e.kind === "calls")
      .map((e) => `${e.line} ${show(resolver.resolveCall("p/t.go", e.goCallee!))}`);
    expect(calls).toEqual(["13 receiver-type p/t.go::B::Do", "15 receiver-type p/t.go::A::Do"]);
  });

  it("scopes a declaration to a bare block and to a switch case", () => {
    const parsed = parseSource(
      "p/t.go",
      `package p

type A struct{}
type B struct{}

func (a *A) Do() {}
func (b *B) Do() {}

func use(n int) {
	x := &A{}
	{
		x := &B{}
		x.Do()
	}
	x.Do()
	switch n {
	case 1:
		x := &B{}
		x.Do()
	default:
		x.Do()
	}
}
`,
      "go",
    );
    const resolver = createGoResolver(
      [{ filePath: "p/t.go", facts: parsed.goFacts!, isTest: false }],
      MODULE,
    );
    const calls = parsed.edges
      .filter((e) => e.kind === "calls")
      .map((e) => `${e.line} ${show(resolver.resolveCall("p/t.go", e.goCallee!))}`);
    expect(calls).toEqual([
      "13 receiver-type p/t.go::B::Do",
      "15 receiver-type p/t.go::A::Do",
      "19 receiver-type p/t.go::B::Do",
      "21 receiver-type p/t.go::A::Do",
    ]);
  });

  it("keeps a variable's type across an assignment (a static type never changes)", () => {
    const v = verdicts({
      "p/t.go": `package p

type A struct{}

func (a *A) Do() {}
func other() *A { return nil }

func use() {
	x := &A{}
	x = other()
	x.Do()
}
`,
    });
    expect(v.get("p/t.go:Do")).toBe("receiver-type p/t.go::A::Do");
  });

  it("reads a local that shadows an import alias as the local", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "cmd/main.go": `package main

import "example.com/app/internal/storage"

func main() {
	storage := storage.NewStorage()
	storage.SetEntriesStatus(nil)
}
`,
    });
    expect(v.get("cmd/main.go:SetEntriesStatus")).toBe(
      "receiver-type internal/storage/storage.go::Storage::SetEntriesStatus",
    );
  });

  it("does not read a type parameter or a function-local type as a package type", () => {
    const v = verdicts({
      "p/t.go": `package p

type T struct{}

func (t *T) Do() {}

func generic[T any](v T) { v.Do() }

func local() {
	type T struct{ n int }
	var v T
	v.Do()
}
`,
    });
    // Line 7 is the call on the type parameter, line 12 the one on the local type.
    expect(v.all("p/t.go:Do")).toEqual(["unknown", "unknown"]);
  });
});

describe("#1071 — package-qualified and bare calls", () => {
  const tree: Tree = {
    "internal/storage/storage.go": STORAGE,
    "internal/api/api.go": `package api

import (
	"fmt"
	st "example.com/app/internal/storage"
	"github.com/acme/widget/v2"
)

func helper() {}

func Serve() {
	st.NewStorage()
	fmt.Println("x")
	widget.Spin()
	helper()
	other()
	len("x")
	missing()
}
`,
    "internal/api/other.go": `package api

func other() {}
`,
  };

  it("binds pkg.Func() through the import alias to the function in that directory", () => {
    expect(verdicts(tree).get("internal/api/api.go:NewStorage")).toBe(
      "package internal/storage/storage.go::NewStorage",
    );
  });

  it("never binds a call into the standard library or a third-party module", () => {
    const v = verdicts(tree);
    expect(v.get("internal/api/api.go:Println")).toBe("unbound external");
    expect(v.get("internal/api/api.go:Spin")).toBe("unbound external");
  });

  it("binds a bare call to the function of the caller's own package, in any file", () => {
    const v = verdicts(tree);
    expect(v.get("internal/api/api.go:helper")).toBe("same-package internal/api/api.go::helper");
    expect(v.get("internal/api/api.go:other")).toBe("same-package internal/api/other.go::other");
  });

  it("never binds a builtin, or a bare name the package does not declare", () => {
    const v = verdicts(tree);
    expect(v.get("internal/api/api.go:len")).toBe("unbound external");
    expect(v.get("internal/api/api.go:missing")).toBe("unbound external");
  });

  it("never binds a bare call to a function of ANOTHER package, however unique its name", () => {
    const v = verdicts({
      "a/a.go": "package a\n\nfunc OnlyHere() {}\n",
      "b/b.go": "package b\n\nfunc use() { OnlyHere() }\n",
    });
    expect(v.get("b/b.go:OnlyHere")).toBe("unbound external");
  });

  it("never binds a bare call to a method", () => {
    const v = verdicts({
      "p/t.go": `package p

type A struct{}

func (a *A) Close() {}

func use() { Close() }
`,
    });
    expect(v.get("p/t.go:Close")).toBe("unbound external");
  });

  it("uses the package clause, not the directory name, for an unaliased import", () => {
    const v = verdicts({
      "lib/go-thing/thing.go": "package thing\n\nfunc Make() {}\n",
      "cmd/main.go": `package main

import "example.com/app/lib/go-thing"

func main() { thing.Make() }
`,
    });
    expect(v.get("cmd/main.go:Make")).toBe("package lib/go-thing/thing.go::Make");
  });

  it("resolves a dot import's names in the importing file", () => {
    const v = verdicts({
      "util/util.go": "package util\n\nfunc Help() {}\n",
      "cmd/main.go": `package main

import . "example.com/app/util"

func main() { Help() }
`,
    });
    expect(v.get("cmd/main.go:Help")).toBe("package util/util.go::Help");
  });

  it("tells a conversion and a function value from a call", () => {
    const v = verdicts({
      "p/t.go": `package p

type Celsius float64

var hook = func() {}

func use(cb func()) {
	Celsius(1)
	hook()
	cb()
	run := func() {}
	run()
}
`,
    });
    expect(v.get("p/t.go:Celsius")).toBe("unbound conversion");
    expect(v.get("p/t.go:hook")).toBe("unbound func-value");
    expect(v.get("p/t.go:cb")).toBe("unbound func-value");
    expect(v.get("p/t.go:run")).toBe("unbound func-value");
  });

  it("reads a conversion to a type declared inside the function as a conversion", () => {
    const v = verdicts({
      "p/t.go": `package p

func use(o int) {
	type wrapped int
	wrapped(o)
}
`,
    });
    expect(v.get("p/t.go:wrapped")).toBe("unbound conversion");
  });
});

describe("#1071 — what the declarations do not decide stays unresolved", () => {
  it("leaves a call through an interface unresolved, and says it is dispatched", () => {
    const v = verdicts({
      "p/t.go": `package p

type Store interface{ Save() error }
type disk struct{}

func (d *disk) Save() error { return nil }

type svc struct{ store Store }

func (s *svc) run(err error) {
	s.store.Save()
	err.Error()
}
`,
    });
    // `disk::Save` is the only implementation; binding to it would still be a guess.
    expect(v.get("p/t.go:Save")).toBe("unbound interface");
    expect(v.get("p/t.go:Error")).toBe("unbound interface");
  });

  it("never binds a method of a type from outside the tree, or anything reached through one", () => {
    const v = verdicts({
      "p/t.go": `package p

import "net/http"

type T struct{}

func (t *T) Set(k, v string) {}
func (t *T) Header() *T      { return t }

func handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("a", "b")
	r.URL.Query()
}
`,
    });
    // The project declares `Header` and `Set` too; the receiver says they are not these.
    // `http.ResponseWriter` is an interface, so `Header` is dispatched at run time.
    // What it returns, and what the field `r.URL` holds, are types declared outside
    // the tree that nothing here examined: decided, and said to be assumed.
    expect(v.get("p/t.go:Header")).toBe("unbound interface");
    expect(v.get("p/t.go:Set")).toBe("unbound external-assumed");
    expect(v.get("p/t.go:Query")).toBe("unbound external-assumed");
  });

  it("does not claim to know the result of a third-party function (it may be generic)", () => {
    const v = verdicts({
      "p/t.go": `package p

import "slices"

type Entry struct{}

func use(list []*Entry) {
	slices.Clone(list)[0].Touch()
}
`,
    });
    expect(v.get("p/t.go:Clone")).toBe("unbound external");
    expect(v.get("p/t.go:Touch")).toBe("unknown");
  });

  it("does not read a third-party generic type's members as external", () => {
    const v = verdicts({
      "p/t.go": `package p

import "sync/atomic"

type User struct{}

func (u *User) Name() string { return "" }

type cache struct{ current atomic.Pointer[User] }

func (c *cache) name() { c.current.Load().Name() }
`,
    });
    expect(v.get("p/t.go:Load")).toBe("unknown");
    expect(v.get("p/t.go:Name")).toBe("unknown");
  });

  it("refuses build-tagged twins, unless one is the caller's own file", () => {
    const v = verdicts({
      "p/open_unix.go": "package p\n\nfunc open() {}\n\nfunc here() { open() }\n",
      "p/open_windows.go": "package p\n\nfunc open() {}\n",
      "p/use.go": "package p\n\nfunc use() { open() }\n",
    });
    expect(v.get("p/use.go:open")).toBe("unbound ambiguous");
    expect(v.get("p/open_unix.go:open")).toBe("same-package p/open_unix.go::open");
  });

  it("does not let a non-test file reach a declaration in a _test.go file", () => {
    const v = verdicts({
      "p/p.go": "package p\n\nfunc use() { fixture() }\n",
      "p/p_test.go": "package p\n\nfunc fixture() {}\n\nfunc TestUse() { fixture() }\n",
    });
    expect(v.get("p/p.go:fixture")).toBe("unbound external");
    expect(v.get("p/p_test.go:fixture")).toBe("same-package p/p_test.go::fixture");
  });

  it("resolves an external test package's import of the package under test", () => {
    const v = verdicts({
      "p/p.go":
        "package p\n\ntype T struct{}\n\nfunc New() *T { return nil }\nfunc (t *T) Do() {}\n",
      "p/p_test.go": `package p_test

import "example.com/app/p"

func TestDo() {
	t := p.New()
	t.Do()
}
`,
    });
    expect(v.get("p/p_test.go:New")).toBe("package p/p.go::New");
    expect(v.get("p/p_test.go:Do")).toBe("receiver-type p/p.go::T::Do");
  });

  it("returns unknown for a file it was not given", () => {
    const resolver = createGoResolver([], MODULE);
    expect(resolver.resolveCall("nope.go", { e: "name", name: "f" })).toEqual({ kind: "unknown" });
  });
});

describe("#1071 — embedded-struct promotion follows Go's shallowest-depth rule", () => {
  it("binds a method promoted from an embedded struct, and a field promoted from one", () => {
    const v = verdicts({
      "p/t.go": `package p

type Base struct{ log *Logger }
type Logger struct{}

func (b *Base) ID() int      { return 0 }
func (l *Logger) Info()      {}

type Handler struct {
	*Base
	name string
}

func (h *Handler) run() {
	h.ID()
	h.log.Info()
}
`,
    });
    expect(v.get("p/t.go:ID")).toBe("receiver-type p/t.go::Base::ID");
    expect(v.get("p/t.go:Info")).toBe("receiver-type p/t.go::Logger::Info");
  });

  it("prefers the type's own method over a promoted one", () => {
    const v = verdicts({
      "p/t.go": `package p

type Base struct{}

func (b *Base) ID() int { return 0 }

type Handler struct{ Base }

func (h *Handler) ID() int { return 1 }
func (h *Handler) run()    { h.ID() }
`,
    });
    expect(v.get("p/t.go:ID")).toBe("receiver-type p/t.go::Handler::ID");
  });

  it("refuses when two embedded types at one depth both have the method", () => {
    const v = verdicts({
      "p/t.go": `package p

type A struct{}
type B struct{}

func (a *A) ID() int { return 0 }
func (b *B) ID() int { return 0 }

type Both struct {
	A
	B
}

func (x *Both) run() { x.ID() }
`,
    });
    expect(v.get("p/t.go:ID")).toBe("unbound ambiguous");
  });

  it("stops at a depth holding an embedded type from outside the tree, which could declare it", () => {
    const v = verdicts({
      "p/t.go": `package p

import "sync"

type Inner struct{}

func (i *Inner) Lock() {}

type Mid struct{ Inner }

type Outer struct {
	sync.Mutex
	Mid
}

func (o *Outer) run() { o.Lock() }
`,
    });
    // `sync.Mutex.Lock` at depth 1 wins over `Inner.Lock` at depth 2.
    expect(v.get("p/t.go:Lock")).toBe("unknown");
  });

  it("gives a defined type its underlying struct's fields but not its methods", () => {
    const v = verdicts({
      "p/t.go": `package p

type Dep struct{}

func (d *Dep) Ping() {}

type Base struct{ dep *Dep }

func (b *Base) Own() {}

type Derived Base

func (d *Derived) run() {
	d.dep.Ping()
	d.Own()
}
`,
    });
    expect(v.get("p/t.go:Ping")).toBe("receiver-type p/t.go::Dep::Ping");
    expect(v.get("p/t.go:Own")).toBe("unknown");
  });
});

describe("#1071 — go.mod tells a project package from a third-party one of the same name", () => {
  const tree: Tree = {
    "errors/errors.go": "package errors\n\nfunc Wrap() {}\n",
    "cmd/main.go": `package main

import (
	mine "example.com/app/errors"
	theirs "github.com/pkg/errors"
)

func main() {
	mine.Wrap()
	theirs.Wrap()
}
`,
  };

  it("binds only the import under the module path", () => {
    const parsed = Object.entries(tree).map(([f, src]) => parseSource(f, src, "go"));
    const resolver = createGoResolver(
      parsed.map((p) => ({ filePath: p.filePath, facts: p.goFacts!, isTest: false })),
      MODULE,
    );
    const calls = parsed[1].edges
      .filter((e) => e.kind === "calls")
      .map((e) => show(resolver.resolveCall("cmd/main.go", e.goCallee!)));
    expect(calls).toEqual(["package errors/errors.go::Wrap", "unbound external"]);
  });

  it("resolves a module that sits in a subdirectory, and the deepest of nested modules", () => {
    const v = verdicts(
      {
        "svc/internal/db/db.go": "package db\n\nfunc Open() {}\n",
        "svc/main.go": `package main

import "example.com/svc/internal/db"

func main() { db.Open() }
`,
      },
      [
        { dir: "", path: "example.com/root" },
        { dir: "svc", path: "example.com/svc" },
      ],
    );
    expect(v.get("svc/main.go:Open")).toBe("package svc/internal/db/db.go::Open");
  });

  it("falls back to the directory the import path ends in when there is no go.mod — if there is only one", () => {
    const main = `package main

import "example.com/app/internal/storage"

func main() { storage.Long() }
`;
    const one = verdicts(
      { "internal/storage/s.go": "package storage\n\nfunc Long() {}\n", "cmd/main.go": main },
      [],
    );
    expect(one.get("cmd/main.go:Long")).toBe("package internal/storage/s.go::Long");
    // Beside `storage/`, which the path ends in as well, it is one of two
    // readings of the layout and neither is bound (PR #1104 review cycle 4).
    const two = verdicts(
      {
        "storage/s.go": "package storage\n\nfunc Short() {}\n",
        "internal/storage/s.go": "package storage\n\nfunc Long() {}\n",
        "cmd/main.go": main,
      },
      [],
    );
    expect(two.get("cmd/main.go:Long")).toBe("unknown");
  });
});

describe("#1071 — helpers", () => {
  it("reads the module path from a go.mod", () => {
    expect(parseGoModulePath("module miniflux.app/v2\n\ngo 1.24\n")).toBe("miniflux.app/v2");
    expect(parseGoModulePath('// c\nmodule "example.com/q" // trailing\n')).toBe("example.com/q");
    expect(parseGoModulePath("modulex y\ngo 1.24\n")).toBeNull();
    expect(parseGoModulePath("module\n")).toBeNull();
    expect(parseGoModulePath("")).toBeNull();
  });

  it("guesses an unaliased third-party import's name", () => {
    expect(goDefaultImportName("net/http")).toBe("http");
    expect(goDefaultImportName("github.com/go-chi/chi/v5")).toBe("chi");
    expect(goDefaultImportName("gopkg.in/yaml.v3")).toBe("yaml");
    expect(goDefaultImportName("fmt")).toBe("fmt");
    expect(goDefaultImportName("example.com/vault")).toBe("vault");
  });
});

describe("#1071 — more declaration forms", () => {
  it("package-level var blocks, several results, and the blank name", () => {
    const v = verdicts({
      "p/t.go": `package p

type T struct{}

func (t *T) Do() {}
func pair() (*T, *T) { return nil, nil }

var (
	first, second = pair()
	third         = &T{}
	_             = third
)

func use() {
	second.Do()
	third.Do()
}
`,
    });
    // `second.Do()` (a second result) and `third.Do()` (a literal), each asserted.
    expect(v.all("p/t.go:Do")).toEqual([
      "receiver-type p/t.go::T::Do",
      "receiver-type p/t.go::T::Do",
    ]);
    expect(v.values().filter((x) => x === "unknown")).toEqual([]);
  });

  it("a type switch with an initialiser keeps the operand's type in a multi-type or default case", () => {
    const parsed = parseSource(
      "p/t.go",
      `package p

type A struct{}
type B struct{}
type S interface{ Do() }

func (a *A) Do() {}
func (b *B) Do() {}
func get() S { return nil }

func use() {
	switch s := get(); t := s.(type) {
	case *A:
		t.Do()
	case *B, nil:
		t.Do()
	default:
		t.Do()
	}
}
`,
      "go",
    );
    const resolver = createGoResolver(
      [{ filePath: "p/t.go", facts: parsed.goFacts!, isTest: false }],
      MODULE,
    );
    const calls = parsed.edges
      .filter((e) => e.kind === "calls" && e.toQualifiedName === "Do")
      .map((e) => `${e.line} ${show(resolver.resolveCall("p/t.go", e.goCallee!))}`);
    expect(calls).toEqual([
      "14 receiver-type p/t.go::A::Do",
      "16 unbound interface",
      "18 unbound interface",
    ]);
  });

  it("a closure's named results, a parenthesised conversion and a shadowed package alias", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "cmd/main.go": `package main

import "example.com/app/internal/storage"

type local struct{}

func (l *local) Mine() {}

func main() {
	f := func() (out *local, err error) {
		out.Mine()
		return
	}
	_ = f
	(*local)(nil).Mine()
}

func shadow(storage int) {
	var s storage.Storage
	s.Close()
	s.SetEntriesStatus(nil)
}
`,
    });
    // Read as the package's type, this would be `Storage::SetEntriesStatus`.
    expect(v.get("cmd/main.go:SetEntriesStatus")).toBe("unknown");
    // Line 11: the closure's named result. Line 15: the parenthesised conversion.
    expect(v.all("cmd/main.go:Mine")).toEqual([
      "receiver-type cmd/main.go::local::Mine",
      "unknown",
    ]);
    // `storage` is the int parameter here, so `storage.Storage` names no type.
    expect(v.get("cmd/main.go:Close")).toBe("unknown");
  });
});

describe("#1071 — bounded work on hostile source", () => {
  it("never throws on source cut off anywhere, and still returns facts", () => {
    const src = `package p

import (
	st "example.com/app/storage"
)

type H struct {
	store *st.Storage
	*Base
	m map[string][]chan func(int) (*H, error)
}

type I interface{ Do() error }
type L[T any] struct{ items []T }

var g, h = make(map[string]*H), new(H)

const (
	A Kind = iota
	B
)

func (l *L[T]) Add(v T) (out *L[T], err error) {
	for i, x := range l.items {
		switch t := any(x).(type) {
		case *H, I:
			t.Do()
		}
		select {
		case v := <-ch:
			v.store.Save(i)
		}
	}
	x, ok := g["a"].(*H)
	defer func(a *H) { a.store.Close() }(x)
	return l, nil
}
`;
    for (let cut = 0; cut <= src.length; cut += 3) {
      const parsed = parseSource("p/t.go", src.slice(0, cut), "go");
      if (parsed.unparseable) continue;
      expect(parsed.goFacts, `cut at ${cut}`).toBeDefined();
      // Every call the walker emitted must be decidable without throwing.
      const resolver = createGoResolver(
        [{ filePath: "p/t.go", facts: parsed.goFacts!, isTest: false }],
        MODULE,
      );
      for (const e of parsed.edges) {
        if (e.kind === "calls") resolver.resolveCall("p/t.go", e.goCallee!);
      }
    }
  });

  it("gives up on a callee chain longer than the cap instead of recursing through it", () => {
    let expr: GoExpr = { e: "name", name: "x" };
    for (let i = 0; i < 5_000; i += 1) expr = { e: "sel", x: expr, name: "f" };
    const parsed = parseSource("p/t.go", "package p\n", "go");
    const resolver = createGoResolver(
      [{ filePath: "p/t.go", facts: parsed.goFacts!, isTest: false }],
      MODULE,
    );
    expect(resolver.resolveCall("p/t.go", expr)).toEqual({ kind: "unknown" });
  });

  it("caps a substituted chain in the walker", () => {
    const chain = Array.from({ length: 200 }, () => ".Next()").join("");
    const parsed = parseSource(
      "p/t.go",
      `package p\n\ntype N struct{}\n\nfunc (n *N) Next() *N { return n }\n\nfunc use(n *N) { n${chain} }\n`,
      "go",
    );
    const depth = (expr: GoExpr): number => {
      if (expr.e === "sel" || expr.e === "elem" || expr.e === "key") return 1 + depth(expr.x);
      return expr.e === "call" ? 1 + depth(expr.fn) : 1;
    };
    const calls = parsed.edges.filter((e) => e.kind === "calls");
    expect(calls).toHaveLength(200);
    // No callee carries the whole chain below it, however long the chain is:
    // none is longer than the cap (64 links), the callee's own selection included.
    expect(Math.max(...calls.map((e) => depth(e.goCallee!)))).toBeLessThanOrEqual(64);
    expect(Math.max(...calls.map((e) => depth(e.goCallee!)))).toBeGreaterThan(60);

    // Index and range links count towards the cap like selections and calls.
    const indexed = parseSource(
      "p/t.go",
      `package p\n\ntype L []L\n\nfunc (l L) Next() {}\n\nfunc use(x L) {\n\ty := x${"[0]".repeat(200)}\n\ty.Next()\n\tx${"[0]".repeat(40)}.Next()\n}\n`,
      "go",
    );
    const indexedCalls = indexed.edges.filter((e) => e.kind === "calls");
    expect(indexedCalls.map((e) => depth(e.goCallee!))).toEqual([2, 42]);

    // A callee whose operand is exactly at the cap is one link over it.
    const fields = (links: number) =>
      parseSource(
        "p/t.go",
        `package p\n\ntype N struct{ a *N }\n\nfunc (n *N) M() {}\n\nfunc use(n *N) {\n\tn${".a".repeat(links)}.M()\n}\n`,
        "go",
      ).edges.filter((e) => e.kind === "calls")[0].goCallee!;
    expect(depth(fields(62))).toBe(64);
    expect(depth(fields(63))).toBeLessThanOrEqual(64);
    expect(fields(63)).toEqual({ e: "unknown" });
    const resolver = createGoResolver(
      [{ filePath: "p/t.go", facts: parsed.goFacts!, isTest: false }],
      MODULE,
    );
    // Edges come outermost first: the innermost call still binds, the outermost
    // is past the cap and is left undecided rather than guessed.
    expect(show(resolver.resolveCall("p/t.go", calls.at(-1)!.goCallee!))).toBe(
      "receiver-type p/t.go::N::Next",
    );
    expect(show(resolver.resolveCall("p/t.go", calls.at(0)!.goCallee!))).toBe("unknown");
  });

  it("evaluates each link of a fluent chain once, sharing it with the calls above", () => {
    // Without sharing, every call of an N-call chain re-walks the chain below it:
    // N² steps, and N² memory, for one statement.
    const parsed = parseSource(
      "p/t.go",
      "package p\n\ntype N struct{}\n\nfunc (n *N) A() *N { return n }\n\nfunc use(n *N) { n.A().A().A() }\n",
      "go",
    );
    type Sel = Extract<GoExpr, { e: "sel" }>;
    type Call = Extract<GoExpr, { e: "call" }>;
    const [outer, middle, inner] = parsed.edges
      .filter((e) => e.kind === "calls")
      .map((e) => e.goCallee as Sel);
    // outer = sel(call(middle)), middle = sel(call(inner)): the same objects, not copies.
    expect(((outer.x as Call).fn as Sel).x).toBe(middle.x);
    expect(((middle.x as Call).fn as Sel).x).toBe(inner.x);
    expect(inner.x).toEqual({ e: "typed", type: { k: "named", name: "N" } });
  });

  it("survives a cycle of aliases, embeddings and defined types", () => {
    const v = verdicts({
      "p/t.go": `package p

type A = B
type B = A
type C struct{ D }
type D struct{ C }
type E F
type F E

func use(a A, c C, e E) {
	a.X()
	c.Y()
	e.z.Z()
}
`,
    });
    expect(v.get("p/t.go:X")).toBe("unknown");
    expect(v.get("p/t.go:Y")).toBe("unknown");
    expect(v.get("p/t.go:Z")).toBe("unknown");
  });

  it("walks a long run of rebinding declarations in linear time", () => {
    expectLinearTime(
      "walkGo over chained := declarations",
      (size) => {
        const n = Math.floor(size / 20);
        const body = Array.from({ length: n }, (_, i) => `\tv${i + 1} := v${i}.f\n`).join("");
        const src = `package p\n\nfunc use(v0 T) {\n${body}}\n`;
        return () => parseSource("p/t.go", src, "go");
      },
      100_000,
    );
  });

  it("reads a large go.mod in linear time", () => {
    expectLinearTime("parseGoModulePath", (size) => {
      const src = `${"module".repeat(size / 6)}\n`;
      return () => parseGoModulePath(src);
    });
  });
});
