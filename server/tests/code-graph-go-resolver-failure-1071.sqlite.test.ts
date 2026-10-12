/**
 * #1071 (review of PR #1104) — resolving one Go call must not be able to fail
 * the ingest.
 *
 * `resolveCall` sits between a resolver bug and `ingestCodeGraph` rejecting. The
 * bug the review found (a cycle of package variables overflowing the stack) is
 * fixed in the resolver and tested there; this file is about the second layer:
 * WHATEVER the resolver throws, the ingest completes, the one call is left
 * UNDECIDED — never a decided verdict, which every later reader would trust —
 * and the failure is counted in the stats.
 *
 * The resolver is the real one, wrapped so that chosen calls throw.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const failure = vi.hoisted(() => ({
  /** Callee names whose resolution throws. */
  throwOn: new Set<string>(),
  /** When true, the resolver cannot even be built. */
  build: false,
}));

vi.mock("../src/lib/code-graph/go-type-resolution.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/go-type-resolution.js")>();
  return {
    ...actual,
    createGoResolver: (...args: Parameters<typeof actual.createGoResolver>) => {
      if (failure.build) throw new Error("resolver could not be built");
      const real = actual.createGoResolver(...args);
      return {
        resolveCall(filePath: string, callee: Parameters<typeof real.resolveCall>[1]) {
          if (callee.e === "sel" && failure.throwOn.has(callee.name)) {
            throw new RangeError("Maximum call stack size exceeded");
          }
          return real.resolveCall(filePath, callee);
        },
      };
    },
  };
});

const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");

const TREE: Record<string, string> = {
  "go.mod": "module example.com/app\n\ngo 1.24\n",
  "internal/storage/storage.go": `package storage

type Storage struct{}

func NewStorage() *Storage { return &Storage{} }

func (s *Storage) Save() error  { return nil }
func (s *Storage) Close() error { return nil }
`,
  // `Close` has a name-bindable candidate in the caller's own file, so a throw
  // that fell back to a DECIDED verdict would show as `(external)` and one that
  // is left undecided shows what the name-evidence rules make of it.
  "internal/api/api.go": `package api

import "example.com/app/internal/storage"

type handler struct{ store *storage.Storage }

type conn struct{}

func (c *conn) Close() {}

func (h *handler) run() {
	h.store.Save()
	h.store.Close()
}
`,
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1071 — a resolver failure degrades one edge, never the ingest",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1071-resolver-failure");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1071-fail-"));
      await db.user.create({
        data: {
          id: "u-fail",
          username: "u-fail",
          displayName: "u-fail",
          email: "u-fail@example.test",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    beforeEach(() => {
      failure.throwOn.clear();
      failure.build = false;
    });

    const ingestTree = async () => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `pfail-${seq}`, slug: `pfail-${seq}`, createdById: "u-fail" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      for (const [rel, content] of Object.entries(TREE)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content, "utf8");
      }
      const stats = await ingestCodeGraph(db, {
        projectId: project.id,
        rootDir: root,
        incremental: false,
        sqlLineageOverride: false,
      });
      const edges = await db.codeEdge.findMany({
        where: { projectId: project.id, kind: "calls" },
        include: { toSymbol: { select: { qualifiedName: true } } },
      });
      const calls = edges
        .map(
          (e) =>
            `${e.toQualifiedName} → ${e.toSymbol?.qualifiedName ?? "NULL"} ${e.metadata ?? "-"}`,
        )
        .sort();
      return { stats, calls };
    };

    it("control: with no failure both calls bind by type and nothing is counted", async () => {
      const { stats, calls } = await ingestTree();
      expect(stats.goBinding).toMatchObject({ files: 2, calls: 2, errors: 0 });
      expect(stats.goBinding!.failures).toEqual([]);
      expect(calls).toEqual([
        'Close → internal/storage/storage.go::Storage::Close {"goResolution":"receiver-type"}',
        'Save → internal/storage/storage.go::Storage::Save {"goResolution":"receiver-type"}',
      ]);
    });

    it("a throw on one call leaves that call undecided, binds the rest and is counted", async () => {
      failure.throwOn.add("Save");
      const { stats, calls } = await ingestTree();

      expect(stats.goBinding).toMatchObject({ calls: 2, errors: 1, overBudget: 0, skipped: 0 });
      // Named, so a resolver bug can be found from the stats or the log line.
      expect(stats.goBinding!.failures).toEqual(["internal/api/api.go:12 Save"]);
      expect(calls).toEqual([
        'Close → internal/storage/storage.go::Storage::Close {"goResolution":"receiver-type"}',
        // No verdict recorded: the fallback readers may still look for it by name.
        "Save → NULL -",
      ]);
    });

    it("an undecided call is open to the name-evidence rules, exactly as an unknown receiver is", async () => {
      failure.throwOn.add("Close");
      const { stats, calls } = await ingestTree();

      expect(stats.goBinding?.errors).toBe(1);
      // Bound by NAME to the same-file member, and labelled as such: not a
      // decided `external`, and not passed off as a type binding.
      expect(calls).toContain('Close → internal/api/api.go::conn::Close {"goResolution":"name"}');
    });

    it("names both calls when both throw, in the order they were resolved", async () => {
      failure.throwOn.add("Save");
      failure.throwOn.add("Close");
      const { stats } = await ingestTree();
      expect(stats.goBinding?.errors).toBe(2);
      expect(stats.goBinding!.failures).toEqual([
        "internal/api/api.go:12 Save",
        "internal/api/api.go:13 Close",
      ]);
    });

    it("a resolver that cannot be built leaves every call to the name rules, and is counted", async () => {
      failure.build = true;
      const { stats, calls } = await ingestTree();

      expect(stats.goBinding).toMatchObject({ files: 2, calls: 0, errors: 1 });
      expect(stats.goBinding!.failures).toEqual(["(the resolver could not be built)"]);
      expect(calls).toEqual(["Close → internal/api/api.go::conn::Close -", "Save → NULL -"]);
    });
  },
);
