/**
 * Issue #1841 — chat's `list_requirements` searches by meaning through the REAL
 * requirement index (#1835): a migrated SQLite database, the local vector store,
 * and the real embedder's vectors for the #1841 corpus replayed from
 * `__fixtures__/corpus-recorded.json`. Nothing here injects the meaning search:
 * the tool's default is what runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "eval",
  "requirement-retrieval",
  "__fixtures__",
);

const state = vi.hoisted(() => {
  process.env.VECTOR_STORE = "local";
  return {
    db: null as unknown,
    embed: null as null | { model: string; embed: (t: string[]) => Promise<unknown> },
  };
});
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/rag/embedder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/rag/embedder.js")>()),
  getEmbedder: () => state.embed,
}));

const { createListRequirementsTool } =
  await import("../src/lib/requirements/requirements-chat-tools.js");
const { __resetVectorStoreSingleton } = await import("../src/lib/rag/vector-store.js");
const { loadRecordedVectors, RecordedEmbedService } =
  await import("../src/lib/eval/recorded-vectors.js");
const { loadRetrievalCorpus } = await import("../src/lib/eval/requirement-retrieval/retrieval.js");

const A = "p-1841-a";
const B = "p-1841-b";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1841 — list_requirements by meaning, over the real index",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let root: string;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      root = mkdtempSync(path.join(os.tmpdir(), "metis-1841-"));
      process.env.LANCEDB_PATH = root;
      __resetVectorStoreSingleton();
      const recording = await loadRecordedVectors(path.join(FIXTURES, "corpus-recorded.json"));
      const recorded = new RecordedEmbedService(recording!, "eval:req-retrieval --record-vectors");
      state.embed = { model: recording!.model, embed: (t) => recorded.embed(t) };

      sqlite = createMigratedSqlite("1841-chat-semantic");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1841", username: "u-1841", displayName: "U", email: "u@example.test" },
      });
      for (const p of [A, B]) {
        await db.project.create({ data: { id: p, name: p, slug: p, createdById: "u-1841" } });
        await db.analysis.create({
          data: { id: `a-${p}`, projectId: p, startedById: "u-1841", status: "completed" },
        });
      }
      const corpus = await loadRetrievalCorpus(path.join(FIXTURES, "corpus.json"));
      for (const r of corpus.requirements.slice(0, 8)) {
        const row = await db.requirement.create({
          data: {
            projectId: A,
            analysisId: `a-${A}`,
            title: r.title,
            body: r.body,
            reviewStatus: r.status,
          },
        });
        ids[r.id] = row.id;
      }
      // Project B holds the same "Deferred settlement terms" requirement.
      const r01 = corpus.requirements[0]!;
      ids.r01InB = (
        await db.requirement.create({
          data: { projectId: B, analysisId: `a-${B}`, title: r01.title, body: r01.body },
        })
      ).id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      rmSync(root, { recursive: true, force: true });
    });

    const ctx = { sessionId: "s", userId: "u-1841", projectId: A };
    const listed = (res: { data?: unknown }) =>
      (res.data as { requirements: Array<{ id: string }> }).requirements.map((r) => r.id);

    it("finds a requirement that shares no word with the question; the word path does not", async () => {
      const question = { query: "let customers pay later" };
      const hybrid = await createListRequirementsTool().exec(question, ctx);
      expect(listed(hybrid).slice(0, 3)).toContain(ids.r01);
      expect(hybrid.text).toContain("Deferred settlement terms");
      expect(hybrid.text).toContain("matched by meaning");

      const wordsOnly = await createListRequirementsTool({ semantic: async () => [] }).exec(
        question,
        ctx,
      );
      expect(listed(wordsOnly)).not.toContain(ids.r01);
    });

    it("searches only the session project", async () => {
      const res = await createListRequirementsTool().exec(
        { query: "let customers pay later", limit: 100 },
        ctx,
      );
      expect(listed(res)).not.toContain(ids.r01InB);
      const inB = await createListRequirementsTool().exec(
        { query: "let customers pay later" },
        { ...ctx, projectId: B },
      );
      expect(listed(inB)).toEqual([ids.r01InB]);
    });
  },
);
