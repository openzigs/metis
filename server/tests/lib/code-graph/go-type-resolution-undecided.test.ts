/**
 * #1071 (review of PR #1104) — what the Go resolver must leave UNDECIDED, and
 * what it must never bind.
 *
 * A verdict of `external` is decided: ingest binds nothing for it and every
 * later reader of unresolved calls skips it. So it may be issued only on
 * positive evidence; "could not determine" has to stay `unknown`, or the
 * name-based fallback never gets to try. The first half of this file pins that
 * boundary. The second half pins the rules that refuse to bind — twins,
 * variables, cycles, re-declarations — each with the call that a careless
 * implementation WOULD bind, so that a rule which binds instead goes red.
 *
 * Every case runs real Go source through the tree-sitter walker.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  type GoModule,
  type GoResolverOptions,
} from "../../../src/lib/code-graph/go-type-resolution.js";
import { GO_STDLIB_PACKAGES, isGoStdlibInterface } from "../../../src/lib/code-graph/go-stdlib.js";
import { initCodeGraphParsers } from "../../../src/lib/code-graph/parsers.js";
import { goVerdicts } from "../../helpers/go-verdicts.js";

type Tree = Record<string, string>;

const MODULE: GoModule[] = [{ dir: "", path: "example.com/app" }];

/** Every call of the tree, uniquely keyed: see `tests/helpers/go-verdicts.ts`. */
const verdicts = (tree: Tree, modules: GoModule[] = MODULE, options?: GoResolverOptions) =>
  goVerdicts(tree, modules, options);

const STORAGE = `package storage

type Storage struct{}

func NewStorage() *Storage { return &Storage{} }

func (s *Storage) SetEntriesStatus(ids []int64) error { return nil }
`;

const HANDLER = `package api

import "example.com/app/internal/storage"

type handler struct{ store *storage.Storage }

func (h *handler) update(ids []int64) {
	storage.NewStorage()
	h.store.SetEntriesStatus(ids)
}
`;

const NEW = "package internal/storage/storage.go::NewStorage";
const SET = "receiver-type internal/storage/storage.go::Storage::SetEntriesStatus";

beforeAll(async () => {
  await initCodeGraphParsers();
});

describe("a directory with a second package clause still resolves to its package", () => {
  const callsInto = (extra: Tree) => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "internal/api/handler.go": HANDLER,
      ...extra,
    });
    return [
      v.get("internal/api/handler.go:NewStorage"),
      v.get("internal/api/handler.go:SetEntriesStatus"),
    ];
  };

  it("control: with one package clause both calls bind", () => {
    expect(callsInto({})).toEqual([NEW, SET]);
  });

  it("binds past a `//go:build ignore` generator (`package main`) beside the library", () => {
    expect(
      callsInto({
        "internal/storage/gen.go":
          "//go:build ignore\n\npackage main\n\nfunc main() { emit() }\n\nfunc emit() {}\n",
      }),
    ).toEqual([NEW, SET]);
  });

  it("binds past the old `// +build ignore` spelling, and past a licence header above it", () => {
    expect(
      callsInto({
        "internal/storage/gen.go":
          "// Copyright the authors.\n\n// +build ignore\n\npackage main\n\nfunc main() {}\n",
      }),
    ).toEqual([NEW, SET]);
  });

  it("binds past a `package main` file with no constraint at all: main is never what an import means", () => {
    expect(callsInto({ "internal/storage/tool.go": "package main\n\nfunc main() {}\n" })).toEqual([
      NEW,
      SET,
    ]);
  });

  it("binds past an ignored file that claims another LIBRARY package name", () => {
    expect(
      callsInto({
        "internal/storage/doc_gen.go": "//go:build ignore\n\npackage docgen\n\nfunc Emit() {}\n",
      }),
    ).toEqual([NEW, SET]);
  });

  it("binds past the same file under the old `// +build ignore` spelling", () => {
    expect(
      callsInto({
        "internal/storage/doc_gen.go": "// +build ignore\n\npackage docgen\n\nfunc Emit() {}\n",
      }),
    ).toEqual([NEW, SET]);
  });

  it("leaves two library packages in one directory UNDECIDED — never external", () => {
    // No constraint tells them apart, so which one the import means is unknown.
    expect(
      callsInto({ "internal/storage/other.go": "package other\n\nfunc NewStorage() {}\n" }),
    ).toEqual(["unknown", "unknown"]);
  });

  it("does not read `// +build ignore linux` as ignored: terms on one line are alternatives", () => {
    // The file builds on linux, so the directory really does hold two packages.
    expect(
      callsInto({
        "internal/storage/other.go": "// +build ignore linux\n\npackage other\n\nfunc X() {}\n",
      }),
    ).toEqual(["unknown", "unknown"]);
  });

  it("does not read a build comment BELOW the package clause as a constraint", () => {
    expect(
      callsInto({
        "internal/storage/other.go": "package other\n\n//go:build ignore\n\nfunc X() {}\n",
      }),
    ).toEqual(["unknown", "unknown"]);
  });

  it("keeps an ignored file's declarations out of the directory's package", () => {
    const v = verdicts({
      "p/p.go": "package p\n\nfunc use() { emit() }\n",
      "p/gen.go": "//go:build ignore\n\npackage p\n\nfunc emit() {}\n\nfunc main() { emit() }\n",
    });
    // The go tool never compiles gen.go into p, so p has no `emit`.
    expect(v.get("p/p.go:emit")).toBe("unbound external");
    // The file is its own single-file package: its own calls still resolve.
    expect(v.get("p/gen.go:emit")).toBe("same-package p/gen.go::emit");
  });

  it("does not let an ignored file's twin make the package's own function ambiguous", () => {
    const v = verdicts({
      "p/p.go": "package p\n\nfunc open() {}\n\nfunc use() { open() }\n",
      "p/gen.go": "//go:build ignore\n\npackage p\n\nfunc open() {}\n",
    });
    expect(v.get("p/p.go:open")).toBe("same-package p/p.go::open");
  });
});

describe("`external` is recorded only on positive evidence", () => {
  it("an import inside the project module whose directory holds no parsed file is unknown", () => {
    const v = verdicts({
      "cmd/main.go": `package main

import "example.com/app/internal/generated"

func main() { generated.Run() }
`,
    });
    expect(v.get("cmd/main.go:Run")).toBe("unknown");
  });

  it("an import outside every module of the tree is external", () => {
    const v = verdicts({
      "cmd/main.go": `package main

import "github.com/acme/widget"

func main() { widget.Spin() }
`,
    });
    expect(v.get("cmd/main.go:Spin")).toBe("unbound external");
  });

  it("a name a fully read project package does not declare is external", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "cmd/main.go": `package main

import "example.com/app/internal/storage"

func main() {
	storage.Missing()
	missing()
}
`,
    });
    expect(v.get("cmd/main.go:Missing")).toBe("unbound external");
    expect(v.get("cmd/main.go:missing")).toBe("unbound external");
  });

  it("the same names are UNDECIDED when a file of that directory could not be parsed", () => {
    const tree: Tree = {
      "internal/storage/storage.go": STORAGE,
      "cmd/main.go": `package main

import "example.com/app/internal/storage"

func main() {
	storage.Missing()
	missing()
	storage.NewStorage()
}
`,
    };
    // internal/storage/broken.go and cmd/broken.go exist in the tree, unparsed.
    const v = verdicts(tree, MODULE, {
      incompleteDirs: new Set(["internal/storage", "cmd"]),
    });
    expect(v.get("cmd/main.go:Missing")).toBe("unknown");
    expect(v.get("cmd/main.go:missing")).toBe("unknown");
    // What the parsed files do declare still binds.
    expect(v.get("cmd/main.go:NewStorage")).toBe(NEW);
  });

  it("an incomplete directory elsewhere does not weaken a complete one", () => {
    const v = verdicts(
      {
        "internal/storage/storage.go": STORAGE,
        "cmd/main.go": `package main

import "example.com/app/internal/storage"

func main() {
	storage.Missing()
	missing()
}
`,
      },
      MODULE,
      { incompleteDirs: new Set(["somewhere/else"]) },
    );
    expect(v.get("cmd/main.go:Missing")).toBe("unbound external");
    expect(v.get("cmd/main.go:missing")).toBe("unbound external");
  });

  it("a builtin is external even in an incomplete package", () => {
    const v = verdicts({ "p/p.go": 'package p\n\nfunc use() { len("x") }\n' }, MODULE, {
      incompleteDirs: new Set(["p"]),
    });
    expect(v.get("p/p.go:len")).toBe("unbound external");
  });

  it("a bare name is undecided when a dot import could have brought it in", () => {
    const v = verdicts({
      "p/p.go": `package p

import . "github.com/acme/dsl"

func use() { Describe() }
`,
    });
    expect(v.get("p/p.go:Describe")).toBe("unknown");
  });

  it("an external import whose guessed name collides with a project import decides nothing", () => {
    // `github.com/acme/storage` is really `package acmestore`; its default name
    // can only be guessed from the path, and the guess collides.
    const colliding = (first: string, second: string) =>
      verdicts({
        "internal/storage/storage.go": STORAGE,
        "cmd/main.go": `package main

import (
	"${first}"
	"${second}"
)

func main() { storage.NewStorage() }
`,
      }).get("cmd/main.go:NewStorage");
    expect(colliding("github.com/acme/storage", "example.com/app/internal/storage")).toBe(
      "unknown",
    );
    expect(colliding("example.com/app/internal/storage", "github.com/acme/storage")).toBe(
      "unknown",
    );
  });

  it("two external imports of one guessed name are still external", () => {
    const v = verdicts({
      "cmd/main.go": `package main

import (
	"github.com/acme/yaml"
	"gopkg.in/yaml.v3"
)

func main() { yaml.Marshal(nil) }
`,
    });
    expect(v.get("cmd/main.go:Marshal")).toBe("unbound external");
  });

  it("an explicit alias avoids the collision", () => {
    const v = verdicts({
      "internal/storage/storage.go": STORAGE,
      "cmd/main.go": `package main

import (
	acme "github.com/acme/storage"
	"example.com/app/internal/storage"
)

func main() {
	storage.NewStorage()
	acme.Open()
}
`,
    });
    expect(v.get("cmd/main.go:NewStorage")).toBe(NEW);
    expect(v.get("cmd/main.go:Open")).toBe("unbound external");
  });
});

describe("a tree with no go.mod: an import path is matched by spelling, and only when unambiguous", () => {
  const STDLIB_TWINS: Tree = {
    "errors/errors.go": "package errors\n\nfunc New(s string) error { return nil }\n",
    "http/http.go":
      "package http\n\ntype Client struct{}\n\nfunc (c *Client) Do(r any) {}\n\nfunc Get(u string) {}\n",
    "cmd/main.go": `package main

import (
	"errors"
	"net/http"
)

func main() {
	errors.New("x")
	http.Get("u")
	c := &http.Client{}
	c.Do(nil)
}
`,
  };

  it("never binds a standard-library import to a project directory of the same name", () => {
    const v = verdicts(STDLIB_TWINS, []);
    expect(v.get("cmd/main.go:New")).toBe("unbound external");
    expect(v.get("cmd/main.go:Get")).toBe("unbound external");
    expect(v.get("cmd/main.go:Do")).toBe("unbound external");
  });

  it("the standard library is external under a go.mod too", () => {
    const v = verdicts(STDLIB_TWINS);
    expect(v.get("cmd/main.go:New")).toBe("unbound external");
    expect(v.get("cmd/main.go:Do")).toBe("unbound external");
  });

  const importing = (importPath: string, tree: Tree) =>
    verdicts(
      {
        ...tree,
        "cmd/main.go": `package main\n\nimport "${importPath}"\n\nfunc main() { store.Open() }\n`,
      },
      [],
    ).get("cmd/main.go:Open");
  const STORE = "package store\n\nfunc Open() {}\n";

  it("one trailing segment is not evidence: the project's `store/` or someone else's", () => {
    expect(importing("github.com/acme/app/store", { "store/store.go": STORE })).toBe("unknown");
  });

  it("two trailing segments are no better, nor three: a proper tail of the path is a guess", () => {
    expect(
      importing("github.com/acme/app/internal/store", { "internal/store/store.go": STORE }),
    ).toBe("unknown");
    expect(
      importing("github.com/acme/app/internal/store", { "app/internal/store/store.go": STORE }),
    ).toBe("unknown");
  });

  // PR #1104, review cycle 5. Two segments were taken for evidence, and this
  // bound to the project's `pkg/errors/e.go::Wrap`. In Go it is the
  // dependency's function (the oracle corpus holds the same tree, where the
  // type checker says so: `legacy-package-root`, `cmd/app/wrap.go`).
  it("the project's `pkg/errors/` is not `github.com/pkg/errors`", () => {
    const v = verdicts(
      {
        "pkg/errors/e.go": "package errors\n\nfunc Wrap() {}\n",
        "cmd/main.go": `package main\n\nimport "github.com/pkg/errors"\n\nfunc main() { errors.Wrap() }\n`,
      },
      [],
    );
    expect(v.get("cmd/main.go:Wrap")).toBe("unknown");
  });

  // PR #1104, review cycle 6. A ONE-segment import path is its own tail: any
  // directory of that name "ends in the whole path". `internal/appengine/`
  // was bound for the dependency `appengine` (the oracle corpus holds the
  // tree: `legacy-package-root`, `cmd/app/gae.go`, where the type checker
  // says external).
  it.each([
    ["internal/appengine", "unknown"],
    ["lib/appengine", "unknown"],
    ["a/srcs/appengine", "unknown"],
    // Where a one-segment import path can live: the tree root (a GOPATH `src`)…
    ["appengine", "package appengine/store.go::Open"],
    // …or directly under a `src` or a `vendor` directory.
    ["src/appengine", "package src/appengine/store.go::Open"],
    ["go/src/appengine", "package go/src/appengine/store.go::Open"],
    ["vendor/appengine", "package vendor/appengine/store.go::Open"],
    ["third_party/vendor/appengine", "package third_party/vendor/appengine/store.go::Open"],
  ])("a one-segment import: the lone directory `%s` is %s", (dir, verdict) => {
    expect(
      importing("appengine", {
        // (The package clause says `store`, which is the name the importer uses.)
        [`${dir}/store.go`]: STORE,
      }),
    ).toBe(verdict);
  });

  it("binds when the tree root is the GOPATH's `src`: the directory IS the whole import path", () => {
    expect(
      importing("github.com/acme/app/store", { "github.com/acme/app/store/store.go": STORE }),
    ).toBe("package github.com/acme/app/store/store.go::Open");
  });

  it("binds a GOPATH layout, where the directory ends in the whole import path", () => {
    expect(
      importing("github.com/acme/app/store", {
        "src/github.com/acme/app/store/store.go": STORE,
      }),
    ).toBe("package src/github.com/acme/app/store/store.go::Open");
  });

  it("is undecided when two directories end in the whole import path", () => {
    expect(
      importing("acme/store", {
        "a/acme/store/store.go": STORE,
        "b/acme/store/store.go": STORE,
      }),
    ).toBe("unknown");
  });

  it("is undecided when the path both ends in one directory and is the end of another", () => {
    expect(
      importing("acme/app/internal/store", {
        "internal/store/store.go": STORE,
        "vendor/acme/app/internal/store/store.go": STORE,
      }),
    ).toBe("unknown");
  });

  it("with no directory matching, the path is outside the tree", () => {
    expect(importing("github.com/acme/app/store", { "other/o.go": "package other\n" })).toBe(
      "unbound external",
    );
  });

  it("unless Go code sits at the tree root, whose import path is the unknown module path", () => {
    expect(importing("github.com/acme/store", { "store.go": STORE })).toBe("unknown");
    // A `package main` at the root is never imported, so it does not open the question.
    expect(
      importing("github.com/acme/store", { "tool.go": "package main\n\nfunc main() {}\n" }),
    ).toBe("unbound external");
  });

  it("applies the same rule to Go code outside every go.mod of a tree that has some", () => {
    const v = verdicts(
      {
        "svc/main.go": `package main

import (
	"example.com/tools/pkg/util"
	"example.com/tools/log"
	"github.com/acme/widget"
)

func main() {
	util.Help()
	log.Print()
	widget.Spin()
}
`,
        // No go.mod covers tools/: these are matched by spelling.
        "tools/pkg/util/util.go": "package util\n\nfunc Help() {}\n",
        "tools/log/log.go": "package log\n\nfunc Print() {}\n",
      },
      [{ dir: "svc", path: "example.com/svc" }],
    );
    // Each directory is only a tail of its import path: undecided, however
    // many segments match.
    expect(v.get("svc/main.go:Help")).toBe("unknown");
    expect(v.get("svc/main.go:Print")).toBe("unknown");
    expect(v.get("svc/main.go:Spin")).toBe("unbound external");
  });

  it("a tree whose every Go directory is under a module never matches by spelling", () => {
    const v = verdicts({
      "internal/store/store.go": STORE,
      "cmd/main.go": `package main\n\nimport "github.com/other/internal/store"\n\nfunc main() { store.Open() }\n`,
    });
    expect(v.get("cmd/main.go:Open")).toBe("unbound external");
  });
});

describe("a call through an interface declared outside the tree", () => {
  const tree: Tree = {
    "p/p.go": `package p

import (
	"io"
	"net/http"

	"github.com/acme/queue"
)

type wrap struct {
	next http.Handler
	out  io.Writer
	q    queue.Consumer
	c    *http.Client
}

func (h *wrap) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.next.ServeHTTP(w, r)
	h.out.Write(nil)
	w.WriteHeader(200)
	w.Header().Set("a", "b")
	h.q.Consume()
	h.c.Do(r)
}

func (h *wrap) Write(p []byte) (int, error) { return 0, nil }
func (h *wrap) WriteHeader(code int)        {}
func (h *wrap) Consume()                    {}
func (h *wrap) Do(r *http.Request)          {}
func (h *wrap) Set(k, v string)             {}
`,
  };

  it("is `interface` for a standard-library interface: a project type may implement it", () => {
    const v = verdicts(tree);
    expect(v.get("p/p.go:ServeHTTP")).toBe("unbound interface");
    expect(v.get("p/p.go:Write")).toBe("unbound interface");
    expect(v.get("p/p.go:WriteHeader")).toBe("unbound interface");
  });

  it("is `external` for a method of a standard-library type that is not an interface: proven", () => {
    // `*http.Client` is named in the source and is not an interface, so `Do` is its own.
    expect(verdicts(tree).get("p/p.go:Do")).toBe("unbound external");
  });

  it("is `external-assumed` for what an interface method returns: its type was not examined", () => {
    // `w.Header()` returns `http.Header`. The standard library cannot name a
    // project type, so the call is decided — but which type it is, nothing read.
    expect(verdicts(tree).get("p/p.go:Set")).toBe("unbound external-assumed");
  });

  it("is `external-assumed` for a third-party type, which cannot be told from an interface", () => {
    expect(verdicts(tree).get("p/p.go:Consume")).toBe("unbound external-assumed");
  });

  describe("a standard-library interface reached through a standard-library member", () => {
    // Every method called below is ALSO declared on a project type, which is
    // what a decided `external` would wrongly rule out.
    const v = () =>
      verdicts({
        "p/p.go": `package p

import (
	"database/sql"
	"io"
	"net/http"
)

type impl struct{}

func (i *impl) Close() error                                    { return nil }
func (i *impl) ServeHTTP(w http.ResponseWriter, r *http.Request) {}
func (i *impl) Done() <-chan struct{}                            { return nil }
func (i *impl) Write(p []byte) (int, error)                      { return 0, nil }
func (i *impl) RoundTrip(r *http.Request) (*http.Response, error) { return nil, nil }
func (i *impl) Query(q string)                                   {}
func (i *impl) Get(k string) string                              { return "" }
func (i *impl) Do(r *http.Request)                               {}
func (i *impl) Len() int                                         { return 0 }

func use(resp *http.Response, srv *http.Server, r *http.Request, db *sql.DB, c http.Client) {
	resp.Body.Close()
	srv.Handler.ServeHTTP(nil, r)
	r.Context().Done()
	io.Discard.Write(nil)
	c.Transport.RoundTrip(r)
	db.Query("select 1")
	r.Header.Get("a")
	http.DefaultClient.Do(r)
	r.Context().Done().Len()
}
`,
      });

    it("a FIELD typed as an interface: `resp.Body.Close()`, `srv.Handler.ServeHTTP()`", () => {
      expect(v().get("p/p.go:Close")).toBe("unbound interface");
      expect(v().get("p/p.go:ServeHTTP")).toBe("unbound interface");
      expect(v().get("p/p.go:RoundTrip")).toBe("unbound interface");
    });

    it("a METHOD that returns an interface: `r.Context().Done()`", () => {
      expect(v().all("p/p.go:Done")).toEqual(["unbound interface", "unbound interface"]);
    });

    it("a package VARIABLE typed as an interface: `io.Discard.Write()`", () => {
      expect(v().get("p/p.go:Write")).toBe("unbound interface");
    });

    it("the method that returns the interface is itself a concrete method: external", () => {
      expect(v().all("p/p.go:Context")).toEqual(["unbound external", "unbound external"]);
      expect(v().get("p/p.go:Query")).toBe("unbound external");
    });

    it("a member whose type is not a listed interface is unexamined: external-assumed", () => {
      // `r.Header` is `http.Header`; `http.DefaultClient` is a `*http.Client`.
      expect(v().get("p/p.go:Get")).toBe("unbound external-assumed");
      expect(v().get("p/p.go:Do")).toBe("unbound external-assumed");
      // What an interface method returns (`<-chan struct{}`) is unexamined too.
      expect(v().get("p/p.go:Len")).toBe("unbound external-assumed");
    });
  });

  it("does not read what a PROJECT interface's method returns as external", () => {
    const v = verdicts({
      "p/p.go": `package p

type T struct{}

func (t *T) Run() {}

type Maker interface{ Make() *T }

func use(m Maker) { m.Make().Run() }
`,
    });
    expect(v.get("p/p.go:Make")).toBe("unbound interface");
    expect(v.get("p/p.go:Run")).toBe("unknown");
  });

  it("lists interfaces by import path, not by the name a file gives the import", () => {
    expect(isGoStdlibInterface("net/http", "Handler")).toBe(true);
    expect(isGoStdlibInterface("net/http", "Client")).toBe(false);
    expect(isGoStdlibInterface("github.com/acme/http", "Handler")).toBe(false);
    expect(GO_STDLIB_PACKAGES.has("net/http")).toBe(true);
    expect(GO_STDLIB_PACKAGES.has("github.com/pkg/errors")).toBe(false);
    const v = verdicts({
      "p/p.go": `package p

import web "net/http"

func (t *T) ServeHTTP() {}

type T struct{}

func use(h web.Handler) { h.ServeHTTP(nil, nil) }
`,
    });
    expect(v.get("p/p.go:ServeHTTP")).toBe("unbound interface");
  });
});

describe("rules that refuse to bind", () => {
  it("method twins behind build tags are ambiguous: the first is not bound", () => {
    const v = verdicts({
      "net/conn.go": "package net\n\ntype Conn struct{}\n\nfunc use(c *Conn) { c.Flush() }\n",
      "net/conn_linux.go": "package net\n\nfunc (c *Conn) Flush() {}\n",
      "net/conn_windows.go": "package net\n\nfunc (c *Conn) Flush() {}\n",
    });
    expect(v.get("net/conn.go:Flush")).toBe("unbound ambiguous");
  });

  it("method twins are ambiguous from inside one of the twin files too", () => {
    // Unlike a function, a method call does not prefer the caller's own file:
    // the receiver's type is one type, and both files claim its method.
    const v = verdicts({
      "net/conn.go": "package net\n\ntype Conn struct{}\n",
      "net/conn_linux.go":
        "package net\n\nfunc (c *Conn) Flush() {}\n\nfunc here(c *Conn) { c.Flush() }\n",
      "net/conn_windows.go": "package net\n\nfunc (c *Conn) Flush() {}\n",
    });
    expect(v.get("net/conn_linux.go:Flush")).toBe("unbound ambiguous");
  });

  it("twin package variables decide nothing: neither twin's type is used", () => {
    const v = verdicts({
      "p/types.go":
        "package p\n\ntype A struct{}\ntype B struct{}\n\nfunc (a *A) Run() {}\nfunc (b *B) Run() {}\n\nfunc use() { std.Run() }\n",
      "p/std_linux.go": "package p\n\nvar std = &A{}\n",
      "p/std_windows.go": "package p\n\nvar std = &B{}\n",
    });
    expect(v.get("p/types.go:Run")).toBe("unknown");
  });

  it("twin package variables with a written type decide nothing either", () => {
    const v = verdicts({
      "p/types.go":
        "package p\n\ntype A struct{}\ntype B struct{}\n\nfunc (a *A) Run() {}\nfunc (b *B) Run() {}\n\nfunc use() { std.Run() }\n",
      "p/std_linux.go": "package p\n\nvar std *A\n",
      "p/std_windows.go": "package p\n\nvar std *B\n",
    });
    expect(v.get("p/types.go:Run")).toBe("unknown");
  });

  it("a bare call to a package variable is a call through a function value, whatever its type", () => {
    const v = verdicts({
      "p/a.go":
        "package p\n\nfunc pick() func() { return nil }\n\nvar hook = pick()\n\nfunc use() { hook() }\n",
      "p/twin_linux.go": "package p\n\nvar start = pick()\n",
      "p/twin_windows.go": "package p\n\nvar start = pick()\n\nfunc boot() { start() }\n",
    });
    expect(v.get("p/a.go:hook")).toBe("unbound func-value");
    expect(v.get("p/twin_windows.go:start")).toBe("unbound func-value");
  });

  it("twin type declarations decide nothing", () => {
    const v = verdicts({
      "p/t_linux.go": "package p\n\ntype T struct{}\n\nfunc (t *T) Run() {}\n",
      "p/t_windows.go": "package p\n\ntype T struct{}\n",
      "p/use.go": "package p\n\nfunc use(t *T) { t.Run() }\n",
    });
    expect(v.get("p/use.go:Run")).toBe("unknown");
  });

  it("a call through a struct field or a variable holding a function is a function value", () => {
    const v = verdicts({
      "p/p.go": `package p

type T struct{ run func() }

func run() {}

var later func()

func use(t *T) {
	t.run()
	later()
}
`,
    });
    expect(v.get("p/p.go:run")).toBe("unbound func-value");
    expect(v.get("p/p.go:later")).toBe("unbound func-value");
  });

  it("a local holding a function is never the package function of the same name", () => {
    const v = verdicts({
      "p/p.go": `package p

func handler() {}

func pick() func() { return nil }

func use() {
	handler := pick()
	handler()
}
`,
    });
    expect(v.get("p/p.go:9:handler")).toBe("unbound func-value");
  });

  it("a conversion to a package type or a local type is not a call to a function", () => {
    const v = verdicts({
      "p/p.go": `package p

type ID int

func use(n int) {
	ID(n)
	type local int
	local(n)
}
`,
    });
    expect(v.get("p/p.go:ID")).toBe("unbound conversion");
    expect(v.get("p/p.go:local")).toBe("unbound conversion");
  });

  it("an interface with one implementation is still dispatched at run time", () => {
    const v = verdicts({
      "p/p.go": `package p

type Store interface{ Get() }

type disk struct{}

func (d *disk) Get() {}

func use(s Store) { s.Get() }
`,
    });
    expect(v.get("p/p.go:Get")).toBe("unbound interface");
  });

  it("an interface embedded in a struct dispatches too, and hides nothing it does not declare", () => {
    const v = verdicts({
      "p/p.go": `package p

type Store interface{ Get() }

type cached struct{ Store }

type disk struct{}

func (d *disk) Get() {}

func use(c *cached) { c.Get() }
`,
    });
    expect(v.get("p/p.go:Get")).toBe("unbound interface");
  });
});

describe("package variables are followed with one depth counter", () => {
  it("a cycle of package variables ends as unknown instead of overflowing the stack", () => {
    const v = verdicts({
      "p/p.go": `package p

type T struct{}

func (t *T) Foo() {}
func (t *T) Bar() {}

var a = b
var b = a
var c = c.x

func f() {
	a.Foo()
	c.Bar()
}
`,
    });
    expect(v.get("p/p.go:Foo")).toBe("unknown");
    expect(v.get("p/p.go:Bar")).toBe("unknown");
  });

  it("a cycle across two files and through a function result ends the same way", () => {
    const v = verdicts({
      "p/a.go": "package p\n\nvar a = next(b)\n\nfunc next(x any) *T { return nil }\n",
      "p/b.go":
        "package p\n\ntype T struct{ f *T }\n\nfunc (t *T) Foo() {}\n\nvar b = c.f\nvar c = b.f\n\nfunc f() {\n\ta.Foo()\n\tb.Foo()\n}\n",
    });
    // `a` is a function result: its type is declared, so the cycle behind the argument is never entered.
    expect(v.get("p/b.go:11:Foo")).toBe("receiver-type p/b.go::T::Foo");
    expect(v.get("p/b.go:12:Foo")).toBe("unknown");
  });

  it("a chain of 20,000 package variables ends as unknown, without a throw", () => {
    const lines = [
      "package p",
      "",
      "type T struct{ f *T }",
      "",
      "func (t *T) M() {}",
      "",
      "var a0 = &T{}",
    ];
    for (let i = 1; i <= 20_000; i += 1) lines.push(`var a${i} = a${i - 1}.f`);
    lines.push("", "func near() { a5.M() }", "", "func far() { a20000.M() }", "");
    const v = verdicts({ "p/p.go": lines.join("\n") });
    // A short chain still binds: the cap is on depth, not on the feature.
    expect(v.get("p/p.go:20009:M")).toBe("receiver-type p/p.go::T::M");
    expect(v.get("p/p.go:20011:M")).toBe("unknown");
  });

  it("a long chain is cut at the same depth however it is entered", () => {
    // 40 variables, then 40 selections on the last: either half alone is under
    // the cap; together they are over it. A counter that restarts at each
    // variable would follow all 80 links and bind.
    const lines = [
      "package p",
      "",
      "type T struct{ f *T }",
      "",
      "func (t *T) M() {}",
      "",
      "var a0 = &T{}",
    ];
    for (let i = 1; i <= 40; i += 1) lines.push(`var a${i} = a${i - 1}.f`);
    lines.push("", `func use() { a40${".f".repeat(40)}.M() }`, "");
    const v = verdicts({ "p/p.go": lines.join("\n") });
    expect(v.get("p/p.go:M")).toBe("unknown");
  });
});

describe("a declaration binds what Go binds", () => {
  const TYPES = `package p

type A struct{}
type B struct{}

func (a *A) M() {}
func (b *B) M() {}

type Store interface{ Get() }
type mem struct{}
type disk struct{}

func (m *mem) Get()  {}
func (d *disk) Get() {}

func newDisk() (*disk, error) { return nil, nil }
func newMem() *mem            { return nil }
`;
  const inFile = (body: string) =>
    verdicts({ "p/types.go": TYPES, "p/use.go": `package p\n\n${body}\n` });

  it("reads every right-hand side before binding any name: `a, b := b, a` swaps", () => {
    const v = inFile(`func swap(a *A, b *B) {
	{
		a, b := b, a
		a.M()
		b.M()
	}
}`);
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/types.go::B::M");
    expect(v.get("p/use.go:7:M")).toBe("receiver-type p/types.go::A::M");
  });

  it("swaps in a `var` declaration as well", () => {
    const v = inFile(`func swap(a *A, b *B) {
	{
		var a, b = b, a
		a.M()
		b.M()
	}
}`);
    expect(v.get("p/use.go:6:M")).toBe("receiver-type p/types.go::B::M");
    expect(v.get("p/use.go:7:M")).toBe("receiver-type p/types.go::A::M");
  });

  it("`:=` only assigns a name its scope already declared: the written type stands", () => {
    const v = inFile(`func reassign() {
	var s Store = &mem{}
	s, err := newDisk()
	_ = err
	s = &mem{}
	s.Get()
}`);
    // Bound to `disk::Get` if `:=` re-typed `s`; `s` is a Store.
    expect(v.get("p/use.go:8:Get")).toBe("unbound interface");
  });

  it("a parameter is declared in the function body's scope, so `:=` there only assigns it", () => {
    const v = inFile(`func param(s Store) {
	s, err := newDisk()
	_ = err
	s.Get()
}`);
    expect(v.get("p/use.go:6:Get")).toBe("unbound interface");
  });

  it("so is a named result, and a closure's parameter", () => {
    const v = inFile(`func result() (s Store) {
	s, err := newDisk()
	_ = err
	s.Get()
	return
}

func closure() {
	_ = func(s Store) {
		s, err := newDisk()
		_ = err
		s.Get()
	}
}`);
    expect(v.get("p/use.go:6:Get")).toBe("unbound interface");
    expect(v.get("p/use.go:14:Get")).toBe("unbound interface");
  });

  it("`:=` in an INNER block still declares: the outer name is shadowed, not assigned", () => {
    const v = inFile(`func shadow(s Store) {
	if true {
		s, err := newDisk()
		_ = err
		s.Get()
	}
	s.Get()
}`);
    expect(v.get("p/use.go:7:Get")).toBe("receiver-type p/types.go::disk::Get");
    expect(v.get("p/use.go:9:Get")).toBe("unbound interface");
  });

  it("an inferred type does not survive an assignment of another written type", () => {
    const v = inFile(`func contradicted() {
	x := &mem{}
	x.Get()
	x = &disk{}
	x.Get()
}`);
    // Does not compile; if the walker misread the declaration, the answer is unknown.
    expect(v.get("p/use.go:5:Get")).toBe("receiver-type p/types.go::mem::Get");
    expect(v.get("p/use.go:7:Get")).toBe("unknown");
  });

  it("nor an assignment of a written type where the initialiser was a call", () => {
    const v = inFile(`func contradicted() {
	x := newMem()
	x = &disk{}
	x.Get()
}`);
    expect(v.get("p/use.go:6:Get")).toBe("unknown");
  });

  it("nor an assignment of a value the walker does not model", () => {
    const v = inFile(`func unmodelled(a, b *mem) {
	x := newMem()
	x = a || b
	x.Get()
}`);
    expect(v.get("p/use.go:6:Get")).toBe("unknown");
  });

  it("nor a `:=` that re-assigns an inferred name with a contradicting written type", () => {
    const v = inFile(`func redeclared() {
	x := &mem{}
	x, ok := &disk{}, true
	_ = ok
	x.Get()
}`);
    expect(v.get("p/use.go:7:Get")).toBe("unknown");
  });

  it("an inferred type survives nil, the same written type, another call and `+=`", () => {
    const v = inFile(`func kept(n int) {
	x := newMem()
	x = nil
	x = newMem()
	y := &mem{}
	y = &mem{}
	n += 1
	x.Get()
	y.Get()
}`);
    expect(v.get("p/use.go:10:Get")).toBe("receiver-type p/types.go::mem::Get");
    expect(v.get("p/use.go:11:Get")).toBe("receiver-type p/types.go::mem::Get");
  });

  it("a compound assignment keeps the type, whatever is on its right", () => {
    const v = verdicts({
      "p/money.go": `package p

type Money int

func (m Money) Cents() int { return 0 }

func price() Money { return 0 }

func total() {
	m := price()
	m += 1
	m.Cents()
}
`,
    });
    // `1` is not modelled: a plain `m = 1` would drop the binding, `+=` must not.
    expect(v.get("p/money.go:Cents")).toBe("receiver-type p/money.go::Money::Cents");
  });

  it("an assignment inside a block changes the variable of the scope that declared it", () => {
    const v = inFile(`func nested() {
	x := &mem{}
	if true {
		x = &disk{}
	}
	x.Get()
}`);
    expect(v.get("p/use.go:8:Get")).toBe("unknown");
  });

  it("a written type is never changed by an assignment, whatever is assigned", () => {
    const v = inFile(`func written(a, b *mem) {
	var x *mem
	x = a || b
	x.Get()
}`);
    expect(v.get("p/use.go:6:Get")).toBe("receiver-type p/types.go::mem::Get");
  });
});
