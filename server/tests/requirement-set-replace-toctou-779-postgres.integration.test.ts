/**
 * #779 — review work committed between the reviewed-work check and the delete
 * is never silently cascaded away (Postgres).
 *
 * `persistRequirements` checks that no requirement of the analysis carries
 * review work, then `deleteMany`s the set. Those used to be separate
 * statements outside any transaction, so on Postgres a person could add a
 * comment thread (or link, approval, ...) in between: the check had already
 * passed, the delete cascaded the new thread away, and the person's write had
 * "succeeded".
 *
 * The interleaving is forced: the re-synthesis pauses right after its
 * reviewed-work count; a second connection then inserts a comment thread on one
 * of the requirements. With the set locked before the check, that insert waits
 * on the re-synthesis's row lock (`pg_blocking_pids`), and once the set is
 * replaced it fails on its foreign key: refused loudly, never lost silently.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SynthesisOutput } from "@metis/shared";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});

const { selectPrismaAdapter } = await import("../src/lib/prisma.js");
const { persistRequirements } = await import("../src/lib/analysis/analysis-service.js");

const SUFFIX = randomUUID().slice(0, 8);
const USER = `u-779pg-${SUFFIX}`;
const WORKSPACE = `ws-779pg-${SUFFIX}`;
const PROJECT = `proj-779pg-${SUFFIX}`;
const ANALYSIS = `ana-779pg-${SUFFIX}`;
/** Tags this run's connections so the lock probe never sees another backend. */
const APP_NAME = `metis-779pg-${SUFFIX}`;

function taggedUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("application_name", APP_NAME);
  return u.toString();
}

function synthesis(titles: string[]): SynthesisOutput {
  return {
    summary: "s",
    requirements: titles.map((title) => ({
      type: "feature" as const,
      title,
      body: `${title} body`,
      priority: "medium" as const,
      labels: [],
      evidenceFindingIndexes: [],
      acceptanceCriteria: [],
    })),
  };
}

describe.skipIf(!enabled)("#779 — review work racing a requirement-set replace (Postgres)", () => {
  let db: PrismaClient;
  /** The person's connection, separate from the re-synthesis's pool. */
  let person: PrismaClient;
  let observer: PrismaClient;

  /**
   * The client `persistRequirements` sees: identical to `db`, except that the
   * reviewed-work count (the second `requirement.count` of a run) calls
   * `afterCheck` before returning — on the root client or inside a transaction.
   */
  let afterCheck: (() => Promise<void>) | null = null;
  const pausingClient = () => {
    let counts = 0;
    const hook = {
      query: {
        requirement: {
          async count({ args, query }: { args: unknown; query: (a: unknown) => Promise<number> }) {
            const n = await query(args);
            counts += 1;
            const pause = counts === 2 ? afterCheck : null;
            if (pause) {
              afterCheck = null;
              await pause();
            }
            return n;
          },
        },
      },
    };
    return db.$extends(hook as never);
  };

  /** Resolves once a connection of this run is waiting on a lock, or `settled` settles. */
  async function blockedOrSettled(settled: Promise<unknown>): Promise<"blocked" | "settled"> {
    let done = false;
    void settled.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 200; i += 1) {
      if (done) return "settled";
      const rows = await observer.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = ${APP_NAME}
           AND wait_event_type = 'Lock'`;
      if (Number(rows[0]?.n ?? 0) > 0) return "blocked";
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("neither blocked nor settled within 10s");
  }

  beforeAll(async () => {
    db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
    person = new PrismaClient({
      adapter: selectPrismaAdapter(taggedUrl(databaseUrl)),
    });
    observer = new PrismaClient({
      adapter: selectPrismaAdapter(databaseUrl),
    });
    await db.user.create({
      data: {
        id: USER,
        username: USER,
        displayName: USER,
        email: `${USER}@example.test`,
      },
    });
    await db.workspace.create({
      data: { id: WORKSPACE, name: WORKSPACE, slug: WORKSPACE },
    });
    await db.project.create({
      data: {
        id: PROJECT,
        name: PROJECT,
        slug: PROJECT,
        createdById: USER,
        workspaceId: WORKSPACE,
      },
    });
    await db.analysis.create({
      data: {
        id: ANALYSIS,
        projectId: PROJECT,
        startedById: USER,
        status: "completed",
      },
    });
  });

  afterAll(async () => {
    if (db) {
      // Requirements, threads and the analysis cascade from the project.
      await db.project.deleteMany({ where: { id: PROJECT } });
      await db.workspace.deleteMany({ where: { id: WORKSPACE } });
      await db.user.deleteMany({ where: { id: USER } });
    }
    await Promise.all([db?.$disconnect(), person?.$disconnect(), observer?.$disconnect()]);
  });

  it("a comment thread added after the check waits for the replace and is refused, never cascaded away", async () => {
    state.db = db;
    const [first] = await persistRequirements({
      analysisId: ANALYSIS,
      projectId: PROJECT,
      synthesis: synthesis(["A", "B"]),
      findingIdsByIndex: [],
      degraded: null,
    });

    let comment: Promise<unknown> | null = null;
    let commentState: "blocked" | "settled" | null = null;
    afterCheck = async () => {
      // The check found nothing reviewed. A person now comments on A.
      comment = person.commentThread.create({
        data: { requirementId: first! },
      });
      commentState = await blockedOrSettled(comment);
    };

    state.db = pausingClient();
    const ids = await persistRequirements({
      analysisId: ANALYSIS,
      projectId: PROJECT,
      synthesis: synthesis(["C"]),
      findingIdsByIndex: [],
      degraded: null,
    });
    state.db = db;

    expect(comment).not.toBeNull();
    const outcome = await Promise.allSettled([comment!]);

    // The comment was held behind the replace's lock …
    expect(commentState).toBe("blocked");
    expect(ids).toHaveLength(1);
    const titles = (
      await db.requirement.findMany({
        where: { analysisId: ANALYSIS },
        select: { title: true },
      })
    ).map((r) => r.title);
    expect(titles).toEqual(["C"]);
    // … and then refused on its foreign key: the person sees an error, rather
    // than a success whose thread the replace silently deleted.
    expect(outcome[0]!.status).toBe("rejected");
    expect(await db.commentThread.count({ where: { requirementId: first! } })).toBe(0);
  });
});
