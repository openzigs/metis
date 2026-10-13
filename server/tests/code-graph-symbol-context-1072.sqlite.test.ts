/**
 * #1072 — ingest stores what a symbol's own file says about it, builds the
 * embedding text with it, and brings a graph written before the columns
 * existed up to date WITHOUT re-creating a row.
 *
 * Proven against a real SQLite database built from the migration chain, because
 * every claim here is about rows:
 *
 *   1. a full ingest writes the four context columns and an embedding text that
 *      carries the `package:` and `doc:` lines;
 *   2. the next incremental ingest of an OLDER graph fills the columns in on the
 *      existing rows (every id survives), rewrites exactly the embedding texts
 *      that change and marks those pending, and records the version;
 *   3. the ingest after that does nothing: no symbol is marked pending again;
 *   4. the result equals a full ingest of the same tree, row for row;
 *   5. while a file of the graph cannot be read, the version is not recorded.
 */
import { createHash } from "node:crypto";
import { promises as fs, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backfillSymbolContext,
  ingestCodeGraph,
  SYMBOL_CONTEXT_VERSION,
} from "../src/lib/code-graph/ingest.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const USERS_TS = `import { write } from "./io";

/**
 * Persists a member so that later logins find the account.
 */
export function saveUser(user: User): void {
  write(user);
}

export function plain(a: number): number {
  return a;
}
`;

const IO_TS = `export function write(row: unknown): void {
  void row;
}
`;

// At the repository root: no directory, so no package; and no comment.
const MAIN_TS = `export function main(): void {
  return;
}
`;

const STORAGE_GO = `package storage

type Storage struct{}

// Save stores the user.
func (s *Storage) Save() error { return nil }
`;

const TREE: Record<string, string> = {
  "go.mod": "module example.com/app\n\ngo 1.24\n",
  "src/store/users.ts": USERS_TS,
  "src/store/io.ts": IO_TS,
  "main.ts": MAIN_TS,
  "internal/db/storage.go": STORAGE_GO,
};

/** The model tag the fixture gives a symbol that "has been embedded". */
const EMBEDDED = "fixture-model";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1072 — symbol context columns and their backfill",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1072-symbol-context");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1072-"));
      await db.user.create({
        data: {
          id: "u-1072",
          username: "u-1072",
          displayName: "u-1072",
          email: "u-1072@example.test",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    const newProject = async (
      tree: Record<string, string> = TREE,
    ): Promise<{ projectId: string; root: string }> => {
      seq += 1;
      const p = await db.project.create({
        data: { name: `p1072-${seq}`, slug: `p1072-${seq}`, createdById: "u-1072" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      for (const [rel, content] of Object.entries(tree)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content, "utf8");
      }
      return { projectId: p.id, root };
    };

    const ingest = (projectId: string, root: string, incremental = true) =>
      ingestCodeGraph(db, { projectId, rootDir: root, incremental, sqlLineageOverride: false });

    /** Every symbol as `path|kind|name` → its context columns, text and model tag. */
    const snapshot = async (projectId: string) => {
      const rows = await db.codeSymbol.findMany({
        where: { projectId },
        include: { embedding: true },
        orderBy: [{ filePath: "asc" }, { startLine: "asc" }, { kind: "asc" }],
      });
      return new Map(
        rows.map((r) => [
          `${r.filePath}|${r.kind}|${r.name}`,
          {
            id: r.id,
            signature: r.signature,
            docComment: r.docComment,
            receiver: r.receiver,
            package: r.package,
            text: r.embedding?.text ?? null,
            contentHash: r.embedding?.contentHash ?? null,
            embeddingModel: r.embedding?.embeddingModel ?? null,
          },
        ]),
      );
    };

    /** The text main embedded before #1072: the stored one without its context lines. */
    const withoutContextLines = (text: string): string =>
      text
        .split("\n")
        .filter((line, i) => i === 0 || !(line.startsWith("package: ") || line.startsWith("doc: ")))
        .join("\n");

    /**
     * Put a graph back to how a pre-#1072 ingest left it: no context columns, no
     * version, the old embedding text, and every symbol already embedded.
     */
    const downgrade = async (projectId: string): Promise<void> => {
      await db.codeSymbol.updateMany({
        where: { projectId },
        data: { signature: null, docComment: null, receiver: null, package: null },
      });
      for (const row of await db.codeSymbolEmbedding.findMany({ where: { projectId } })) {
        const text = withoutContextLines(row.text);
        await db.codeSymbolEmbedding.update({
          where: { id: row.id },
          data: { text, contentHash: sha256(text), embeddingModel: EMBEDDED },
        });
      }
      await db.codeGraph.updateMany({ where: { projectId }, data: { symbolContextVersion: null } });
    };

    const markAllEmbedded = (projectId: string) =>
      db.codeSymbolEmbedding.updateMany({
        where: { projectId },
        data: { embeddingModel: EMBEDDED },
      });

    it("a full ingest stores the context columns", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const got = await snapshot(projectId);

      expect(got.get("src/store/users.ts|function|saveUser")).toMatchObject({
        signature: "export function saveUser(user: User): void",
        docComment: "Persists a member so that later logins find the account.",
        receiver: null,
        package: "store",
      });
      expect(got.get("src/store/users.ts|function|plain")).toMatchObject({
        signature: "export function plain(a: number): number",
        docComment: null,
        package: "store",
      });
      expect(got.get("main.ts|function|main")).toMatchObject({
        signature: "export function main(): void",
        docComment: null,
        package: null,
      });
      expect(got.get("internal/db/storage.go|function|Save")).toMatchObject({
        signature: "func (s *Storage) Save() error",
        docComment: "Save stores the user.",
        receiver: "Storage",
        // The declared package, not the directory (`db`).
        package: "storage",
      });
    });

    it("a file's module symbol gets no context, and its embedding text is as before #1072", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const mod = (await snapshot(projectId)).get("src/store/users.ts|module|users.ts");
      expect(mod).toMatchObject({
        signature: null,
        docComment: null,
        receiver: null,
        package: null,
      });
      expect(mod?.text?.split("\n").slice(0, 2)).toEqual([
        "module users.ts in src/store/users.ts",
        'import { write } from "./io";',
      ]);
    });

    it("builds the embedding text with the package and doc lines, hashed and pending", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const got = await snapshot(projectId);
      const save = got.get("src/store/users.ts|function|saveUser");
      expect(save?.text).toBe(
        [
          "function saveUser in src/store/users.ts",
          "package: store",
          "doc: Persists a member so that later logins find the account.",
          "export function saveUser(user: User): void {",
          "  write(user);",
          "}",
        ].join("\n"),
      );
      expect(save?.contentHash).toBe(sha256(save?.text ?? ""));
      expect(save?.embeddingModel).toBe("");
      // No receiver line: the receiver is stored and is in no document.
      expect(got.get("internal/db/storage.go|function|Save")?.text).toBe(
        [
          "function Save in internal/db/storage.go",
          "package: storage",
          "doc: Save stores the user.",
          "func (s *Storage) Save() error { return nil }",
        ].join("\n"),
      );
      // Nothing to add: the text is the one main built.
      expect(got.get("main.ts|function|main")?.text).toBe(
        "function main in main.ts\nexport function main(): void {\n  return;\n}",
      );
    });

    it("records the context version on a new graph and on a full ingest", async () => {
      const { projectId, root } = await newProject();
      const stats = await ingest(projectId, root);
      expect(stats.symbolContextBackfill).toBeUndefined();
      expect(
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
      ).toBe(SYMBOL_CONTEXT_VERSION);

      await downgrade(projectId);
      const full = await ingest(projectId, root, false);
      expect(full.symbolContextBackfill).toBeUndefined();
      expect(
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
      ).toBe(SYMBOL_CONTEXT_VERSION);
    });

    it("fills an older graph in on its next incremental ingest, on the existing rows", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const fresh = await snapshot(projectId);
      await downgrade(projectId);
      const before = await snapshot(projectId);
      expect(before.get("src/store/users.ts|function|saveUser")?.docComment).toBeNull();

      const stats = await ingest(projectId, root);

      // Nothing was re-parsed: every file is unchanged.
      expect(stats.filesParsed).toBe(0);
      // 4 files have a module row with no context; the 6 other symbols get columns,
      // `main` among them (its signature). `Storage` (a Go struct) is the sixth.
      expect(stats.symbolContextBackfill).toEqual({
        symbols: 6,
        embeddingTexts: 5,
        failedFiles: 0,
      });
      const after = await snapshot(projectId);
      expect([...after.keys()]).toEqual([...fresh.keys()]);
      for (const [key, row] of after) {
        const want = fresh.get(key);
        // Row for row what a full ingest writes — and the SAME row it was.
        expect({ ...row, id: undefined, embeddingModel: undefined }, key).toEqual({
          ...want,
          id: undefined,
          embeddingModel: undefined,
        });
        expect(row.id, key).toBe(before.get(key)?.id);
      }
      expect(
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
      ).toBe(SYMBOL_CONTEXT_VERSION);
    });

    it("marks pending exactly the symbols whose embedding text changed", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      await downgrade(projectId);

      await ingest(projectId, root);

      const after = await snapshot(projectId);
      const pending = [...after].filter(([, r]) => r.embeddingModel === "").map(([k]) => k);
      expect(pending.sort()).toEqual(
        [
          "internal/db/storage.go|function|Save",
          "internal/db/storage.go|class|Storage",
          "src/store/io.ts|function|write",
          "src/store/users.ts|function|plain",
          "src/store/users.ts|function|saveUser",
        ].sort(),
      );
      // `main` gained a signature column but no line of its text changed, and a
      // module's text never changes: both keep the vector they have.
      expect(after.get("main.ts|function|main")?.embeddingModel).toBe(EMBEDDED);
      expect(after.get("src/store/users.ts|module|users.ts")?.embeddingModel).toBe(EMBEDDED);
      for (const key of pending) {
        expect(after.get(key)?.contentHash, key).toBe(sha256(after.get(key)?.text ?? ""));
      }
    });

    it("does nothing on the ingest after: no symbol is embedded a second time", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      await downgrade(projectId);
      await ingest(projectId, root);
      // The embed job ran.
      await markAllEmbedded(projectId);
      const settled = await snapshot(projectId);

      const stats = await ingest(projectId, root);

      expect(stats.symbolContextBackfill).toBeUndefined();
      expect(await snapshot(projectId)).toEqual(settled);
    });

    it("re-embeds only the changed file's symbols when one file changes later", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      await markAllEmbedded(projectId);
      await fs.writeFile(path.join(root, "src/store/io.ts"), `${IO_TS}\n// touched\n`, "utf8");

      const stats = await ingest(projectId, root);

      expect(stats.filesParsed).toBe(1);
      expect(stats.symbolContextBackfill).toBeUndefined();
      const after = await snapshot(projectId);
      for (const [key, row] of after) {
        expect(row.embeddingModel, key).toBe(key.startsWith("src/store/io.ts|") ? "" : EMBEDDED);
      }
    });

    it.each(["signature", "docComment", "receiver", "package"] as const)(
      "rewrites a row whose only difference is its %s",
      async (column) => {
        const { projectId, root } = await newProject();
        await ingest(projectId, root, false);
        const fresh = await snapshot(projectId);
        // One Go method has all four columns set. Make ONE of them stale.
        const key = "internal/db/storage.go|function|Save";
        await db.codeSymbol.update({
          where: { id: fresh.get(key)?.id },
          data: { [column]: "stale" },
        });
        await db.codeGraph.updateMany({
          where: { projectId },
          data: { symbolContextVersion: null },
        });

        const stats = await ingest(projectId, root);

        expect(stats.symbolContextBackfill?.symbols).toBe(1);
        expect((await snapshot(projectId)).get(key)).toEqual(fresh.get(key));
      },
    );

    it("does not record the version when a file changes between the walk and the backfill", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      await downgrade(projectId);
      const edited = path.join(root, "src/store/io.ts");
      let calls = 0;

      // `goBindingNow` is read once pass 2 starts: after the walk hashed every
      // file and before the backfill reads them again.
      const stats = await ingestCodeGraph(db, {
        projectId,
        rootDir: root,
        incremental: true,
        sqlLineageOverride: false,
        goBindingNow: () => {
          calls += 1;
          if (calls === 1) writeFileSync(edited, `${IO_TS}\nexport const later = 1;\n`, "utf8");
          return performance.now();
        },
      });

      expect(calls).toBeGreaterThan(0);
      expect(stats.symbolContextBackfill?.failedFiles).toBe(1);
      expect(
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
      ).toBeNull();
      // The file's rows describe the old content and were left as they were.
      expect((await snapshot(projectId)).get("src/store/io.ts|function|write")?.package).toBeNull();

      // The next ingest sees the file as changed, re-parses it, and finishes.
      const again = await ingest(projectId, root);
      expect(again.filesParsed).toBe(1);
      expect(again.symbolContextBackfill?.failedFiles).toBe(0);
      expect(
        (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
      ).toBe(SYMBOL_CONTEXT_VERSION);
      expect((await snapshot(projectId)).get("src/store/io.ts|function|write")?.package).toBe(
        "store",
      );
    });

    it("is idempotent when run again over rows that are already current", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      await markAllEmbedded(projectId);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      await db.codeGraph.update({ where: { id: graph.id }, data: { symbolContextVersion: null } });
      const settled = await snapshot(projectId);

      const stats = await ingest(projectId, root);

      expect(stats.symbolContextBackfill).toEqual({
        symbols: 0,
        embeddingTexts: 0,
        failedFiles: 0,
      });
      expect(await snapshot(projectId)).toEqual(settled);
    });

    it("leaves a schema symbol filed under a source file alone", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      const table = await db.codeSymbol.create({
        data: {
          codeGraphId: graph.id,
          projectId,
          kind: "table",
          name: "users",
          qualifiedName: "users",
          filePath: "src/store/users.ts",
          startLine: 6,
          endLine: 6,
          language: "sql",
          contentHash: "x",
          source: "orm",
        },
      });
      await downgrade(projectId);

      await ingest(projectId, root);

      expect(await db.codeSymbol.findUniqueOrThrow({ where: { id: table.id } })).toMatchObject({
        signature: null,
        docComment: null,
        package: null,
      });
    });

    // PR #1126 review — in the test above the row's language is `sql` and the
    // file's is `ts`, so the `language` predicate alone kept the backfill off
    // it and dropping `source: null` from the filter changed nothing. Each row
    // here is kept out by exactly ONE of the two predicates.
    it("leaves a schema-pass row alone by its provenance, and a foreign-language row by its language", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      const row = (name: string, language: string, source: "orm" | null) =>
        db.codeSymbol.create({
          data: {
            codeGraphId: graph.id,
            projectId,
            kind: "table",
            name,
            qualifiedName: name,
            filePath: "src/store/users.ts",
            // The line of `export function saveUser(...)`: a signature to read.
            startLine: 6,
            endLine: 6,
            language,
            contentHash: "x",
            source,
          },
        });
      // Same language as the file: only `source` tells it from a parser symbol.
      const tagged = await row("users_by_provenance", "ts", "orm");
      // No provenance: only the language tells it from a parser symbol.
      const foreign = await row("users_by_language", "sql", null);
      await downgrade(projectId);

      const stats = await ingest(projectId, root);

      // The file's own symbols were filled in, so the backfill did visit it.
      expect((await snapshot(projectId)).get("src/store/users.ts|function|saveUser")).toMatchObject(
        { package: "store", signature: "export function saveUser(user: User): void" },
      );
      expect(stats.symbolContextBackfill?.failedFiles).toBe(0);
      for (const id of [tagged.id, foreign.id]) {
        expect(await db.codeSymbol.findUniqueOrThrow({ where: { id } })).toMatchObject({
          signature: null,
          docComment: null,
          receiver: null,
          package: null,
        });
      }
    });

    it("counts a file it cannot read, or that changed under it, and writes nothing for it", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      await downgrade(projectId);
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      const before = await snapshot(projectId);

      const done = await backfillSymbolContext(
        db,
        graph.id,
        root,
        new Map([
          ["src/store/missing.ts", { language: "ts", contentHash: "0" }],
          // Not the hash of what is on disk: the file was edited after the walk.
          ["src/store/users.ts", { language: "ts", contentHash: "not-the-hash" }],
          ["src/store/io.ts", { language: "ts", contentHash: sha256(IO_TS) }],
        ]),
        async () => {},
      );

      expect(done).toEqual({ symbols: 1, embeddingTexts: 1, failedFiles: 2 });
      const after = await snapshot(projectId);
      expect(after.get("src/store/users.ts|function|saveUser")).toEqual(
        before.get("src/store/users.ts|function|saveUser"),
      );
      expect(after.get("src/store/io.ts|function|write")?.package).toBe("store");
    });

    it.skipIf(process.getuid?.() === 0)(
      "does not record the version while a file of the graph cannot be read, and finishes when it can",
      async () => {
        const { projectId, root } = await newProject();
        await ingest(projectId, root, false);
        await downgrade(projectId);
        const locked = path.join(root, "src/store/io.ts");
        // A file the graph has never held is unreadable too. It has no rows to
        // fill in, so it must not count against the backfill.
        const stranger = path.join(root, "src/store/stranger.ts");
        await fs.writeFile(stranger, "export const s = 1;\n", "utf8");
        await fs.chmod(stranger, 0o000);
        await fs.chmod(locked, 0o000);
        try {
          const stats = await ingest(projectId, root);
          expect(stats.symbolContextBackfill).toEqual({
            symbols: 5,
            embeddingTexts: 4,
            failedFiles: 1,
          });
          expect(
            (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
          ).toBeNull();
        } finally {
          await fs.chmod(locked, 0o644);
          await fs.rm(stranger, { force: true });
        }

        const again = await ingest(projectId, root);

        // Only the file that was left out is written now.
        expect(again.symbolContextBackfill).toEqual({
          symbols: 1,
          embeddingTexts: 1,
          failedFiles: 0,
        });
        expect(
          (await db.codeGraph.findFirstOrThrow({ where: { projectId } })).symbolContextVersion,
        ).toBe(SYMBOL_CONTEXT_VERSION);
      },
    );

    it("moves the receiver with the name when an extractor upgrade renames a Go method", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      // As an extractor before #1071 left it: the method named without its receiver.
      const save = await db.codeSymbol.findFirstOrThrow({
        where: { projectId, name: "Save", kind: "function" },
      });
      await db.codeSymbol.update({
        where: { id: save.id },
        data: { qualifiedName: "internal/db/storage.go::Save", receiver: null },
      });
      await db.codeGraph.updateMany({ where: { projectId }, data: { extractorVersion: null } });

      await ingest(projectId, root);

      expect(await db.codeSymbol.findUniqueOrThrow({ where: { id: save.id } })).toMatchObject({
        qualifiedName: "internal/db/storage.go::Storage::Save",
        receiver: "Storage",
      });
    });

    // PR #1126 review — "the backfill runs after the rename" had no test. The
    // END state cannot show it: the rename writes the receiver itself, so either
    // order leaves the same rows. What the order decides is which name the
    // backfill reads, so this watches the statements: for the renamed row, the
    // UPDATE that sets `qualifiedName` reaches the database before the UPDATE
    // that sets `signature`.
    it("fills the context in AFTER an extractor upgrade has renamed the row", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const save = await db.codeSymbol.findFirstOrThrow({
        where: { projectId, name: "Save", kind: "function" },
      });
      await db.codeSymbol.update({
        where: { id: save.id },
        data: { qualifiedName: "internal/db/storage.go::Save" },
      });
      await downgrade(projectId);
      await db.codeGraph.updateMany({ where: { projectId }, data: { extractorVersion: null } });

      const logged = new PrismaClient({
        adapter: new PrismaBetterSqlite3({ url: sqlite.url }),
        log: [{ emit: "event", level: "query" }],
      });
      /** The SET clause of every UPDATE of a symbol row, in the order they ran. */
      const sets: string[] = [];
      logged.$on("query", (e) => {
        const q = e.query;
        if (!q.startsWith("UPDATE") || !q.includes("`code_symbols` SET ")) return;
        sets.push(q.slice(q.indexOf(" SET "), q.indexOf(" WHERE ")));
      });
      try {
        await ingestCodeGraph(logged, {
          projectId,
          rootDir: root,
          incremental: true,
          sqlLineageOverride: false,
        });
      } finally {
        await logged.$disconnect();
      }

      const renames = sets.flatMap((s, i) => (s.includes("`qualifiedName`") ? [i] : []));
      const fills = sets.flatMap((s, i) => (s.includes("`signature`") ? [i] : []));
      // One Go method renamed; every symbol with a declaration filled in.
      expect(renames).toHaveLength(1);
      expect(fills.length).toBeGreaterThan(1);
      expect(Math.min(...fills)).toBeGreaterThan(renames[0]);
      expect(await db.codeSymbol.findUniqueOrThrow({ where: { id: save.id } })).toMatchObject({
        qualifiedName: "internal/db/storage.go::Storage::Save",
        receiver: "Storage",
        signature: "func (s *Storage) Save() error",
        docComment: "Save stores the user.",
        package: "storage",
      });
    });

    it("pins what is stored to SYMBOL_CONTEXT_VERSION", async () => {
      // A change to what `extractOwnFileContext` or `shippedContextLines` gives an
      // UNCHANGED file moves this digest. Bump SYMBOL_CONTEXT_VERSION with it, or
      // stored graphs keep the old columns and texts.
      const { projectId, root } = await newProject();
      await ingest(projectId, root, false);
      const digest = sha256(
        JSON.stringify(
          [...(await snapshot(projectId))].map(([key, r]) => [
            key,
            r.signature,
            r.docComment,
            r.receiver,
            r.package,
            r.text,
          ]),
        ),
      );
      // Version 2 with version 1's digest: the review round changed the answer
      // for shapes this tree does not hold (an invisible character in a comment,
      // a code line ending in a block comment above a declaration). Those are
      // pinned in `symbol-context.test.ts`; the number moved for them.
      expect({ version: SYMBOL_CONTEXT_VERSION, digest }).toEqual({
        version: 2,
        digest: "71a378cd2837a791b18fd09956e9756377d6ac747ba454305489866faff685f5",
      });
    });
  },
);
