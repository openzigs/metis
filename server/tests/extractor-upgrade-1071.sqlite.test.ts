/**
 * #1071 (PR #1104, review cycles 2 and 3) — the extractor-upgrade
 * acknowledgement against a REAL SQLite database built from the migration
 * chain.
 *
 * `src/lib/docs-gen/extractor-upgrade.test.ts` pins the rule with the database
 * mocked. This file pins what a mock cannot: that the migration creates the
 * table and the column the client writes, that the per-graph state survives
 * the round trip through it (marks included, to the millisecond), that there
 * is one row per document however often an upgrade is acknowledged, and that
 * the row goes with its document. Each snapshot's graph states are read from
 * the graph rows of the database, as `captureGenerationInputs` reads them.
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

const { acknowledgeExtractorUpgrade, settleExtractorUpgrade } =
  await import("../src/lib/docs-gen/extractor-upgrade.js");
const { fingerprintInputs, inputHash } = await import("../src/lib/docs-gen/regeneration-plan.js");

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
const ITEMS = { "symbol:a": "1", "symbol:b": "1", "edge:b": "1", "source:c": "1" };
/** The items after a change to graph A's rows (`a`) and, optionally, graph B's (`b`). */
const items = (a: string, b = "1") => ({ ...ITEMS, "symbol:a": a, "symbol:b": b });

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

    /** A project with two graphs (two repositories) and a document with a published version 1. */
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

    const mark = (graphId: string, time: Date | null) =>
      db.codeGraph.update({ where: { id: graphId }, data: { extractorUpgradedAt: time } });
    /**
     * A snapshot as the capture builds it: the items (graph A's rows `a`,
     * graph B's rows `b`), and for each graph in scope a digest of its rows
     * with the mark the graph row carries NOW.
     */
    const snap = async (a: string, b = "1", scope: "A" | "project" = "project") => {
      const stored = await db.codeGraph.findMany({
        where: { projectId, ...(scope === "A" ? { id: graphA } : {}) },
        select: { id: true, extractorUpgradedAt: true },
      });
      return fingerprintInputs(
        items(a, b),
        Object.fromEntries(
          stored.map((g) => [
            inputHash(g.id),
            {
              rows: g.id === graphA ? `a${a}` : `b${b}`,
              mark: g.extractorUpgradedAt?.toISOString() ?? null,
            },
          ]),
        ),
      );
    };
    const latest = () =>
      db.generatedDocumentVersion.findFirstOrThrow({
        where: { documentId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
    type Snapshot = Awaited<ReturnType<typeof snap>>;
    const settle = async (published: Snapshot, current: Snapshot) =>
      (await settleExtractorUpgrade({ documentId, latest: await latest(), published, current }))
        .outcome;
    const rows = () => db.generatedDocumentAcknowledgement.findMany({ where: { documentId } });

    it("with no mark nothing is written, and the document regenerates as before", async () => {
      const published = await snap("1");
      expect(await settle(published, await snap("2"))).toBe("changed");
      expect(await settle(published, await snap("3"))).toBe("changed");
      expect(await rows()).toEqual([]);
    });

    it("an upgrade is acknowledged once: one row with the graphs it saw, then the next graph-only change regenerates", async () => {
      const published = await snap("1");
      await mark(graphA, at(20));
      const upgraded = await snap("2");

      expect(await settle(published, upgraded)).toBe("acknowledged");
      const [row] = await rows();
      expect(row).toMatchObject({
        documentId,
        version: 1,
        upgradedAt: at(20),
        fingerprint: upgraded.fingerprint,
      });
      // The per-graph state survives the column: both graphs, A's mark to the millisecond.
      expect(JSON.parse(row.graphs!)).toEqual(upgraded.graphs);
      expect(JSON.parse(row.graphs!)[inputHash(graphA)].mark).toBe(at(20).toISOString());

      // The same inputs again: unchanged, and still one row.
      expect(await settle(published, upgraded)).toBe("unchanged");
      // Another change of A's rows, no new upgrade: a real change.
      expect(await settle(published, await snap("3"))).toBe("changed");
      expect(await rows()).toHaveLength(1);
    });

    it("review cycle 3: graph A upgraded and a real change in graph B in the same refresh regenerates", async () => {
      const published = await snap("1");
      await mark(graphA, at(20));
      // One check sees both: A's rows renamed by the upgrade, B's rows changed with no upgrade of B.
      const both = await snap("2", "2");
      expect(await settle(published, both)).toBe("changed");
      // Not acknowledged away at the next refresh either.
      expect(await settle(published, both)).toBe("changed");
      expect(await rows()).toEqual([]);
      // Control: the upgrade of A alone is acknowledged.
      expect(await settle(published, await snap("2"))).toBe("acknowledged");
      // And B's change after it regenerates: B's mark never moved.
      expect(await settle(published, both)).toBe("changed");
    });

    it("an upgrade of the project's OTHER graph is evidence for neither document", async () => {
      const scoped = await snap("1", "1", "A");
      const wide = await snap("1");
      await mark(graphB, at(20));
      // A's rows changed; only B was upgraded. The scoped document does not even read B.
      const scopedNow = await snap("2", "1", "A");
      expect(Object.keys(scopedNow.graphs!)).toEqual([inputHash(graphA)]);
      expect(await settle(scoped, scopedNow)).toBe("changed");
      // The project-wide document reads both graphs — and B's mark is still
      // not evidence for a difference in A's rows.
      expect(await settle(wide, await snap("2"))).toBe("changed");
      expect(await rows()).toEqual([]);
      // B's own rows, under B's moved mark: that is the upgrade.
      expect(await settle(wide, await snap("1", "2"))).toBe("acknowledged");
    });

    it("two graphs upgraded at two refreshes are each acknowledged, one row throughout", async () => {
      const published = await snap("1");
      await mark(graphA, at(20));
      expect(await settle(published, await snap("2"))).toBe("acknowledged");
      await mark(graphB, at(30));
      const afterB = await snap("2", "2");
      expect(await settle(published, afterB)).toBe("acknowledged");
      expect(await rows()).toMatchObject([
        { version: 1, upgradedAt: at(30), fingerprint: afterB.fingerprint },
      ]);
      expect(await settle(published, afterB)).toBe("unchanged");
    });

    it("a second upgrade replaces the row: one per document", async () => {
      const published = await snap("1");
      await mark(graphA, at(20));
      await settle(published, await snap("2"));
      await mark(graphA, at(30));
      const again = await snap("3");

      expect(await settle(published, again)).toBe("acknowledged");
      expect(await rows()).toMatchObject([
        { documentId, version: 1, upgradedAt: at(30), fingerprint: again.fingerprint },
      ]);
    });

    it("no clock decides: a mark BEHIND the version's date still counts, a mark AHEAD of a later version does not", async () => {
      // Version 1 was published at second 10. The ingest writer's clock is behind: mark at second 5.
      const published = await snap("1");
      await mark(graphA, at(5));
      expect(await settle(published, await snap("2"))).toBe("acknowledged");

      // Another writer's clock is an hour AHEAD: the next upgrade is marked at 3600 s.
      await mark(graphA, at(3600));
      const upgradedAgain = await snap("3");
      expect(await settle(published, upgradedAgain)).toBe("acknowledged");
      // Version 2 is then published from those inputs at second 120 — "before" the mark, by the clocks.
      await db.generatedDocumentVersion.create({
        data: { documentId, version: 2, content: "v2", createdAt: at(120) },
      });
      // A REAL graph-only change, no new upgrade: the mark is the one version 2 was generated against.
      const real = await snap("4");
      expect(await settle(upgradedAgain, real)).toBe("changed");
      expect(await settle(upgradedAgain, real)).toBe("changed");
      // The row is still version 1's: nothing was acknowledged for version 2.
      expect(await rows()).toMatchObject([{ version: 1 }]);
    });

    it("a mark distinguishes upgrades one millisecond apart", async () => {
      await mark(graphA, at(20));
      const published = await snap("1");
      expect(await settle(published, await snap("2"))).toBe("changed");
      await mark(graphA, new Date(at(20).getTime() + 1));
      expect(await settle(published, await snap("2"))).toBe("acknowledged");
    });

    it("a mark that moved without moving the inputs is adopted: one row, and the next change regenerates", async () => {
      const published = await snap("1");
      await mark(graphA, at(20));
      const sameInputs = await snap("1");
      expect(sameInputs.fingerprint).toBe(published.fingerprint);
      expect(await settle(published, sameInputs)).toBe("unchanged");
      expect(await rows()).toMatchObject([{ version: 1, upgradedAt: at(20) }]);
      const updatedAt = (await rows())[0].updatedAt;
      // Not written again while nothing moves.
      expect(await settle(published, sameInputs)).toBe("unchanged");
      expect((await rows())[0].updatedAt).toEqual(updatedAt);
      expect(await settle(published, await snap("2"))).toBe("changed");
    });

    it("a baseline published before graphs were recorded: its one graph upgraded is acknowledged, one of two is not", async () => {
      const legacy = fingerprintInputs(ITEMS);
      // No mark anywhere: as before the rule existed.
      expect(await settle(legacy, await snap("2", "1", "A"))).toBe("changed");
      await mark(graphA, at(20));
      // A project-wide document: graph B carries no mark, so the difference cannot be placed.
      expect(await settle(legacy, await snap("2"))).toBe("changed");
      expect(await rows()).toEqual([]);
      // A document scoped to graph A: every graph it reads was upgraded.
      expect(await settle(legacy, await snap("2", "1", "A"))).toBe("acknowledged");
      // From here on it has graphs to compare: the next change of A regenerates.
      expect(await settle(legacy, await snap("3", "1", "A"))).toBe("changed");
    });

    it("a NEW version makes an older acknowledgement stale, and a run can record one as it publishes", async () => {
      const published = await snap("1");
      await mark(graphA, at(20));
      await settle(published, await snap("2"));
      // Version 2 is published by a run an upgrade (second 35) overtook: its
      // manifest holds what it captured, the row what it stands for.
      const captured = await snap("2");
      await mark(graphA, at(35));
      const standsFor = await snap("3");
      await db.$transaction(async (tx) => {
        await tx.generatedDocumentVersion.create({
          data: { documentId, version: 2, content: "v2", createdAt: at(40) },
        });
        await acknowledgeExtractorUpgrade(tx, documentId, 2, standsFor);
      });
      expect(await rows()).toMatchObject([
        { version: 2, upgradedAt: at(35), fingerprint: standsFor.fingerprint },
      ]);
      // What version 2 stands for is unchanged; another change under the same mark is not.
      expect(await settle(captured, standsFor)).toBe("unchanged");
      expect(await settle(captured, await snap("4"))).toBe("changed");

      // Version 3, published from `standsFor` with nothing acknowledged: the row left by version 2 is ignored.
      await db.generatedDocumentVersion.create({
        data: { documentId, version: 3, content: "v3", createdAt: at(50) },
      });
      expect(await settle(standsFor, await snap("4"))).toBe("changed");
      await mark(graphA, at(60));
      expect(await settle(standsFor, await snap("4"))).toBe("acknowledged");
      expect(await rows()).toMatchObject([{ version: 3, upgradedAt: at(60) }]);
    });

    it("the acknowledgement goes with its document", async () => {
      const published = await snap("1");
      await mark(graphA, at(20));
      await settle(published, await snap("2"));
      expect(await rows()).toHaveLength(1);
      await db.generatedDocument.delete({ where: { id: documentId } });
      expect(await rows()).toEqual([]);
    });
  },
);
