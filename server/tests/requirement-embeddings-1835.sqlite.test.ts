/**
 * Issue #1835 — requirement vectors kept in sync with the requirements, proven
 * over a REAL migrated SQLite database and REAL vector stores (the local JSON
 * store and LanceDB through the `vectordb` binding). Every read goes through a
 * NEW store instance over the same directory, so nothing is answered from the
 * writer's in-memory cache.
 *
 * The embedder is a deterministic bag-of-words stand-in: these tests prove the
 * wiring (what is embedded, when, and what a query can see), not the semantics
 * of the production model, which #1836 measures.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
import {
  LanceVectorStore,
  LocalVectorStore,
  type VectorStore,
} from "../src/lib/rag/vector-store.js";
import type { EmbeddingResult } from "../src/lib/rag/embedder.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const {
  findNearestRequirements,
  formatRequirementForEmbedding,
  requirementVectorsId,
  syncRequirementEmbeddings,
} = await import("../src/lib/requirements/requirement-embeddings.js");
const { updateRequirementWithHistory } =
  await import("../src/lib/requirements/requirement-version-service.js");
const { WITHHELD_PROPOSAL_KEY } = await import("../src/lib/analysis/withheld-replacement.js");

const DIM = 64;
const MODEL = "bow-test-model";

/** A deterministic bag-of-words embedder that counts its calls. */
function bagOfWords(model = MODEL, dim = DIM) {
  const calls: string[][] = [];
  const embed = async (texts: string[]): Promise<EmbeddingResult> => {
    calls.push(texts);
    const vectors = texts.map((t) => {
      const v = new Array<number>(dim).fill(0);
      for (const word of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        if (word.length < 3) continue;
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
        v[h % dim] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, model, dimension: dim };
  };
  return { embedService: { embed }, calls, model: () => model };
}

const loadable = await import("vectordb").then(
  () => true,
  () => false,
);

const BACKENDS: Array<[string, (root: string) => VectorStore, boolean]> = [
  ["local JSON", (root) => new LocalVectorStore({ root }), true],
  ["LanceDB", (root) => new LanceVectorStore({ root, dimension: DIM }), loadable],
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1835 — requirement embeddings",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1835-requirement-embeddings");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1835", username: "u-1835", displayName: "U", email: "u@example.test" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const newProject = async () => {
      seq += 1;
      const projectId = `p-1835-${seq}`;
      await db.project.create({
        data: { id: projectId, name: projectId, slug: projectId, createdById: "u-1835" },
      });
      const analysisId = `a-1835-${seq}`;
      await db.analysis.create({
        data: {
          id: analysisId,
          projectId,
          startedById: "u-1835",
          status: "completed",
          startedAt: new Date(),
        },
      });
      return { projectId, analysisId };
    };

    const addRequirement = async (
      p: { projectId: string; analysisId: string },
      title: string,
      body: string,
      criteria: string[] = [],
    ) => {
      const row = await db.requirement.create({
        data: {
          projectId: p.projectId,
          analysisId: p.analysisId,
          title,
          body,
          acceptanceCriteria: JSON.stringify(criteria),
        },
      });
      return row.id;
    };

    describe.each(BACKENDS)("on the %s store", (_name, makeStore, available) => {
      let root: string;
      beforeEach(() => {
        root = mkdtempSync(path.join(os.tmpdir(), "metis-1835-"));
        return () => rmSync(root, { recursive: true, force: true });
      });

      /** A store that has never seen a write: nothing it returns can come from a cache. */
      const freshStore = () => makeStore(root);

      it.runIf(available)(
        "round trip: an edit to the acceptance criteria is what a fresh query ranks by",
        async () => {
          const p = await newProject();
          const invoices = await addRequirement(
            p,
            "Export invoices",
            "Finance exports the monthly invoices.",
            ["The export is a spreadsheet file"],
          );
          await addRequirement(p, "Reset password", "A user resets a forgotten password by email.");
          const bow = bagOfWords();
          await syncRequirementEmbeddings(p.projectId, { ...bow, store: freshStore(), db });

          // The public edit service: a versioned, history-writing edit of the criteria.
          await updateRequirementWithHistory(db, {
            requirementId: invoices,
            patch: {
              acceptanceCriteria: JSON.stringify([
                "Audit retention keeps every ledger entry seven years",
              ]),
            },
          });

          const query = "audit retention ledger entry years";
          const hits = await findNearestRequirements(p.projectId, query, {
            ...bow,
            store: freshStore(),
            db,
          });
          expect(hits[0]?.requirementId).toBe(invoices);

          // The stored vector is the EDITED text's, read back through another new store.
          const stored = await freshStore().search(
            requirementVectorsId(p.projectId),
            (await bow.embedService.embed([query])).vectors[0],
            5,
          );
          const row = stored.find((h) => h.row.id === invoices)?.row;
          expect(row?.metadata.text).toContain("Audit retention keeps every ledger entry");
          expect(row?.metadata.text).not.toContain("spreadsheet");
        },
      );

      it.runIf(available)(
        "a deleted requirement, and a re-run's delete-and-recreate, leave no vector for the old id",
        async () => {
          const p = await newProject();
          const keep = await addRequirement(p, "List feeds", "Show every feed.");
          const gone = await addRequirement(p, "Delete feed", "Remove a feed.");
          const bow = bagOfWords();
          await syncRequirementEmbeddings(p.projectId, { ...bow, store: freshStore(), db });
          const ids = async () =>
            (await freshStore().listChunkRefs(requirementVectorsId(p.projectId)))
              .map((r) => r.chunkId)
              .sort();
          expect(await ids()).toEqual([keep, gone].sort());

          await db.requirement.delete({ where: { id: gone } });
          const afterDelete = await syncRequirementEmbeddings(p.projectId, {
            ...bow,
            store: freshStore(),
            db,
          });
          expect(afterDelete.deleted).toBe(1);
          expect(await ids()).toEqual([keep]);

          // A re-run: the analysis's rows are deleted and recreated under new ids.
          await db.requirement.deleteMany({ where: { analysisId: p.analysisId } });
          const recreated = await addRequirement(p, "List feeds", "Show every feed.");
          await syncRequirementEmbeddings(p.projectId, { ...bow, store: freshStore(), db });
          expect(await ids()).toEqual([recreated]);
          expect(
            (await db.requirementEmbedding.findMany({ where: { projectId: p.projectId } })).map(
              (r) => r.requirementId,
            ),
          ).toEqual([recreated]);
        },
      );

      it.runIf(available)(
        "scoping: a query in project A never returns project B's near-identical requirement",
        async () => {
          const a = await newProject();
          const b = await newProject();
          const inA = await addRequirement(
            a,
            "Export invoices to CSV",
            "Finance exports invoices.",
          );
          const inB = await addRequirement(
            b,
            "Export invoices to CSV",
            "Finance exports invoices.",
          );
          const bow = bagOfWords();
          const store = freshStore();
          await syncRequirementEmbeddings(a.projectId, { ...bow, store, db });
          await syncRequirementEmbeddings(b.projectId, { ...bow, store, db });

          const hits = await findNearestRequirements(a.projectId, "export invoices to csv", {
            ...bow,
            store: freshStore(),
            db,
            limit: 10,
          });
          expect(hits.map((h) => h.requirementId)).toEqual([inA]);

          // A hit for B's requirement served from A's namespace (a reconcile racing a
          // write) is still not returned: every hit is re-read on the project AND the id.
          const vector = (await bow.embedService.embed(["export invoices to csv"])).vectors[0];
          const real = freshStore();
          const leaky = new Proxy(real, {
            get(target, prop, receiver) {
              if (prop !== "search") return Reflect.get(target, prop, receiver) as unknown;
              return async (...args: Parameters<VectorStore["search"]>) => [
                {
                  score: 1,
                  row: {
                    id: inB,
                    vector,
                    metadata: {
                      chunkId: inB,
                      documentId: inB,
                      filename: "",
                      position: 0,
                      text: "planted",
                      embeddingModel: MODEL,
                    },
                  },
                },
                ...(await target.search(...args)),
              ];
            },
          });
          const planted = await findNearestRequirements(a.projectId, "export invoices to csv", {
            ...bow,
            store: leaky,
            db,
            limit: 10,
          });
          expect(planted.map((h) => h.requirementId)).toEqual([inA]);
        },
      );

      it.runIf(available)("an unchanged requirement is not re-embedded", async () => {
        const p = await newProject();
        await addRequirement(p, "List feeds", "Show every feed.");
        await addRequirement(p, "Delete feed", "Remove a feed.");
        const bow = bagOfWords();
        const first = await syncRequirementEmbeddings(p.projectId, {
          ...bow,
          store: freshStore(),
          db,
        });
        expect(first).toMatchObject({ embedded: 2, unchanged: 0 });
        bow.calls.length = 0;
        const second = await syncRequirementEmbeddings(p.projectId, {
          ...bow,
          store: freshStore(),
          db,
        });
        expect(bow.calls).toHaveLength(0);
        expect(second).toMatchObject({ embedded: 0, unchanged: 2, deleted: 0 });
      });

      it.runIf(available)(
        "soft-deleted requirements and a withheld re-synthesis are never returned",
        async () => {
          const p = await newProject();
          const live = await addRequirement(p, "Archive feeds", "Archive a stale feed.");
          const soft = await addRequirement(p, "Archive feeds", "Archive a stale feed.");
          // A withheld replacement's rows live in the analysis metadata, never as rows.
          await db.analysis.update({
            where: { id: p.analysisId },
            data: {
              metadata: JSON.stringify({
                [WITHHELD_PROPOSAL_KEY]: {
                  at: new Date().toISOString(),
                  rows: [{ title: "Archive feeds", body: "Archive a stale feed." }],
                },
              }),
            },
          });
          const bow = bagOfWords();
          await syncRequirementEmbeddings(p.projectId, { ...bow, store: freshStore(), db });
          await db.requirement.update({ where: { id: soft }, data: { deletedAt: new Date() } });

          const hits = await findNearestRequirements(p.projectId, "archive stale feed", {
            ...bow,
            store: freshStore(),
            db,
            limit: 10,
          });
          expect(hits.map((h) => h.requirementId)).toEqual([live]);
          const refs = await freshStore().listChunkRefs(requirementVectorsId(p.projectId));
          expect(refs.map((r) => r.chunkId)).toEqual([live]);
          expect(await db.requirementEmbedding.count({ where: { requirementId: soft } })).toBe(0);
        },
      );

      it.runIf(available)(
        "an embedder change (another model, another width) re-embeds every requirement",
        async () => {
          const p = await newProject();
          const id = await addRequirement(p, "List feeds", "Show every feed.");
          await syncRequirementEmbeddings(p.projectId, {
            ...bagOfWords("old-model"),
            store: freshStore(),
            db,
          });
          const next = bagOfWords("new-model", DIM / 2);
          const result = await syncRequirementEmbeddings(p.projectId, {
            ...next,
            store: freshStore(),
            db,
          });
          expect(result.embedded).toBe(1);
          const refs = await freshStore().listChunkRefs(requirementVectorsId(p.projectId));
          expect(refs).toEqual([
            expect.objectContaining({ chunkId: id, embeddingModel: "new-model" }),
          ]);
          const hits = await findNearestRequirements(p.projectId, "list feeds", {
            ...next,
            store: freshStore(),
            db,
          });
          expect(hits.map((h) => h.requirementId)).toEqual([id]);
        },
      );
    });

    it("excludes the given ids and answers nothing for an empty query or limit", async () => {
      const p = await newProject();
      const a = await addRequirement(p, "List feeds", "Show every feed.");
      const b = await addRequirement(p, "List feeds again", "Show every feed.");
      const root = mkdtempSync(path.join(os.tmpdir(), "metis-1835-"));
      try {
        const deps = { ...bagOfWords(), store: new LocalVectorStore({ root }), db };
        const hits = await findNearestRequirements(p.projectId, "list feeds", {
          ...deps,
          excludeIds: [a],
        });
        expect(hits.map((h) => h.requirementId)).toEqual([b]);
        expect(await findNearestRequirements(p.projectId, "   ", deps)).toEqual([]);
        expect(await findNearestRequirements(p.projectId, "list", { ...deps, limit: 0 })).toEqual(
          [],
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("embeds title, body and criteria, and nothing for a blank part", () => {
      expect(
        formatRequirementForEmbedding({
          title: " Export ",
          body: "",
          acceptanceCriteria: JSON.stringify(["CSV", "PDF"]),
        }),
      ).toBe("Export\n\nAcceptance criteria:\n- CSV\n- PDF");
    });
  },
);
