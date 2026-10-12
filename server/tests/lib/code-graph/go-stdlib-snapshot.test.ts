/**
 * #1071 (PR #1104, review cycle 2, L8) — what the Go resolver knows about the
 * standard library is generated, and cannot drift from what was generated.
 *
 * `go-stdlib.ts` used to be a hand-kept list. It is now written by
 * `scripts/gen-go-stdlib-snapshot.mjs` from a Go toolchain, in two files: the
 * raw facts (`go-stdlib.snapshot.json`) and the constants the resolver imports
 * (`go-stdlib.data.ts`). This test compares the two, and what `go-stdlib.ts`
 * builds from them, so a hand edit of either — or a regeneration that only
 * updated one — fails here. It never runs Go.
 *
 * The second half pins what a MISSING entry costs, which is the reason to
 * regenerate when the Go release moves on.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  GO_CGO_PSEUDO_PACKAGE,
  GO_STDLIB_PACKAGES,
  GO_STDLIB_VERSION,
  goStdlibInterfaceMember,
  isGoStdlibInterface,
  isGoStdlibFuncVar,
  isGoStdlibInterfaceVar,
} from "../../../src/lib/code-graph/go-stdlib.js";
import {
  GO_STDLIB_INTERFACE_MEMBERS,
  GO_STDLIB_INTERFACE_TYPES,
  GO_STDLIB_FUNC_VARS,
  GO_STDLIB_INTERFACE_VARS,
  GO_STDLIB_PACKAGE_LIST,
  GO_STDLIB_SNAPSHOT_VERSION,
} from "../../../src/lib/code-graph/go-stdlib.data.js";
import { initCodeGraphParsers } from "../../../src/lib/code-graph/parsers.js";
import { goVerdicts } from "../../helpers/go-verdicts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const SNAPSHOT_PATH = path.join(repoRoot, "server/src/lib/code-graph/go-stdlib.snapshot.json");

interface Snapshot {
  goVersion: string;
  packages: string[];
  interfaces: Record<string, string[]>;
  interfaceMembers: Record<string, string[]>;
  interfaceVars: Record<string, string[]>;
  funcVars: Record<string, string[]>;
  unchecked: string[];
}
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;

/** A `[key, "a b c"]` table as `key → sorted names`. */
const asRecord = (table: ReadonlyArray<readonly [string, string]>): Record<string, string[]> =>
  Object.fromEntries(table.map(([key, names]) => [key, names.split(" ").sort()]));
const sorted = (record: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(record).map(([key, names]) => [key, [...names].sort()]));

describe("go-stdlib.data.ts is the checked-in snapshot of `go list std`", () => {
  it("names the Go release the snapshot was generated from", () => {
    expect(snapshot.goVersion).toMatch(/^go1\.\d+(\.\d+)?$/);
    expect(GO_STDLIB_SNAPSHOT_VERSION).toBe(snapshot.goVersion);
    expect(GO_STDLIB_VERSION).toBe(snapshot.goVersion);
  });

  it("lists exactly the snapshot's packages", () => {
    expect([...GO_STDLIB_PACKAGE_LIST]).toEqual(snapshot.packages);
    // Sorted and unique, so a diff of a regeneration is readable.
    expect([...snapshot.packages].sort()).toEqual(snapshot.packages);
    expect(new Set(snapshot.packages).size).toBe(snapshot.packages.length);
  });

  it("holds public packages only, and the ones a single platform would miss", () => {
    for (const p of snapshot.packages) {
      expect(p.split("/"), p).not.toContain("internal");
      expect(p.split("/"), p).not.toContain("vendor");
    }
    // Not listed on every platform: the generator merges several.
    for (const p of ["syscall/js", "runtime/cgo", "log/syslog", "net/http", "errors", "unsafe"]) {
      expect(snapshot.packages, p).toContain(p);
    }
    expect(snapshot.packages.length).toBeGreaterThan(150);
  });

  it("lists exactly the snapshot's interface types, members and variables", () => {
    expect(asRecord(GO_STDLIB_INTERFACE_TYPES)).toEqual(sorted(snapshot.interfaces));
    expect(asRecord(GO_STDLIB_INTERFACE_MEMBERS)).toEqual(sorted(snapshot.interfaceMembers));
    expect(asRecord(GO_STDLIB_INTERFACE_VARS)).toEqual(sorted(snapshot.interfaceVars));
    expect(asRecord(GO_STDLIB_FUNC_VARS)).toEqual(sorted(snapshot.funcVars));
  });

  it("the script that regenerates both files is where the header says", () => {
    expect(existsSync(path.join(repoRoot, "scripts/gen-go-stdlib-snapshot.mjs"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "scripts/go-stdlib-snapshot/main.go"))).toBe(true);
    const script = readFileSync(path.join(repoRoot, "scripts/gen-go-stdlib-snapshot.mjs"), "utf8");
    expect(script).toContain("go-stdlib.snapshot.json");
    expect(script).toContain("go-stdlib.data.ts");
  });

  it("only a package that does not build on the generating host goes without interface facts", () => {
    expect(snapshot.unchecked).toEqual(["syscall/js"]);
  });
});

describe("what go-stdlib.ts answers is what the snapshot holds", () => {
  it("every snapshot package is standard library, and so is the cgo pseudo-package", () => {
    for (const p of snapshot.packages) expect(GO_STDLIB_PACKAGES.has(p), p).toBe(true);
    expect(GO_STDLIB_PACKAGES.has(GO_CGO_PSEUDO_PACKAGE)).toBe(true);
    expect(GO_STDLIB_PACKAGES.size).toBe(snapshot.packages.length + 1);
    expect(GO_STDLIB_PACKAGES.has("github.com/pkg/errors")).toBe(false);
    expect(GO_STDLIB_PACKAGES.has("net")).toBe(true);
    expect(GO_STDLIB_PACKAGES.has("ne")).toBe(false);
  });

  it("every snapshot interface is an interface, and nothing else is", () => {
    let count = 0;
    for (const [importPath, names] of Object.entries(snapshot.interfaces)) {
      for (const name of names) {
        expect(isGoStdlibInterface(importPath, name), `${importPath}.${name}`).toBe(true);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(150);
    // Concrete types of packages that DO declare interfaces.
    for (const [importPath, name] of [
      ["net/http", "Client"],
      ["net/http", "Request"],
      ["io", "PipeReader"],
      ["database/sql", "DB"],
      ["context", "CancelFunc"],
    ]) {
      expect(isGoStdlibInterface(importPath, name), `${importPath}.${name}`).toBe(false);
    }
    // By import path, never by the path's last segment.
    expect(isGoStdlibInterface("github.com/acme/http", "Handler")).toBe(false);
    expect(isGoStdlibInterface("http", "Handler")).toBe(false);
  });

  it("the interfaces the first hand-kept list missed are there", () => {
    // PR #1104 review 2: each of these was a decided `external` on a call a
    // project type may receive.
    for (const [importPath, name] of [
      ["go/ast", "Visitor"],
      ["crypto/cipher", "Block"],
      ["expvar", "Var"],
      ["database/sql/driver", "NamedValueChecker"],
      ["encoding", "TextAppender"],
    ]) {
      expect(isGoStdlibInterface(importPath, name), `${importPath}.${name}`).toBe(true);
    }
  });

  it("an interface-typed member is a field, or a method with the result positions that are one", () => {
    let fields = 0;
    let methods = 0;
    let promoted = 0;
    for (const [type, members] of Object.entries(snapshot.interfaceMembers)) {
      const dot = type.lastIndexOf(".");
      const importPath = type.slice(0, dot);
      const typeName = type.slice(dot + 1);
      for (const token of members) {
        const open = token.indexOf("(");
        const head = open === -1 ? token : token.slice(0, open);
        // `Name*`: promoted from an embedded interface.
        const starred = head.endsWith("*");
        const name = starred ? head.slice(0, -1) : head;
        const got = goStdlibInterfaceMember(importPath, typeName, name);
        if (open === -1 && !starred) {
          expect(got, `${type}.${token}`).toEqual({ kind: "field" });
          fields += 1;
          continue;
        }
        const results =
          open === -1
            ? []
            : token
                .slice(open + 1, -1)
                .split(",")
                .map(Number);
        expect(got, `${type}.${token}`).toEqual(
          starred ? { kind: "method", results, promoted: true } : { kind: "method", results },
        );
        methods += 1;
        if (starred) promoted += 1;
      }
    }
    expect(fields).toBeGreaterThan(50);
    expect(methods).toBeGreaterThan(50);
    // The panel's case, and that it is not the only one.
    expect(promoted).toBeGreaterThan(10);
    expect(goStdlibInterfaceMember("debug/elf", "Section", "ReadAt")).toEqual({
      kind: "method",
      results: [],
      promoted: true,
    });
    // `Open` is the type's own method (it returns an interface); `Data` its own and plain.
    expect(goStdlibInterfaceMember("debug/elf", "Section", "Open")).toEqual({
      kind: "method",
      results: [0],
    });
    expect(goStdlibInterfaceMember("debug/elf", "Section", "Data")).toBeUndefined();
    expect(goStdlibInterfaceMember("net/http", "Response", "Body")).toEqual({ kind: "field" });
    expect(goStdlibInterfaceMember("net/http", "Server", "Handler")).toEqual({ kind: "field" });
    expect(goStdlibInterfaceMember("net/http", "Request", "Context")).toEqual({
      kind: "method",
      results: [0],
    });
    // A member that is not interface-typed, a type with none, a path that is not this one.
    expect(goStdlibInterfaceMember("net/http", "Request", "URL")).toBeUndefined();
    expect(goStdlibInterfaceMember("net/http", "Request", "Bod")).toBeUndefined();
    expect(goStdlibInterfaceMember("net/url", "URL", "Query")).toBeUndefined();
    expect(goStdlibInterfaceMember("github.com/acme/http", "Response", "Body")).toBeUndefined();
  });

  it("a package variable of a func type is one, and a function is not", () => {
    for (const [importPath, names] of Object.entries(snapshot.funcVars)) {
      for (const name of names) expect(isGoStdlibFuncVar(importPath, name)).toBe(true);
    }
    expect(isGoStdlibFuncVar("flag", "Usage")).toBe(true);
    expect(isGoStdlibFuncVar("flag", "Parse")).toBe(false);
    expect(isGoStdlibFuncVar("fmt", "Usage")).toBe(false);
    expect(isGoStdlibFuncVar("github.com/acme/flag", "Usage")).toBe(false);
  });

  it("an interface-typed package variable is one, and a concrete one is not", () => {
    for (const [importPath, names] of Object.entries(snapshot.interfaceVars)) {
      for (const name of names) {
        expect(isGoStdlibInterfaceVar(importPath, name), `${importPath}.${name}`).toBe(true);
      }
    }
    expect(isGoStdlibInterfaceVar("io", "Discard")).toBe(true);
    expect(isGoStdlibInterfaceVar("net/http", "DefaultTransport")).toBe(true);
    expect(isGoStdlibInterfaceVar("net/http", "DefaultClient")).toBe(false);
    expect(isGoStdlibInterfaceVar("os", "Stdout")).toBe(false);
    expect(isGoStdlibInterfaceVar("github.com/acme/io", "Discard")).toBe(false);
  });
});

describe("what a missing entry costs (the reason to regenerate for a new Go release)", () => {
  beforeAll(async () => {
    await initCodeGraphParsers();
  });

  // `encoding/newfmt` stands for a package added to the standard library after
  // the snapshot's release: the list does not know it.
  const NEW_PACKAGE = "encoding/newfmt";
  const caller = (importPath: string) =>
    `package p\n\nimport "${importPath}"\n\nfunc f() {\n\tnewfmt.Marshal()\n}\n`;

  it("the premise: the stand-in is not in the list, and a real sibling is", () => {
    expect(GO_STDLIB_PACKAGES.has(NEW_PACKAGE)).toBe(false);
    expect(GO_STDLIB_PACKAGES.has("encoding/json")).toBe(true);
  });

  it("an unlisted package under a go.mod is still external: nothing is bound", () => {
    const v = goVerdicts({ "p/p.go": caller(NEW_PACKAGE) });
    expect(v.get("p/p.go:6:Marshal")).toBe("unbound external");
  });

  it("with NO go.mod, an unlisted path can be taken for the project directory of that name", () => {
    const tree = {
      "p/p.go": caller(NEW_PACKAGE),
      "encoding/newfmt/n.go": "package newfmt\n\nfunc Marshal() {}\n",
    };
    // The one wrong binding a missing package entry can cause.
    expect(goVerdicts(tree, []).get("p/p.go:6:Marshal")).toBe(
      "package encoding/newfmt/n.go::Marshal",
    );
    // A LISTED path in the same layout is the standard library, whatever the tree holds.
    const listed = {
      "p/p.go": `package p\n\nimport "encoding/json"\n\nfunc f() {\n\tjson.Marshal()\n}\n`,
      "encoding/json/n.go": "package json\n\nfunc Marshal() {}\n",
    };
    expect(goVerdicts(listed, []).get("p/p.go:6:Marshal")).toBe("unbound external");
  });

  it("an unlisted interface is taken for a concrete type: decided `external`, and an edge is lost", () => {
    const src = (type: string) =>
      `package p\n\nimport "net/http"\n\ntype impl struct{}\n\nfunc (i *impl) Serve() {}\n\nfunc f(h ${type}) {\n\th.Serve()\n}\n`;
    // `http.FutureHandler` stands for an interface a newer Go added.
    expect(isGoStdlibInterface("net/http", "FutureHandler")).toBe(false);
    expect(goVerdicts({ "p/p.go": src("http.FutureHandler") }).get("p/p.go:10:Serve")).toBe(
      "unbound external",
    );
    // A listed one in the same place leaves the call open.
    expect(goVerdicts({ "p/p.go": src("http.Handler") }).get("p/p.go:10:Serve")).toBe(
      "unbound interface",
    );
  });
});
