/**
 * #1071 — Go method calls bind in the code graph ITSELF, at ingest.
 *
 * Proven against a real SQLite database built from the migration chain, because
 * three of the claims are about rows:
 *
 *   1. a handler's call through a struct field (`h.store.SetEntriesStatus(…)`)
 *      is persisted with `toSymbolId` set to the `internal/storage` method, and
 *      the edge says how it was decided (`metadata.goResolution`);
 *   2. a graph an older extractor wrote is upgraded IN PLACE on its next
 *      incremental ingest — every symbol keeps its id, so a requirement mapping
 *      that points at one survives — and a second ingest changes nothing;
 *   3. an incremental ingest binds exactly as a full ingest of the same tree
 *      does, including when the file that changed is not the file that calls.
 *
 * And, from the review of PR #1104, the claims about what ingest must NOT do:
 * bind a call the resolver ruled unbound, fail because resolving one call threw,
 * call a project package external because it could not name it, stamp a graph
 * as upgraded when a file was not, or leave a project without edges mid-upgrade.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  extractorUpgradeLanguages,
  ingestCodeGraph,
  NAMED_FILES_CAP,
} from "../src/lib/code-graph/ingest.js";
import { GO_RESOLUTION_KEY } from "../src/lib/code-graph/go-type-resolution.js";
import { loadResolvedGoCalls } from "../src/lib/impact-analysis/go-call-resolution.js";
import {
  crossToSchema,
  PrismaSchemaImpactDataSource,
} from "../src/lib/impact-analysis/schema-impact.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

type Tree = Record<string, string | null>;

/**
 * The lattice of PR #1104's second review: `types` struct types on each of
 * `levels` levels, every one embedding EVERY type of the next level, a type
 * `W` embedding the whole first level, and `calls` calls `w.N<i>()` that no
 * type declares — so each has to look through all of them.
 */
function goLattice(types: number, levels: number, calls: number): string {
  let src = "package wide\n\n";
  for (let l = 0; l < levels; l += 1) {
    for (let i = 0; i < types; i += 1) {
      src += `type T${l}_${i} struct {\n`;
      if (l + 1 < levels) for (let j = 0; j < types; j += 1) src += `\tT${l + 1}_${j}\n`;
      src += "}\n";
    }
  }
  src += "type W struct {\n";
  for (let j = 0; j < types; j += 1) src += `\tT0_${j}\n`;
  src += "}\n\nfunc f(w *W) {\n";
  for (let i = 0; i < calls; i += 1) src += `\tw.N${i}()\n`;
  return `${src}}\n`;
}

const GO_MOD = "module example.com/app\n\ngo 1.24\n";

const STORAGE = `package storage

type Storage struct{}

func NewStorage() *Storage { return &Storage{} }

func (s *Storage) SetEntriesStatus(ids []int64) error { return nil }
func (s *Storage) Close() error                       { return nil }
`;

const CACHE = `package cache

type Cache struct{}

func (c *Cache) SetEntriesStatus(ids []int64) error { return nil }
`;

const HANDLER_TYPE = `package api

import "example.com/app/internal/storage"

type handler struct {
	store *storage.Storage
}
`;

const HANDLER = `package api

import (
	"fmt"
	"net/http"
)

type Reader interface{ Read() error }

func (h *handler) updateEntries(w http.ResponseWriter, ids []int64) {
	h.store.SetEntriesStatus(ids)
	w.WriteHeader(200)
	fmt.Println("done")
	describe()
}

func (h *handler) read(r Reader) { r.Read() }

func describe() {}
`;

const BASE: Tree = {
  "go.mod": GO_MOD,
  "internal/storage/storage.go": STORAGE,
  "internal/cache/cache.go": CACHE,
  "internal/api/handler.go": HANDLER_TYPE,
  "internal/api/entry.go": HANDLER,
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1071 — Go method calls bind in the code graph at ingest",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1071-go-types");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1071-"));
      await db.user.create({
        data: {
          id: "u-1071",
          username: "u-1071",
          displayName: "u-1071",
          email: "u-1071@example.test",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    const newProject = async (): Promise<{ projectId: string; root: string }> => {
      seq += 1;
      const p = await db.project.create({
        data: { name: `p1071-${seq}`, slug: `p1071-${seq}`, createdById: "u-1071" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      await fs.mkdir(root, { recursive: true });
      return { projectId: p.id, root };
    };

    const applyTree = async (root: string, tree: Tree) => {
      for (const [rel, content] of Object.entries(tree)) {
        const abs = path.join(root, rel);
        if (content === null) {
          await fs.rm(abs, { force: true });
          continue;
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
      }
    };

    const ingest = (projectId: string, root: string, incremental = true) =>
      ingestCodeGraph(db, { projectId, rootDir: root, incremental, sqlLineageOverride: false });

    /** Every `calls` edge as `callee → target qualified name | NULL (how)`. */
    const calls = async (projectId: string): Promise<string[]> => {
      const edges = await db.codeEdge.findMany({
        where: { projectId, kind: "calls" },
        include: { toSymbol: { select: { qualifiedName: true } }, fromSymbol: true },
      });
      return edges
        .map((e) => {
          const how = e.metadata
            ? (JSON.parse(e.metadata) as Record<string, string>)[GO_RESOLUTION_KEY]
            : "-";
          return `${e.fromSymbol.qualifiedName} > ${e.toQualifiedName} → ${e.toSymbol?.qualifiedName ?? "NULL"} (${how})`;
        })
        .sort();
    };

    const symbolIds = async (projectId: string): Promise<Map<string, string>> => {
      const rows = await db.codeSymbol.findMany({
        where: { projectId },
        select: { id: true, kind: true, name: true, filePath: true, startLine: true },
      });
      return new Map(rows.map((r) => [`${r.filePath}|${r.kind}|${r.name}|${r.startLine}`, r.id]));
    };

    it("binds a handler's call through a struct field to the internal/storage method", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);

      const got = await calls(projectId);
      // `internal/cache` declares a method of the same name: a name match alone
      // is ambiguous, the field's type is not.
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > SetEntriesStatus → " +
          "internal/storage/storage.go::Storage::SetEntriesStatus (receiver-type)",
      );
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > describe → " +
          "internal/api/entry.go::describe (same-package)",
      );
    });

    it("records why a call has no project callee, and binds nothing for it", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);

      const got = await calls(projectId);
      // `http.ResponseWriter` is an interface: dispatched at run time, not external.
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > WriteHeader → NULL (interface)",
      );
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > Println → NULL (external)",
      );
      expect(got).toContain("internal/api/entry.go::handler::read > Read → NULL (interface)");
    });

    it("records the extractor version on the graph", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
    });

    it("the impact fallback binds an interface call by name but never an external one", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        ...BASE,
        // The only `Read`, `WriteHeader` and `Println` in the project: by name
        // alone, each of the three calls in entry.go has exactly one candidate.
        // Two go through an interface (a project one, `http.ResponseWriter`);
        // `fmt.Println` is a function of a package outside the project.
        "internal/api/disk.go": `package api

type disk struct{}

func (d *disk) Read() error      { return nil }
func (d *disk) WriteHeader(int)  {}
func Println(s string)           {}
`,
      });
      await ingest(projectId, root, false);

      const resolved = await loadResolvedGoCalls(db, projectId);
      const names = new Map(
        (await db.codeSymbol.findMany({ where: { projectId } })).map((s) => [
          s.id,
          s.qualifiedName,
        ]),
      );
      const bound = resolved.map((r) => names.get(r.toSymbolId)).sort();
      expect(bound).toEqual([
        "internal/api/disk.go::disk::Read",
        "internal/api/disk.go::disk::WriteHeader",
      ]);
    });

    it("upgrades a graph an older extractor wrote in place: ids survive, names and edges change", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      const idsBefore = await symbolIds(projectId);

      // Put the graph back as the pre-#1071 extractor left it: methods named
      // `<file>::<name>`, calls unbound and unexplained, no version recorded.
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      for (const s of await db.codeSymbol.findMany({ where: { projectId, kind: "function" } })) {
        await db.codeSymbol.update({
          where: { id: s.id },
          data: { qualifiedName: `${s.filePath}::${s.name}` },
        });
      }
      await db.codeEdge.updateMany({
        where: { projectId, kind: "calls" },
        data: { toSymbolId: null, metadata: null },
      });
      await db.codeGraph.update({ where: { id: graph.id }, data: { extractorVersion: null } });
      // Something that points at a symbol by id, as a requirement mapping does.
      const method = await db.codeSymbol.findFirstOrThrow({
        where: { projectId, name: "SetEntriesStatus", filePath: "internal/storage/storage.go" },
      });
      const fresh = await newProject();
      await applyTree(fresh.root, BASE);
      await ingest(fresh.projectId, fresh.root, false);

      const stats = await ingest(projectId, root);

      expect(stats.filesParsed).toBe(0);
      expect(stats.filesUpgraded).toBe(4);
      expect(await symbolIds(projectId)).toEqual(idsBefore);
      expect(
        (await db.codeSymbol.findUniqueOrThrow({ where: { id: method.id } })).qualifiedName,
      ).toBe("internal/storage/storage.go::Storage::SetEntriesStatus");
      expect(await calls(projectId)).toEqual(await calls(fresh.projectId));
      expect((await db.codeGraph.findFirstOrThrow({ where: { projectId } })).extractorVersion).toBe(
        CODE_GRAPH_EXTRACTOR_VERSION,
      );

      // Up to date now: nothing is upgraded, re-bound or rewritten again.
      const edgeIds = (await db.codeEdge.findMany({ where: { projectId } })).map((e) => e.id);
      const again = await ingest(projectId, root);
      expect(again.filesUpgraded).toBe(0);
      expect(again.filesRebound).toBe(0);
      expect((await db.codeEdge.findMany({ where: { projectId } })).map((e) => e.id)).toEqual(
        edgeIds,
      );
    });

    it("re-files an edge the older extractor attributed to a same-named method", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        "go.mod": GO_MOD,
        "p/twins.go": `package p

type A struct{}
type B struct{}

func (a *A) Close() { first() }
func (b *B) Close() { second() }
func first()  {}
func second() {}
`,
      });
      await ingest(projectId, root, false);
      // The pre-#1071 graph: both methods share a qualified name, and both
      // bodies' calls were filed under the second.
      const [a, b] = await db.codeSymbol.findMany({
        where: { projectId, name: "Close" },
        orderBy: { startLine: "asc" },
      });
      await db.codeSymbol.updateMany({
        where: { projectId, name: "Close" },
        data: { qualifiedName: "p/twins.go::Close" },
      });
      await db.codeEdge.updateMany({
        where: { projectId, kind: "calls" },
        data: { fromSymbolId: b.id },
      });
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      await db.codeGraph.update({ where: { id: graph.id }, data: { extractorVersion: null } });

      await ingest(projectId, root);

      const first = await db.codeEdge.findFirstOrThrow({
        where: { projectId, kind: "calls", toQualifiedName: "first" },
      });
      expect(first.fromSymbolId).toBe(a.id);
      expect(await db.codeEdge.count({ where: { projectId, kind: "calls" } })).toBe(2);
    });

    it("leaves rows another pass wrote for an upgraded file alone", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      const from = await db.codeSymbol.findFirstOrThrow({
        where: { projectId, name: "updateEntries" },
      });
      const lineage = await db.codeEdge.create({
        data: {
          codeGraphId: graph.id,
          projectId,
          kind: "writes",
          fromSymbolId: from.id,
          toQualifiedName: "entries",
          filePath: "internal/api/entry.go",
          line: 11,
          source: "sqlglot",
        },
      });
      await db.codeGraph.update({ where: { id: graph.id }, data: { extractorVersion: null } });

      await ingest(projectId, root);

      expect(await db.codeEdge.findUnique({ where: { id: lineage.id } })).not.toBeNull();
    });

    it("re-binds an unchanged caller when the file that changed only declares the field's type", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);

      // Only handler.go changes: `store` is now a cache. entry.go, which makes
      // the call, is byte-identical.
      const v2: Tree = {
        "internal/api/handler.go": `package api

import "example.com/app/internal/cache"

type handler struct {
	store *cache.Cache
}
`,
      };
      await applyTree(root, v2);
      const stats = await ingest(projectId, root);
      expect(stats.filesParsed).toBe(1);

      const fresh = await newProject();
      await applyTree(fresh.root, { ...BASE, ...v2 });
      await ingest(fresh.projectId, fresh.root, false);

      const got = await calls(projectId);
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > SetEntriesStatus → " +
          "internal/cache/cache.go::Cache::SetEntriesStatus (receiver-type)",
      );
      expect(got).toEqual(await calls(fresh.projectId));
    });

    it("re-binds an unchanged caller when the package it called into is deleted", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);

      const v2: Tree = { "internal/storage/storage.go": null };
      await applyTree(root, v2);
      await ingest(projectId, root);

      const fresh = await newProject();
      await applyTree(fresh.root, { ...BASE, ...v2 });
      await ingest(fresh.projectId, fresh.root, false);
      expect(await calls(projectId)).toEqual(await calls(fresh.projectId));
    });

    it("does not re-parse Go files when only a file of another language changed", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, { ...BASE, "web/app.js": "export function boot() {}\n" });
      await ingest(projectId, root, false);

      await applyTree(root, { "web/app.js": "export function boot() { return 1; }\n" });
      const stats = await ingest(projectId, root);

      expect(stats.filesParsed).toBe(1);
      expect(stats.filesRebound).toBe(0);
      expect(stats.filesUpgraded).toBe(0);
    });

    it("treats a third-party import that ends in a project directory's name as external", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        "go.mod": GO_MOD,
        "errors/errors.go": "package errors\n\nfunc Wrap() {}\n",
        "cmd/main.go": `package main

import "github.com/pkg/errors"

func main() { errors.Wrap() }
`,
      });
      await ingest(projectId, root, false);
      expect(await calls(projectId)).toEqual(["cmd/main.go::main > Wrap → NULL (external)"]);
    });

    // ── Review of PR #1104 ───────────────────────────────────────────────────

    /** A Go file the current parser gives up on (the walker overflows the stack). */
    const UNPARSEABLE = `package storage\n\nfunc deep(x int) int {\n\treturn ${"(".repeat(30_000)}x${")".repeat(30_000)}\n}\n`;

    const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

    /** Put a graph back as the pre-#1071 extractor left it (names, bindings, no version). */
    const downgrade = async (projectId: string) => {
      for (const s of await db.codeSymbol.findMany({ where: { projectId, kind: "function" } })) {
        await db.codeSymbol.update({
          where: { id: s.id },
          data: { qualifiedName: `${s.filePath}::${s.name}` },
        });
      }
      await db.codeEdge.updateMany({
        where: { projectId, kind: "calls" },
        data: { toSymbolId: null, metadata: null },
      });
      await db.codeGraph.updateMany({ where: { projectId }, data: { extractorVersion: null } });
    };

    it("never falls through to name binding once the resolver ruled a call unbound", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        "go.mod": GO_MOD,
        // Every callee below has a name-bindable candidate IN THE CALLER'S OWN
        // FILE, which is the one place the name-evidence rules bind a member
        // call with an unknown receiver, and a bare call.
        "internal/api/serve.go": `package api

import (
	"net/http"
	"strings"
)

type disk struct{}

func (d *disk) WriteHeader(int)       {}
func (d *disk) WriteString(s string)  {}

func handler() {}

func pick() func() { return nil }

type ID int

func serve(w http.ResponseWriter) {
	w.WriteHeader(200)
	var b strings.Builder
	b.WriteString("x")
	handler := pick()
	handler()
	ID(1)
}
`,
      });
      await ingest(projectId, root, false);

      const got = (await calls(projectId)).filter((c) => c.includes("::serve >"));
      expect(got).toEqual([
        "internal/api/serve.go::serve > ID → NULL (conversion)",
        "internal/api/serve.go::serve > WriteHeader → NULL (interface)",
        "internal/api/serve.go::serve > WriteString → NULL (external)",
        "internal/api/serve.go::serve > handler → NULL (func-value)",
        "internal/api/serve.go::serve > pick → internal/api/serve.go::pick (same-package)",
      ]);
    });

    it("does not bind twins by name either: an ambiguous verdict stays unbound", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        "go.mod": GO_MOD,
        "net/conn.go": "package net\n\ntype Conn struct{}\n",
        // The caller's own file declares one twin: a same-file name match exists.
        "net/conn_linux.go":
          "package net\n\nfunc (c *Conn) Flush() {}\n\nfunc use(c *Conn) { c.Flush() }\n",
        "net/conn_windows.go": "package net\n\nfunc (c *Conn) Flush() {}\n",
      });
      await ingest(projectId, root, false);
      expect(await calls(projectId)).toEqual(["net/conn_linux.go::use > Flush → NULL (ambiguous)"]);
    });

    it("a cycle of package variables does not fail the ingest", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        ...BASE,
        "internal/version/version.go": `package version

var a = b
var b = a
var c = c.x

func f() {
	a.Foo()
	c.Bar()
}
`,
      });
      const stats = await ingest(projectId, root, false);

      expect(stats.goBinding).toMatchObject({ files: 5, errors: 0 });
      const got = await calls(projectId);
      expect(got).toContain("internal/version/version.go::f > Foo → NULL (-)");
      expect(got).toContain("internal/version/version.go::f > Bar → NULL (-)");
      // The rest of the tree bound as if the file were not there.
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > SetEntriesStatus → " +
          "internal/storage/storage.go::Storage::SetEntriesStatus (receiver-type)",
      );
      // And the graph can still be refreshed.
      await applyTree(root, { "internal/api/entry.go": `${HANDLER}\n// touched\n` });
      const again = await ingest(projectId, root);
      expect(again.filesParsed).toBe(1);
      expect(again.goBinding?.errors).toBe(0);
    });

    it("reports what binding Go cost, and nothing when no Go call was resolved", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, { ...BASE, "web/app.js": "export function boot() {}\n" });
      const first = await ingest(projectId, root, false);
      expect(first.goBinding).toMatchObject({ files: 4, calls: 5, errors: 0 });
      expect(first.goBinding!.durationMs).toBeGreaterThanOrEqual(0);

      // One Go file changes: every Go file is re-read for its declarations.
      await applyTree(root, { "internal/api/entry.go": `${HANDLER}\n// touched\n` });
      const second = await ingest(projectId, root);
      expect(second.filesParsed).toBe(1);
      expect(second.filesRebound).toBe(3);
      expect(second.goBinding).toMatchObject({ files: 4, calls: 5, errors: 0 });

      await applyTree(root, { "web/app.js": "export function boot() { return 1; }\n" });
      expect((await ingest(projectId, root)).goBinding).toBeNull();
    });

    it("resolves a package past a build-ignored generator, and a helper package under tests/", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        ...BASE,
        "internal/storage/gen.go":
          "//go:build ignore\n\npackage main\n\nfunc main() { emit() }\n\nfunc emit() {}\n",
        // Not a test file by Go's rule: only `_test.go` is.
        "tests/util/util.go":
          "package util\n\ntype Fixture struct{}\n\nfunc New() *Fixture { return nil }\n\nfunc (f *Fixture) Load() {}\n",
        "cmd/main.go": `package main

import (
	"example.com/app/internal/storage"
	"example.com/app/tests/util"
)

func main() {
	storage.NewStorage().Close()
	util.New().Load()
}
`,
      });
      await ingest(projectId, root, false);

      const got = await calls(projectId);
      expect(got).toContain(
        "cmd/main.go::main > NewStorage → internal/storage/storage.go::NewStorage (package)",
      );
      expect(got).toContain(
        "cmd/main.go::main > Close → internal/storage/storage.go::Storage::Close (receiver-type)",
      );
      expect(got).toContain("cmd/main.go::main > New → tests/util/util.go::New (package)");
      expect(got).toContain(
        "cmd/main.go::main > Load → tests/util/util.go::Fixture::Load (receiver-type)",
      );
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > SetEntriesStatus → " +
          "internal/storage/storage.go::Storage::SetEntriesStatus (receiver-type)",
      );
      expect(got).toContain(
        "internal/storage/gen.go::main > emit → internal/storage/gen.go::emit (same-package)",
      );
    });

    it("names a file it could not parse, and does not call what that file may declare external", async () => {
      const { projectId, root } = await newProject();
      const MAIN = `package main

import "example.com/app/internal/storage"

func main() {
	storage.NewStorage()
	storage.Deep()
}
`;
      await applyTree(root, {
        ...BASE,
        "internal/storage/deep.go": UNPARSEABLE,
        "cmd/main.go": MAIN,
      });
      const stats = await ingest(projectId, root, false);

      expect(stats.filesUnparseable).toEqual(["internal/storage/deep.go"]);
      expect(stats.filesUnparseableCount).toBe(1);
      const got = await calls(projectId);
      // `Deep` may be declared in the file that did not parse: undecided, so the
      // name-based fallback may still try. `NewStorage` is declared, and binds.
      expect(got).toContain("cmd/main.go::main > Deep → NULL (-)");
      expect(got).toContain(
        "cmd/main.go::main > NewStorage → internal/storage/storage.go::NewStorage (package)",
      );

      // Control: with every file of the package parsed, the same call is decided.
      const whole = await newProject();
      await applyTree(whole.root, { ...BASE, "cmd/main.go": MAIN });
      await ingest(whole.projectId, whole.root, false);
      expect(await calls(whole.projectId)).toContain("cmd/main.go::main > Deep → NULL (external)");
    });

    it("re-binds an unchanged caller when only its VERDICT changes, not its target", async () => {
      const { projectId, root } = await newProject();
      const MAIN = `package main

import "example.com/app/internal/storage"

func main() { storage.Deep() }
`;
      await applyTree(root, { ...BASE, "cmd/main.go": MAIN });
      await ingest(projectId, root, false);
      // Decided: every file of `storage` was read, and none declares `Deep`.
      expect(await calls(projectId)).toContain("cmd/main.go::main > Deep → NULL (external)");

      // A file the parser gives up on joins the package, in a run that parses
      // another Go file (which is what re-binds the unchanged ones). cmd/main.go
      // is byte-identical; its call is unbound before and after, but no longer
      // decided: only the edge's metadata moves.
      await applyTree(root, {
        "internal/storage/deep.go": UNPARSEABLE,
        "internal/cache/cache.go": `${CACHE}\n// touched\n`,
      });
      const stats = await ingest(projectId, root);
      expect(stats.filesParsed).toBe(1);
      expect(stats.filesUnparseable).toEqual(["internal/storage/deep.go"]);
      expect(await calls(projectId)).toContain("cmd/main.go::main > Deep → NULL (-)");
    });

    it("caps the list of unparseable files it names, never the count", async () => {
      const { projectId, root } = await newProject();
      const tree: Tree = { "go.mod": GO_MOD };
      for (let i = 0; i < NAMED_FILES_CAP + 3; i += 1) {
        tree[`deep/f${String(i).padStart(3, "0")}.go`] = UNPARSEABLE;
      }
      await applyTree(root, tree);
      const stats = await ingest(projectId, root, false);
      expect(stats.filesUnparseableCount).toBe(NAMED_FILES_CAP + 3);
      expect(stats.filesUnparseable).toHaveLength(NAMED_FILES_CAP);
    });

    const upgradeFailed = async (projectId: string): Promise<unknown> => {
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      return graph.extractorUpgradeFailed ? JSON.parse(graph.extractorUpgradeFailed) : null;
    };

    it("does the upgrade ONCE when a file cannot be upgraded: the file is remembered by content and named", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await downgrade(projectId);
      // storage.go as the older extractor read it, and as the current one cannot:
      // same bytes on disk as the stored hash, so the walk sees it as unchanged.
      const broken = UNPARSEABLE;
      await applyTree(root, { "internal/storage/storage.go": broken });
      await db.codeSymbol.updateMany({
        where: { projectId, kind: "module", filePath: "internal/storage/storage.go" },
        data: { contentHash: sha256(broken) },
      });

      const stats = await ingest(projectId, root);

      expect(stats.filesUpgradeFailed).toEqual(["internal/storage/storage.go"]);
      expect(stats.filesUpgradeFailedCount).toBe(1);
      expect(stats.filesUnparseable).toEqual(["internal/storage/storage.go"]);
      expect(stats.filesUpgraded).toBe(3);
      // The rest of the tree IS at the current version; the one file is listed
      // beside it with the hash of the content that failed.
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
      expect(await upgradeFailed(projectId)).toEqual({
        "internal/storage/storage.go": sha256(broken),
      });
      // Its rows are still the older extractor's.
      expect(
        (
          await db.codeSymbol.findFirstOrThrow({
            where: { projectId, name: "SetEntriesStatus", filePath: "internal/storage/storage.go" },
          })
        ).qualifiedName,
      ).toBe("internal/storage/storage.go::SetEntriesStatus");

      // The next ingest does NOT redo the upgrade: nothing is re-parsed for it,
      // no edge is rewritten, and the file is still named.
      const again = await ingest(projectId, root);
      expect(again.filesUpgraded).toBe(0);
      expect(again.edgesUpserted).toBe(0);
      expect(again.filesRebound).toBe(0);
      expect(again.filesUpgradeFailed).toEqual(["internal/storage/storage.go"]);
      expect(again.filesUpgradeFailedCount).toBe(1);
      // The file is not even re-parsed: its content is the one that failed.
      expect(again.filesUnparseable).toEqual([]);
      expect(await upgradeFailed(projectId)).toEqual({
        "internal/storage/storage.go": sha256(broken),
      });

      // Neither does a change to ANOTHER file.
      await applyTree(root, { "internal/api/entry.go": `${HANDLER}\nfunc extra() {}\n` });
      const other = await ingest(projectId, root);
      expect(other.filesUpgraded).toBe(0);
      expect(other.filesParsed).toBe(1);
      expect(other.filesUpgradeFailed).toEqual(["internal/storage/storage.go"]);
      await applyTree(root, { "internal/api/entry.go": HANDLER });
      await ingest(projectId, root);

      // Once the file's content changes to something that parses, it is current.
      await applyTree(root, { "internal/storage/storage.go": STORAGE });
      const fixed = await ingest(projectId, root);
      expect(fixed.filesUpgradeFailed).toEqual([]);
      expect(fixed.filesUpgradeFailedCount).toBe(0);
      expect(await upgradeFailed(projectId)).toBeNull();
      expect((await db.codeGraph.findFirstOrThrow({ where: { projectId } })).extractorVersion).toBe(
        CODE_GRAPH_EXTRACTOR_VERSION,
      );
      const fresh = await newProject();
      await applyTree(fresh.root, BASE);
      await ingest(fresh.projectId, fresh.root, false);
      expect(await calls(projectId)).toEqual(await calls(fresh.projectId));
    });

    it("remembers a CHANGED file of an upgraded language that cannot be parsed", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await downgrade(projectId);
      await applyTree(root, { "internal/storage/storage.go": UNPARSEABLE });

      const stats = await ingest(projectId, root);

      expect(stats.filesUpgradeFailed).toEqual(["internal/storage/storage.go"]);
      expect(stats.filesUpgraded).toBe(3);
      expect(await upgradeFailed(projectId)).toEqual({
        "internal/storage/storage.go": sha256(UNPARSEABLE),
      });
      // Still named on the next run, and the other three are not upgraded again.
      const again = await ingest(projectId, root);
      expect(again.filesUpgraded).toBe(0);
      expect(again.filesUpgradeFailed).toEqual(["internal/storage/storage.go"]);
    });

    it("retries a remembered file whose content is no longer the one that failed, and only that file", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      // storage.go alone is left in the older shape, remembered as UNREADABLE
      // (no hash): the graph is otherwise current.
      for (const sym of await db.codeSymbol.findMany({
        where: { projectId, kind: "function", filePath: "internal/storage/storage.go" },
      })) {
        await db.codeSymbol.update({
          where: { id: sym.id },
          data: { qualifiedName: `${sym.filePath}::${sym.name}` },
        });
      }
      await db.codeGraph.updateMany({
        where: { projectId },
        data: { extractorUpgradeFailed: JSON.stringify({ "internal/storage/storage.go": null }) },
      });

      const stats = await ingest(projectId, root);

      expect(stats.filesUpgraded).toBe(1);
      expect(stats.filesUpgradeFailed).toEqual([]);
      expect(await upgradeFailed(projectId)).toBeNull();
      expect(
        (
          await db.codeSymbol.findFirstOrThrow({
            where: { projectId, name: "SetEntriesStatus", filePath: "internal/storage/storage.go" },
          })
        ).qualifiedName,
      ).toBe("internal/storage/storage.go::Storage::SetEntriesStatus");
      const fresh = await newProject();
      await applyTree(fresh.root, BASE);
      await ingest(fresh.projectId, fresh.root, false);
      expect(await calls(projectId)).toEqual(await calls(fresh.projectId));
    });

    it("a file that cannot be READ during an upgrade is remembered without a hash, and retried next time", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await downgrade(projectId);
      const target = path.join(root, "internal/storage/storage.go");
      const real = fs.readFile.bind(fs);
      const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

      for (const failOnRead of [1, 2]) {
        // 1: the walk cannot read it. 2: the walk can (unchanged), the upgrade's re-read cannot.
        let reads = 0;
        const spy = vi.spyOn(fs, "readFile").mockImplementation(((
          file: unknown,
          ...rest: unknown[]
        ) => {
          if (String(file) === target && (reads += 1) === failOnRead) return Promise.reject(denied);
          return (real as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
        }) as typeof fs.readFile);
        let stats;
        try {
          stats = await ingest(projectId, root);
        } finally {
          spy.mockRestore();
        }
        expect(stats.filesUpgradeFailed, `read ${failOnRead}`).toEqual([
          "internal/storage/storage.go",
        ]);
        expect(stats.filesUpgraded, `read ${failOnRead}`).toBe(3);
        // No content hash: nothing says the file would fail again.
        expect(await upgradeFailed(projectId)).toEqual({ "internal/storage/storage.go": null });

        const retry = await ingest(projectId, root);
        expect(retry.filesUpgraded, `read ${failOnRead}`).toBe(1);
        expect(retry.filesUpgradeFailed).toEqual([]);
        expect(await upgradeFailed(projectId)).toBeNull();
        await downgrade(projectId);
      }
    });

    it("retries a remembered file recorded under ANOTHER content hash, and forgets a deleted one", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          extractorUpgradeFailed: JSON.stringify({
            "internal/storage/storage.go": "0".repeat(64),
            "internal/gone/gone.go": "1".repeat(64),
          }),
        },
      });
      const stats = await ingest(projectId, root);
      expect(stats.filesUpgraded).toBe(1);
      expect(stats.filesUpgradeFailed).toEqual([]);
      expect(await upgradeFailed(projectId)).toBeNull();
    });

    it("ignores a corrupt failure list rather than failing the ingest", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      for (const stored of ["{not json", "[1,2]", "null", '"text"']) {
        await db.codeGraph.updateMany({
          where: { projectId },
          data: { extractorUpgradeFailed: stored },
        });
        const stats = await ingest(projectId, root);
        expect(stats.filesUpgradeFailed).toEqual([]);
        expect(await upgradeFailed(projectId)).toBeNull();
      }
    });

    it("records WHEN an upgrade rewrote the graph, and only then", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      const at = async () =>
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).extractorUpgradedAt;
      // A full ingest writes the current shape: nothing was upgraded in place.
      expect(await at()).toBeNull();
      await ingest(projectId, root);
      expect(await at()).toBeNull();
      await downgrade(projectId);
      const before = Date.now();
      const stats = await ingest(projectId, root);
      expect(stats.filesUpgraded).toBe(4);
      const first = await at();
      expect(first).not.toBeNull();
      expect(first!.getTime()).toBeGreaterThanOrEqual(before);
      // A later ingest that upgrades nothing leaves the mark where it was.
      await applyTree(root, { "internal/api/entry.go": `${HANDLER}\nfunc extra() {}\n` });
      await ingest(projectId, root);
      expect((await at())!.getTime()).toBe(first!.getTime());
    });

    it("a Go file the ignore rules hide leaves its directory incomplete: nothing there is `external`", async () => {
      const { projectId, root } = await newProject();
      const tree: Tree = {
        "go.mod": GO_MOD,
        ".metisignore": "*_gen.go\n",
        "internal/ign/a.go": 'package ign\n\nfunc Hand() {\n\tmade()\n\tMade()\n\tlen("x")\n}\n',
        "internal/ign/a_gen.go": "package ign\n\nfunc made() {}\nfunc Made() {}\n",
        "internal/use/u.go":
          'package use\n\nimport "example.com/app/internal/ign"\n\nfunc U() {\n\tign.Made()\n\tign.Hand()\n}\n',
      };
      await applyTree(root, tree);
      await ingest(projectId, root, false);
      const got = await calls(projectId);
      // The generated file declares them; the walk never read it.
      expect(got).toContain("internal/ign/a.go::Hand > made → NULL (-)");
      expect(got).toContain("internal/ign/a.go::Hand > Made → NULL (-)");
      expect(got).toContain("internal/use/u.go::U > Made → NULL (-)");
      // What the read files DO decide is unaffected.
      expect(got).toContain("internal/ign/a.go::Hand > len → NULL (external)");
      expect(got).toContain("internal/use/u.go::U > Hand → internal/ign/a.go::Hand (package)");

      // Control: without the ignore rule the same names bind.
      const open = await newProject();
      await applyTree(open.root, { ...tree, ".metisignore": "# nothing\n" });
      await ingest(open.projectId, open.root, false);
      const bound = await calls(open.projectId);
      expect(bound).toContain(
        "internal/ign/a.go::Hand > made → internal/ign/a_gen.go::made (same-package)",
      );
      expect(bound).toContain(
        "internal/use/u.go::U > Made → internal/ign/a_gen.go::Made (package)",
      );

      // Control: an ignored file that is not Go weakens nothing either.
      const text = await newProject();
      await applyTree(text.root, {
        ...tree,
        ".metisignore": "*.txt\n",
        "internal/ign/a_gen.go": null,
        "internal/ign/notes.txt": "not Go",
      });
      await ingest(text.projectId, text.root, false);
      expect(await calls(text.projectId)).toContain(
        "internal/ign/a.go::Hand > made → NULL (external)",
      );

      // Control: an ignored DIRECTORY is another package's and weakens nothing.
      const dir = await newProject();
      await applyTree(dir.root, {
        ...tree,
        ".metisignore": "gen/\n",
        "internal/ign/a_gen.go": null,
        "internal/ign/gen/x.go": "package gen\n\nfunc made() {}\n",
      });
      await ingest(dir.projectId, dir.root, false);
      expect(await calls(dir.projectId)).toContain(
        "internal/ign/a.go::Hand > made → NULL (external)",
      );
    });

    it("leaves every remaining call undecided by type once the step's time ceiling is reached, and says so", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      const stats = await ingestCodeGraph(db, {
        projectId,
        rootDir: root,
        incremental: false,
        sqlLineageOverride: false,
        // Building the resolver alone takes more than no time at all — and no
        // minimum number of calls is let through first.
        goBindingMaxMs: -1,
        goBindingMinCalls: 0,
      });
      expect(stats.goBinding).toMatchObject({
        calls: 5,
        skipped: 5,
        errors: 0,
        overBudget: 0,
        incomplete: { files: 1, calls: 5 },
      });
      const got = await calls(projectId);
      // Nothing is decided by type: no verdict, and no type binding.
      expect(
        got.filter((c) => /\((receiver-type|package|same-package|external|interface)\)$/.test(c)),
      ).toEqual([]);
      // The name-evidence rules still ran, as before #1071, and say so.
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > describe → internal/api/entry.go::describe (name)",
      );

      // Control: with the default ceiling nothing is skipped, and the next
      // ingest decides what the short one left — no Go file has to change
      // (`code-graph-go-binding-incomplete-1071.sqlite.test.ts`).
      const full = await ingest(projectId, root);
      expect(full.goBinding).toMatchObject({
        skipped: 0,
        errors: 0,
        overBudget: 0,
        resumedFiles: 1,
        incomplete: null,
      });
      expect(await calls(projectId)).toContain(
        "internal/api/entry.go::handler::updateEntries > SetEntriesStatus → " +
          "internal/storage/storage.go::Storage::SetEntriesStatus (receiver-type)",
      );
    });

    it("counts a call the resolver gave up on (its step budget) apart from errors, and never decides it", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        "go.mod": GO_MOD,
        // 330 types a level, three levels: W's member set is far past the budget.
        "wide/wide.go": goLattice(330, 3, 4),
        "wide/ok.go":
          "package wide\n\ntype Small struct{}\n\nfunc (s *Small) N0() {}\n\nfunc g(s *Small) {\n\ts.N0()\n}\n",
      });
      const stats = await ingest(projectId, root, false);
      expect(stats.goBinding).toMatchObject({ calls: 5, overBudget: 4, errors: 0, skipped: 0 });
      expect(stats.goBinding!.failures).toEqual([]);
      const got = await calls(projectId);
      // `w.N0()` on the over-budget type: undecided by type. The one `N0` the
      // FILE'S OWN package declares elsewhere is not in this file, so no name binds.
      expect(got).toContain("wide/wide.go::f > N0 → NULL (-)");
      expect(got).toContain("wide/ok.go::g > N0 → wide/ok.go::Small::N0 (receiver-type)");
    });

    it("stamps the version on a graph already current although a NEW file cannot be parsed", async () => {
      // Nothing is being upgraded, and the new file has no older rows to bring up.
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await applyTree(root, { "internal/storage/deep.go": UNPARSEABLE });
      const stats = await ingest(projectId, root);
      expect(stats.filesUnparseable).toEqual(["internal/storage/deep.go"]);
      expect(stats.filesUpgradeFailed).toEqual([]);
      expect((await db.codeGraph.findFirstOrThrow({ where: { projectId } })).extractorVersion).toBe(
        CODE_GRAPH_EXTRACTOR_VERSION,
      );
    });

    it("renames the stored impact rows that keep a qualified name as text", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await downgrade(projectId);
      const method = await db.codeSymbol.findFirstOrThrow({
        where: { projectId, name: "SetEntriesStatus", filePath: "internal/storage/storage.go" },
      });
      const other = await newProject();
      const analysis = await db.impactAnalysis.create({ data: { startedById: "u-1071" } });
      const item = await db.impactItem.create({
        data: { impactAnalysisId: analysis.id, projectId },
      });
      const elsewhere = await db.impactItem.create({
        data: { impactAnalysisId: analysis.id, projectId: other.projectId },
      });
      const old = "internal/storage/storage.go::SetEntriesStatus";
      const affected = await db.impactAffectedSymbol.create({
        data: {
          impactItemId: item.id,
          codeSymbolId: method.id,
          filePath: method.filePath,
          qualifiedName: old,
        },
      });
      const proposal = (
        impactItemId: string,
        writerStartLine: number,
        writerFilePath = method.filePath,
      ) =>
        db.impactColumnProposal.create({
          data: {
            impactItemId,
            disposition: "optional",
            tableName: "entries",
            columnName: "read_at",
            reason: "r",
            writerQualifiedName: old,
            writerFilePath,
            writerStartLine,
          },
        });
      const mine = await proposal(item.id, method.startLine);
      const otherLine = await proposal(item.id, method.startLine + 1);
      const otherProject = await proposal(elsewhere.id, method.startLine);
      const otherFile = await proposal(item.id, method.startLine, "internal/cache/cache.go");

      await ingest(projectId, root);

      const renamed = "internal/storage/storage.go::Storage::SetEntriesStatus";
      expect(
        (await db.impactAffectedSymbol.findUniqueOrThrow({ where: { id: affected.id } }))
          .qualifiedName,
      ).toBe(renamed);
      const writer = async (id: string) =>
        (await db.impactColumnProposal.findUniqueOrThrow({ where: { id } })).writerQualifiedName;
      expect(await writer(mine.id)).toBe(renamed);
      // Another symbol of that name (another line), and another project's run, are not this symbol.
      expect(await writer(otherLine.id)).toBe(old);
      expect(await writer(otherProject.id)).toBe(old);
      // Nor is a proposal recorded against another file.
      expect(await writer(otherFile.id)).toBe(old);
    });

    it("an upgrade moves the graph's mark with EVERY write it makes, and reads the proposals table once", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await downgrade(projectId);
      const marks: number[] = [];
      let proposalReads = 0;
      let proposalWrites = 0;
      const watched = db.$extends({
        query: {
          codeGraph: {
            update({ args, query }) {
              const at = (args.data as { extractorUpgradedAt?: unknown }).extractorUpgradedAt;
              if (at instanceof Date) marks.push(at.getTime());
              return query(args);
            },
          },
          impactColumnProposal: {
            findMany({ args, query }) {
              proposalReads += 1;
              return query(args);
            },
            updateMany({ args, query }) {
              proposalWrites += 1;
              return query(args);
            },
          },
        },
      });

      const stats = await ingestCodeGraph(watched as unknown as PrismaClient, {
        projectId,
        rootDir: root,
        incremental: true,
        sqlLineageOverride: false,
      });

      expect(stats.filesUpgraded).toBe(4);
      // Three of the four files declare a method, whose name the upgrade
      // rewrites; all four have parser edges, which it replaces. Seven writes,
      // seven marks: whoever sees rows of this graph change sees the mark move.
      expect(marks).toHaveLength(7);
      for (let i = 1; i < marks.length; i += 1) expect(marks[i]).toBeGreaterThan(marks[i - 1]);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      expect(graph.extractorUpgradedAt?.getTime()).toBe(marks.at(-1));
      // The proposals table has no index on the writer: one read for the whole
      // upgrade, and no write at all when no proposal names a renamed symbol.
      expect(proposalReads).toBe(1);
      expect(proposalWrites).toBe(0);
    });

    it("a failure mid-upgrade leaves every file with edges, old or new, and the next ingest finishes", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, BASE);
      await ingest(projectId, root, false);
      await downgrade(projectId);
      const edgesPerFile = async () => {
        const rows = await db.codeEdge.groupBy({
          by: ["filePath"],
          where: { projectId, source: null },
          _count: { _all: true },
        });
        return new Map(rows.map((r) => [r.filePath, r._count._all]));
      };
      const before = await edgesPerFile();
      expect(before.size).toBe(4);

      // Fail the upgrade when it reaches the third Go file's edges.
      let inserts = 0;
      const failing = db.$extends({
        query: {
          codeEdge: {
            createMany({ args, query }) {
              inserts += 1;
              if (inserts === 3) throw new Error("disk full");
              return query(args);
            },
          },
        },
      });
      await expect(
        ingestCodeGraph(failing as unknown as PrismaClient, {
          projectId,
          rootDir: root,
          incremental: true,
          sqlLineageOverride: false,
        }),
      ).rejects.toThrow("disk full");

      // No file lost its edges: deleting them all first would leave two files empty.
      expect(await edgesPerFile()).toEqual(before);
      expect(
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).extractorVersion,
      ).toBeNull();

      const stats = await ingest(projectId, root);
      expect(stats.filesUpgraded).toBe(4);
      const fresh = await newProject();
      await applyTree(fresh.root, BASE);
      await ingest(fresh.projectId, fresh.root, false);
      expect(await calls(projectId)).toEqual(await calls(fresh.projectId));
    });

    it("schema impact: a method's same-file helper keeps its reads; a call into another file keeps only writes", async () => {
      const { projectId, root } = await newProject();
      await applyTree(root, {
        "go.mod": GO_MOD,
        // One unit of data access: `Entries` reads through its own type's helper.
        "internal/storage/pager.go": `package storage

type Pager struct{}

func (p *Pager) Entries() { p.fetch() }
func (p *Pager) fetch()   {}
`,
        "internal/storage/user.go": `package storage

func (p *Pager) Touch() {}
`,
        // A handler reaching into storage: the #791 shape.
        "internal/api/handler.go": `package api

import "example.com/app/internal/storage"

type handler struct{ pager *storage.Pager }

func (h *handler) list()  { h.pager.Touch() }
func (h *handler) other() { h.pager.fetch() }
`,
        // The same package, another file: still a crossing under the rule shipped.
        "internal/storage/report.go": `package storage

func (p *Pager) Report() { p.Touch() }
`,
      });
      await ingest(projectId, root, false);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      const sym = async (qualifiedName: string) =>
        (await db.codeSymbol.findFirstOrThrow({ where: { projectId, qualifiedName } })).id;
      const table = async (name: string) =>
        (
          await db.codeSymbol.create({
            data: {
              codeGraphId: graph.id,
              projectId,
              kind: "table",
              name,
              qualifiedName: name,
              filePath: "schema.sql",
              startLine: 1,
              endLine: 1,
              language: "sql",
              contentHash: name,
              source: "sqlglot",
            },
          })
        ).id;
      const touches = async (from: string, to: string, kind: "reads" | "writes") =>
        db.codeEdge.create({
          data: {
            codeGraphId: graph.id,
            projectId,
            kind,
            fromSymbolId: from,
            toSymbolId: to,
            toQualifiedName: null,
            filePath: "internal/storage/pager.go",
            line: 1,
            source: "sqlglot",
          },
        });
      const fetch = await sym("internal/storage/pager.go::Pager::fetch");
      const touch = await sym("internal/storage/user.go::Pager::Touch");
      await touches(fetch, await table("entries"), "reads");
      await touches(touch, await table("users"), "reads");
      await touches(touch, await table("audit"), "writes");

      // The premise: all four calls are bound by the receiver's type.
      const bound = (await calls(projectId)).map((c) =>
        c.replace(/internal\/(storage|api)\//g, ""),
      );
      expect(bound).toEqual([
        "handler.go::handler::list > Touch → user.go::Pager::Touch (receiver-type)",
        "handler.go::handler::other > fetch → pager.go::Pager::fetch (receiver-type)",
        "pager.go::Pager::Entries > fetch → pager.go::Pager::fetch (receiver-type)",
        "report.go::Pager::Report > Touch → user.go::Pager::Touch (receiver-type)",
      ]);

      const ds = new PrismaSchemaImpactDataSource(db, projectId);
      const tables = async (seed: string) =>
        (await crossToSchema([await sym(seed)], ds)).map((r) => r.tableName).sort();
      // Same file: the helper's read is the caller's read.
      expect(await tables("internal/storage/pager.go::Pager::Entries")).toEqual(["entries"]);
      // Another file: what the callee writes, not what it reads.
      expect(await tables("internal/api/handler.go::handler::list")).toEqual(["audit"]);
      expect(await tables("internal/api/handler.go::handler::other")).toEqual([]);
      expect(await tables("internal/storage/report.go::Pager::Report")).toEqual(["audit"]);
    });
  },
);

describe("#1071 — extractorUpgradeLanguages", () => {
  it("upgrades Go for a graph with no recorded version, and nothing for a current one", () => {
    expect([...extractorUpgradeLanguages(null)]).toEqual(["go"]);
    expect([...extractorUpgradeLanguages(0)]).toEqual(["go"]);
    expect([...extractorUpgradeLanguages(CODE_GRAPH_EXTRACTOR_VERSION)]).toEqual([]);
  });
});
