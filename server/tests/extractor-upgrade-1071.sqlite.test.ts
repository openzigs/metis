/**
 * #1071 (PR #1104, review cycle 2) — the extractor-upgrade acknowledgement
 * against a REAL SQLite database built from the migration chain.
 *
 * `src/lib/docs-gen/extractor-upgrade.test.ts` pins the rule with the database
 * mocked. This file pins what a mock cannot: that the migration creates the
 * table the client writes, that there is one row per document however often an
 * upgrade is acknowledged, that the mark is read from the graphs the document
 * reads and compared as a time, and that the row goes with its document.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { acknowledgeExtractorUpgrade, extractorUpgradeMark, settleExtractorUpgrade } =
  await import("../src/lib/docs-gen/extractor-upgrade.js");
const { fingerprintInputs } = await import("../src/lib/docs-gen/regeneration-plan.js");

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
const published = fingerprintInputs({ "symbol:a": "1", "edge:b": "1", "source:c": "1" });
const rewritten = fingerprintInputs({ "symbol:z": "1", "edge:b": "2", "source:c": "1" });
const rewrittenAgain = fingerprintInputs({ "symbol:z": "1", "edge:b": "3", "source:c": "1" });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1071 — acknowledging an extractor upgrade for a document, on a real database",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1071-ack");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-ack", username: "u-ack", displayName: "u-ack", email: "u-ack@example.test" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** A project with two graphs (two repositories) and a document whose version 1 was published at second 10. */
    let projectId: string;
    let documentId: string;
    let graphA: string;
    let graphB: string;
    beforeEach(async () => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `ack-${seq}`, slug: `ack-${seq}`, createdById: "u-ack" },
      });
      projectId = project.id;
      graphA = (await db.codeGraph.create({ data: { projectId } })).id;
      graphB = (await db.codeGraph.create({ data: { projectId } })).id;
      const doc = await db.generatedDocument.create({ data: { projectId, title: "Architecture" } });
      documentId = doc.id;
      await db.generatedDocumentVersion.create({
        data: { documentId, version: 1, content: "v1", createdAt: at(10) },
      });
    });

    const mark = (graphId: string, seconds: number | null) =>
      db.codeGraph.update({
        where: { id: graphId },
        data: { extractorUpgradedAt: seconds === null ? null : at(seconds) },
      });
    const latest = async () => {
      const v = await db.generatedDocumentVersion.findFirstOrThrow({
        where: { documentId },
        orderBy: { version: "desc" },
        select: { version: true, createdAt: true },
      });
      return v;
    };
    const settle = async (current = rewritten, codeGraphId: string | null = graphA) =>
      settleExtractorUpgrade({
        documentId,
        scope: { projectId, codeGraphId },
        latest: await latest(),
        published,
        current,
      });
    const rows = () => db.generatedDocumentAcknowledgement.findMany({ where: { documentId } });

    it("reads the mark of the graph the document is scoped to, or the latest of the project's", async () => {
      expect(await extractorUpgradeMark({ projectId, codeGraphId: graphA })).toBeNull();
      await mark(graphA, 20);
      await mark(graphB, 30);
      expect(await extractorUpgradeMark({ projectId, codeGraphId: graphA })).toEqual(at(20));
      expect(await extractorUpgradeMark({ projectId, codeGraphId: graphB })).toEqual(at(30));
      expect(await extractorUpgradeMark({ projectId })).toEqual(at(30));
    });

    it("with no mark nothing is written, and the document regenerates as before", async () => {
      expect(await settle()).toEqual({ outcome: "changed" });
      expect(await rows()).toEqual([]);
    });

    it("an upgrade is acknowledged once: one row, then the next graph-only change regenerates", async () => {
      await mark(graphA, 20);

      expect(await settle()).toEqual({ outcome: "acknowledged" });
      expect(await rows()).toMatchObject([
        { documentId, version: 1, upgradedAt: at(20), fingerprint: rewritten.fingerprint },
      ]);

      // The same inputs again: unchanged, and still one row.
      expect(await settle()).toEqual({ outcome: "unchanged" });
      // Another change of graph rows, no new upgrade: a real change.
      expect(await settle(rewrittenAgain)).toEqual({ outcome: "changed" });
      expect(await rows()).toHaveLength(1);
    });

    it("an upgrade of the project's OTHER graph is not evidence for a document scoped to this one", async () => {
      await mark(graphB, 20);
      expect(await settle(rewritten, graphA)).toEqual({ outcome: "changed" });
      expect(await rows()).toEqual([]);
      // A project-wide document reads both graphs.
      expect(await settle(rewritten, null)).toEqual({ outcome: "acknowledged" });
    });

    it("a second upgrade replaces the row: one per document", async () => {
      await mark(graphA, 20);
      await settle();
      await mark(graphA, 30);

      expect(await settle(rewrittenAgain)).toEqual({ outcome: "acknowledged" });
      expect(await rows()).toMatchObject([
        { documentId, version: 1, upgradedAt: at(30), fingerprint: rewrittenAgain.fingerprint },
      ]);
    });

    it("a mark one millisecond after the version counts; the version's own instant does not", async () => {
      await db.codeGraph.update({
        where: { id: graphA },
        data: { extractorUpgradedAt: at(10) },
      });
      expect(await settle()).toEqual({ outcome: "changed" });
      await db.codeGraph.update({
        where: { id: graphA },
        data: { extractorUpgradedAt: new Date(at(10).getTime() + 1) },
      });
      expect(await settle()).toEqual({ outcome: "acknowledged" });
    });

    it("a NEW version makes an older acknowledgement stale, and a run can record one as it publishes", async () => {
      await mark(graphA, 20);
      await settle();
      // Version 2 is published at second 40, by a run an upgrade (second 35) overtook.
      await db.$transaction(async (tx) => {
        await tx.generatedDocumentVersion.create({
          data: { documentId, version: 2, content: "v2", createdAt: at(40) },
        });
        await acknowledgeExtractorUpgrade(tx, documentId, 2, {
          upgradedAt: at(35),
          fingerprint: rewrittenAgain.fingerprint,
        });
      });
      expect(await rows()).toMatchObject([
        { version: 2, upgradedAt: at(35), fingerprint: rewrittenAgain.fingerprint },
      ]);
      // What version 2 stands for is unchanged; what version 1 was acknowledged for is not it.
      expect(await settle(rewrittenAgain)).toEqual({ outcome: "unchanged" });
      expect(await settle(rewritten)).toEqual({ outcome: "changed" });

      // Version 3, published with nothing acknowledged: the row left by version 2 is ignored.
      await db.generatedDocumentVersion.create({
        data: { documentId, version: 3, content: "v3", createdAt: at(50) },
      });
      expect(await settle(rewrittenAgain)).toEqual({ outcome: "changed" });
      await mark(graphA, 60);
      expect(await settle(rewrittenAgain)).toEqual({ outcome: "acknowledged" });
      expect(await rows()).toMatchObject([{ version: 3, upgradedAt: at(60) }]);
    });

    it("the acknowledgement goes with its document", async () => {
      await mark(graphA, 20);
      await settle();
      expect(await rows()).toHaveLength(1);
      await db.generatedDocument.delete({ where: { id: documentId } });
      expect(await rows()).toEqual([]);
    });
  },
);
