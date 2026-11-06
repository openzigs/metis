/**
 * Issue #1835 — requirement vectors on the pgvector backend, against a REAL
 * Postgres: requirements live in the real `requirements` table (the job's
 * `prisma db push`), vectors in a private schema's `rag_vectors` (#806), and a
 * query in one project never returns another project's near-identical
 * requirement. Every read goes through a store instance other than the writer's.
 *
 * Gated like the other `*-postgres` / pgvector suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` and `DATABASE_URL` is Postgres-shaped
 * (`pnpm test:integration requirement-embeddings-pgvector`, ci.yml
 * `postgres-adapter`). The unit suite's `postgres-unit` legs connect to no
 * database by design (#876), so this is where the pgvector proof runs.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectPrismaAdapter } from "../src/lib/prisma.js";
import { PgVectorStore } from "../src/lib/rag/vector-store-pgvector.js";
import {
  findNearestRequirements,
  requirementVectorsId,
  syncRequirementEmbeddings,
} from "../src/lib/requirements/requirement-embeddings.js";
import {
  ensurePgTestSchema,
  isPostgresUrl,
  makeSchemaScopedPrismaClient,
} from "./lib/pg/pg-test-schema.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgresUrl(databaseUrl);

const SCHEMA = "metis_it_req_vectors";
const DIM = 16;
const MODEL = "it-req-model";
const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-1835pg-${SUFFIX}`;

/** Deterministic: each word lights one axis. */
const embedService = {
  async embed(texts: string[]) {
    const vectors = texts.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 997;
        v[h % DIM] += 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
    return { vectors, model: MODEL, dimension: DIM };
  },
};

describe.runIf(enabled)("#1835 — requirement vectors on pgvector (integration)", () => {
  const vectorsDb = makeSchemaScopedPrismaClient(SCHEMA, databaseUrl);
  let db: PrismaClient;
  const projects = [`p-1835a-${SUFFIX}`, `p-1835b-${SUFFIX}`];
  const ids: Record<string, string> = {};

  const deps = () => ({
    db,
    embedService,
    model: () => MODEL,
    store: new PgVectorStore({ db: vectorsDb, dimension: DIM }),
  });

  beforeAll(async () => {
    await ensurePgTestSchema(SCHEMA, databaseUrl);
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    await db.user.create({
      data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
    });
    for (const projectId of projects) {
      await db.project.create({
        data: { id: projectId, name: projectId, slug: projectId, createdById: USER },
      });
      await db.analysis.create({
        data: { id: `a-${projectId}`, projectId, startedById: USER, status: "completed" },
      });
      const row = await db.requirement.create({
        data: {
          projectId,
          analysisId: `a-${projectId}`,
          title: "Export invoices to CSV",
          body: "Finance exports the invoices.",
        },
      });
      ids[projectId] = row.id;
    }
  });

  afterAll(async () => {
    for (const projectId of projects) {
      await new PgVectorStore({ db: vectorsDb, dimension: DIM })
        .dropTable(requirementVectorsId(projectId))
        .catch(() => undefined);
    }
    if (db) {
      await db.project.deleteMany({ where: { id: { in: projects } } });
      await db.user.deleteMany({ where: { id: USER } });
      await db.$disconnect();
    }
    await vectorsDb.$disconnect();
  });

  it("a query in project A returns A's requirement and never B's", async () => {
    const [a, b] = projects as [string, string];
    await syncRequirementEmbeddings(a, deps());
    await syncRequirementEmbeddings(b, deps());
    const hits = await findNearestRequirements(a, "export invoices to csv", {
      ...deps(),
      limit: 10,
    });
    expect(hits.map((h) => h.requirementId)).toEqual([ids[a]]);
  });

  it("an unchanged requirement is not re-embedded, and a deleted one leaves no vector", async () => {
    const [a] = projects as [string, string];
    const again = await syncRequirementEmbeddings(a, deps());
    expect(again).toMatchObject({ embedded: 0, unchanged: 1 });

    await db.requirement.delete({ where: { id: ids[a] } });
    const after = await syncRequirementEmbeddings(a, deps());
    expect(after.deleted).toBe(1);
    expect(await deps().store.listChunkRefs(requirementVectorsId(a))).toEqual([]);
  });
});
