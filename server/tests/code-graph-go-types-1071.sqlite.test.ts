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
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  extractorUpgradeLanguages,
  ingestCodeGraph,
} from "../src/lib/code-graph/ingest.js";
import { GO_RESOLUTION_KEY } from "../src/lib/code-graph/go-type-resolution.js";
import { loadResolvedGoCalls } from "../src/lib/impact-analysis/go-call-resolution.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

type Tree = Record<string, string | null>;

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
      expect(got).toContain(
        "internal/api/entry.go::handler::updateEntries > WriteHeader → NULL (external)",
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
        // The only `Read` and the only `WriteHeader` in the project: by name
        // alone, both calls in entry.go have exactly one candidate.
        "internal/api/disk.go": `package api

type disk struct{}

func (d *disk) Read() error      { return nil }
func (d *disk) WriteHeader(int)  {}
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
      expect(bound).toEqual(["internal/api/disk.go::disk::Read"]);
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
  },
);

describe("#1071 — extractorUpgradeLanguages", () => {
  it("upgrades Go for a graph with no recorded version, and nothing for a current one", () => {
    expect([...extractorUpgradeLanguages(null)]).toEqual(["go"]);
    expect([...extractorUpgradeLanguages(0)]).toEqual(["go"]);
    expect([...extractorUpgradeLanguages(CODE_GRAPH_EXTRACTOR_VERSION)]).toEqual([]);
  });
});
