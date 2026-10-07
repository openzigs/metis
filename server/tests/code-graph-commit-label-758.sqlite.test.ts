/**
 * #758 — `RepoConnection.lastCommitSha` (the commit the connections page says
 * the code graph reflects) must always equal `code_graphs.commitSha`.
 *
 * Two paths used to move one label without the other: the clone/pull wrote
 * `lastCommitSha` before the graph ingest ran (so a failed ingest left the
 * connector ahead of the graph), and the graph's own label was written at the
 * START of the ingest (so a failed run relabelled a graph it never rebuilt).
 * The metadata step's remote-tip overwrite is covered in
 * `connector-repo-service.test.ts`. Proven against a REAL SQLite database built
 * from the migration chain, because the two writes share a transaction.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});

vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

vi.mock("../src/lib/code-graph/sql-lineage-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/sql-lineage-client.js")>();
  return { ...actual, isSqlLineageEnabled: () => false };
});

const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");

const USER = "u-758";
const OLD_SHA = "703fe82693ef91054f1163435e2495ed118b3f25";
const NEW_SHA = "c4d54f87a81b30aa173fddf05d7ff83ae7da5796";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#758 — the connector's lastCommitSha moves only with a completed graph (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("758-commit-label");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-758-"));
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    const fixture = async () => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `p758-${seq}`, slug: `p758-${seq}`, createdById: USER },
      });
      const repo = await db.repoConnection.create({
        data: { projectId: project.id, label: `r758-${seq}`, ownerOrOrg: "o", repoName: "r" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, "a.ts"), "export function f() { return 1; }\n");
      return { projectId: project.id, repoId: repo.id, root };
    };

    const labels = async (projectId: string, repoId: string) => {
      const graph = await db.codeGraph.findFirst({
        where: { projectId, repoConnectionId: repoId },
      });
      const repo = await db.repoConnection.findUniqueOrThrow({ where: { id: repoId } });
      return { graph: graph?.commitSha ?? null, connector: repo.lastCommitSha };
    };

    it("a completed ingest records the same commit on the graph and the connector", async () => {
      const { projectId, repoId, root } = await fixture();
      await ingestCodeGraph(db, {
        projectId,
        rootDir: root,
        repoConnectionId: repoId,
        commitSha: OLD_SHA,
      });
      expect(await labels(projectId, repoId)).toEqual({ graph: OLD_SHA, connector: OLD_SHA });

      await ingestCodeGraph(db, {
        projectId,
        rootDir: root,
        repoConnectionId: repoId,
        commitSha: NEW_SHA,
      });
      expect(await labels(projectId, repoId)).toEqual({ graph: NEW_SHA, connector: NEW_SHA });
    });

    it("an ingest that fails after the pull moved the tip leaves both labels on the old commit", async () => {
      const { projectId, repoId, root } = await fixture();
      await ingestCodeGraph(db, {
        projectId,
        rootDir: root,
        repoConnectionId: repoId,
        commitSha: OLD_SHA,
      });

      await expect(
        ingestCodeGraph(db, {
          projectId,
          rootDir: path.join(root, "does-not-exist"),
          repoConnectionId: repoId,
          commitSha: NEW_SHA,
        }),
      ).rejects.toThrow();
      expect(await labels(projectId, repoId)).toEqual({ graph: OLD_SHA, connector: OLD_SHA });
    });

    it("an ingest with no commit leaves an existing label alone", async () => {
      const { projectId, repoId, root } = await fixture();
      await ingestCodeGraph(db, {
        projectId,
        rootDir: root,
        repoConnectionId: repoId,
        commitSha: OLD_SHA,
      });
      await ingestCodeGraph(db, { projectId, rootDir: root, repoConnectionId: repoId });
      expect(await labels(projectId, repoId)).toEqual({ graph: OLD_SHA, connector: OLD_SHA });
    });
  },
);
