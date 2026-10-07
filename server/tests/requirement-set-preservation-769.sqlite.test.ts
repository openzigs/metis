/**
 * Issue #769 — a re-synthesis must never hard-delete a reviewed requirement set.
 *
 * The incident: Regenerate on one agent re-ran synthesis in the background, and
 * `persistRequirements` did `requirement.deleteMany({ analysisId })` — cascading
 * away approvals, edits (versions), links, data mappings and the pins of two
 * "immutable" baselines — then inserted a degraded keyword-fallback set.
 *
 * Every assertion here reads back through a FRESH query against a REAL migrated
 * SQLite database, so the cascades are the real ones (an in-memory fake would
 * not cascade and would pass over the bug).
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SynthesisDegradation, SynthesisOutput } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
// The real module, so `persistRequirements` picks its locking by the real
// provider seam (#779); only the client is swapped.
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const { persistRequirements } = await import("../src/lib/analysis/analysis-service.js");

const ANALYSIS = "an769";
const PROJECT = "p769";
const USER = "u769";

const DEGRADED: SynthesisDegradation = {
  reason: "non-json",
  attempts: 2,
  requirementCount: 3,
  at: "2026-10-02T00:37:14.000Z",
};

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

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Issue #769 — re-synthesis never destroys a reviewed requirement set (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("769-preserve");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: "u769@x.test" },
      });
      await db.project.create({
        data: { id: PROJECT, name: "P", slug: PROJECT, createdById: USER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      state.db = db;
      await db.baseline.deleteMany({});
      await db.reviewRequest.deleteMany({});
      await db.databaseConnection.deleteMany({});
      await db.analysis.deleteMany({});
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: USER, status: "completed" },
      });
    });

    /** Seed the set a first healthy synthesis produced. */
    async function seedSet(titles: string[]): Promise<string[]> {
      return persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(titles),
        findingIdsByIndex: [],
        degraded: null,
      });
    }

    async function titles(): Promise<string[]> {
      const rows = await db.requirement.findMany({
        where: { analysisId: ANALYSIS },
        orderBy: { title: "asc" },
        select: { title: true },
      });
      return rows.map((r) => r.title);
    }

    /** A generated spec document to map a requirement to (#779). */
    async function specDocument() {
      return db.generatedDocument.create({
        data: { projectId: PROJECT, title: "Spec" },
      });
    }

    async function metadata(): Promise<Record<string, unknown>> {
      const row = await db.analysis.findUniqueOrThrow({ where: { id: ANALYSIS } });
      return row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    }

    it("replaces an UNREVIEWED healthy set with a healthy re-synthesis (#57 still holds)", async () => {
      await seedSet(["A", "B"]);
      const ids = await seedSet(["C"]);
      expect(ids).toHaveLength(1);
      expect(await titles()).toEqual(["C"]);
      expect((await metadata()).requirementReplacementWithheld).toBeUndefined();
    });

    it("the incident: keeps the reviewed set, its link, versions, data mappings and baseline pins", async () => {
      const [a, b] = await seedSet(["A", "B"]);
      // Human work, as in the walkthrough: approve + edit A, link A→B, map A to
      // two columns, pin both into a baseline.
      await db.requirement.update({
        where: { id: a },
        data: { reviewStatus: "approved", version: 1 },
      });
      await db.requirementVersion.create({
        data: { requirementId: a, version: 1, changedFields: '["body"]', actorId: USER },
      });
      const link = await db.requirementLink.create({
        data: {
          sourceRequirementId: a,
          targetRequirementId: b,
          type: "depends_on",
          createdById: USER,
        },
      });
      const conn = await db.databaseConnection.create({
        data: { projectId: PROJECT, label: "db", driver: "postgres" },
      });
      for (const columnName of ["next_check_at", "parsing_error_count"]) {
        await db.requirementDataMapping.create({
          data: { requirementId: a, dbConnectorId: conn.id, tableName: "feeds", columnName },
        });
      }
      const baseline = await db.baseline.create({
        data: { projectId: PROJECT, name: "B", createdById: USER },
      });
      await db.baselineItem.createMany({
        data: [
          { baselineId: baseline.id, requirementId: a, version: 1 },
          { baselineId: baseline.id, requirementId: b, version: 0 },
        ],
      });

      // The background re-synthesis (degraded fallback, as in the incident).
      const ids = await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F1", "F2", "F3"]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
      });

      expect(ids).toEqual([]);
      expect(await titles()).toEqual(["A", "B"]);
      const kept = await db.requirement.findUniqueOrThrow({ where: { id: a } });
      expect(kept.reviewStatus).toBe("approved");
      expect(await db.requirementLink.count({ where: { id: link.id } })).toBe(1);
      expect(await db.requirementVersion.count({ where: { requirementId: a } })).toBe(1);
      expect(await db.requirementDataMapping.count({ where: { requirementId: a } })).toBe(2);
      expect(await db.baselineItem.count({ where: { baselineId: baseline.id } })).toBe(2);

      const withheld = (await metadata()).requirementReplacementWithheld as Record<string, unknown>;
      expect(withheld).toMatchObject({
        reason: "reviewed-work",
        existingCount: 2,
        reviewedCount: 2,
        proposedCount: 3,
      });
      // The kept set is not degraded, so no "the requirements below were
      // grouped by keyword" notice may be written for it.
      expect((await metadata()).synthesisDegraded).toBeUndefined();
    });

    // Issue #723 — an EMPTY proposed set returns [] whether it replaced or was
    // withheld, so the withholding is reported to the caller explicitly.
    it("reports a withheld EMPTY replacement through onWithheld, and only then", async () => {
      const [a] = await seedSet(["A"]);
      const replaced: unknown[] = [];
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["B"]),
        findingIdsByIndex: [],
        degraded: null,
        onWithheld: (w) => replaced.push(w),
      });
      expect(replaced).toEqual([]);

      const [b] = await db.requirement.findMany({ where: { analysisId: ANALYSIS } });
      expect(b?.id).not.toBe(a);
      await db.requirement.update({ where: { id: b!.id }, data: { reviewStatus: "approved" } });
      const withheld: unknown[] = [];
      const ids = await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis([]),
        findingIdsByIndex: [],
        degraded: null,
        onWithheld: (w) => withheld.push(w),
      });
      expect(ids).toEqual([]);
      expect(withheld).toEqual([
        expect.objectContaining({ reason: "reviewed-work", existingCount: 1, proposedCount: 0 }),
      ]);
      expect(await titles()).toEqual(["B"]);
    });

    // Each kind of human work, ALONE, must protect the set.
    const signals: Array<[string, (reqId: string, otherId: string) => Promise<unknown>]> = [
      [
        "an approved review status",
        (id) => db.requirement.update({ where: { id }, data: { reviewStatus: "approved" } }),
      ],
      [
        "a rejected review status",
        (id) => db.requirement.update({ where: { id }, data: { reviewStatus: "rejected" } }),
      ],
      [
        "an edit (version bump)",
        (id) => db.requirement.update({ where: { id }, data: { version: 2 } }),
      ],
      [
        "a version-history row",
        (id) =>
          db.requirementVersion.create({
            data: { requirementId: id, version: 1, changedFields: "[]" },
          }),
      ],
      [
        "an outgoing link",
        (id, other) =>
          db.requirementLink.create({
            data: {
              sourceRequirementId: id,
              targetRequirementId: other,
              type: "relates_to",
              createdById: USER,
            },
          }),
      ],
      [
        "an incoming link",
        (id, other) =>
          db.requirementLink.create({
            data: {
              sourceRequirementId: other,
              targetRequirementId: id,
              type: "relates_to",
              createdById: USER,
            },
          }),
      ],
      [
        "a data mapping",
        async (id) => {
          const conn = await db.databaseConnection.create({
            data: { projectId: PROJECT, label: "db1", driver: "postgres" },
          });
          return db.requirementDataMapping.create({
            data: { requirementId: id, dbConnectorId: conn.id, tableName: "t" },
          });
        },
      ],
      [
        "a baseline pin",
        async (id) => {
          const b = await db.baseline.create({
            data: { projectId: PROJECT, name: "pin", createdById: USER },
          });
          return db.baselineItem.create({
            data: { baselineId: b.id, requirementId: id, version: 0 },
          });
        },
      ],
      [
        "a formal review item",
        async (id) => {
          const rr = await db.reviewRequest.create({
            data: { projectId: PROJECT, title: "r", requestedById: USER },
          });
          return db.reviewRequestItem.create({
            data: { reviewRequestId: rr.id, requirementId: id, pinnedVersion: 0 },
          });
        },
      ],
      ["a comment thread", (id) => db.commentThread.create({ data: { requirementId: id } })],
      [
        "an assignment",
        (id) =>
          db.assignment.create({
            data: { requirementId: id, assigneeId: USER, assignedById: USER },
          }),
      ],
      // Issue #779 — the rest of the work a person can attach to a requirement.
      [
        "a stakeholder link",
        async (id) => {
          const sh = await db.stakeholder.create({
            data: { projectId: PROJECT, name: "Ops lead" },
          });
          return db.requirementStakeholder.create({
            data: { requirementId: id, stakeholderId: sh.id },
          });
        },
      ],
      [
        "a manual spec mapping",
        async (id) =>
          db.requirementSpecMapping.create({
            data: {
              requirementId: id,
              specDocumentId: (await specDocument()).id,
              projectId: PROJECT,
              source: "manual",
            },
          }),
      ],
      [
        "a manual code mapping",
        (id) =>
          db.requirementCodeMapping.create({
            data: { requirementId: id, projectId: PROJECT, filePath: "a.ts", source: "manual" },
          }),
      ],
      [
        "an implementation",
        (id) =>
          db.requirementImplementation.create({
            data: {
              requirementId: id,
              prNumber: 7,
              prUrl: "https://example.test/pr/7",
              commitSha: "abc",
              filePath: "a.ts",
              mergedAt: new Date(),
            },
          }),
      ],
      [
        "an issue draft",
        (id) =>
          db.issueDraft.create({
            data: { projectId: PROJECT, requirementId: id, title: "t", body: "b" },
          }),
      ],
      [
        "a discussion thread",
        (id) =>
          db.discussionThread.create({
            data: { projectId: PROJECT, requirementId: id, createdById: USER },
          }),
      ],
      [
        "a soft delete",
        (id) => db.requirement.update({ where: { id }, data: { deletedAt: new Date() } }),
      ],
    ];

    it.each(signals)("keeps the set when one requirement carries %s", async (label, add) => {
      const [first, second] = await seedSet(["A", "B"]);
      await add(second, first);
      const ids = await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["C"]),
        findingIdsByIndex: [],
        degraded: null,
      });
      expect(ids).toEqual([]);
      expect(await titles()).toEqual(["A", "B"]);
      // A link is work on BOTH of its endpoints.
      expect((await metadata()).requirementReplacementWithheld).toMatchObject({
        reason: "reviewed-work",
        reviewedCount: /(outgoing|incoming) link/.test(label) ? 2 : 1,
      });
    });

    // #779 — generated mappings and abandoned drafts/threads are not review work.
    const nonSignals: Array<[string, (reqId: string) => Promise<unknown>]> = [
      [
        "a derived spec mapping",
        async (id) =>
          db.requirementSpecMapping.create({
            data: {
              requirementId: id,
              specDocumentId: (await specDocument()).id,
              projectId: PROJECT,
            },
          }),
      ],
      [
        "a semantic code mapping",
        (id) =>
          db.requirementCodeMapping.create({
            data: { requirementId: id, projectId: PROJECT, filePath: "a.ts" },
          }),
      ],
      [
        "a deleted issue draft",
        (id) =>
          db.issueDraft.create({
            data: {
              projectId: PROJECT,
              requirementId: id,
              title: "t",
              body: "b",
              deletedAt: new Date(),
            },
          }),
      ],
      [
        "a deleted discussion thread",
        (id) =>
          db.discussionThread.create({
            data: {
              projectId: PROJECT,
              requirementId: id,
              createdById: USER,
              deletedAt: new Date(),
            },
          }),
      ],
    ];

    it.each(nonSignals)("replaces the set when a requirement carries only %s", async (_l, add) => {
      const [a] = await seedSet(["A"]);
      await add(a!);
      await seedSet(["C"]);
      expect(await titles()).toEqual(["C"]);
    });

    // #779 — the check, the markers, the delete and the inserts are one
    // transaction: a failed insert leaves the previous set AND its markers.
    it("a failed insert rolls back the delete and the metadata markers", async () => {
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F1", "F2"]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
      });
      const before = await metadata();
      expect(before.synthesisDegraded).toMatchObject({ reason: "non-json" });

      // The second insert of the replacement fails, wherever it is issued.
      let creates = 0;
      const failSecondCreate = (requirement: PrismaClient["requirement"]) =>
        new Proxy(requirement, {
          get(target, prop, receiver) {
            if (prop !== "create") return Reflect.get(target, prop, receiver);
            return (args: Parameters<PrismaClient["requirement"]["create"]>[0]) => {
              creates += 1;
              if (creates === 2) return Promise.reject(new Error("disk full"));
              return target.create(args);
            };
          },
        });
      const withRequirement = <T extends object>(client: T, requirement: unknown): T =>
        new Proxy(client, {
          get: (target, prop, receiver) =>
            prop === "requirement" ? requirement : Reflect.get(target, prop, receiver),
        });
      state.db = new Proxy(withRequirement(db, failSecondCreate(db.requirement)), {
        get(target, prop, receiver) {
          if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
          return (fn: (tx: unknown) => Promise<unknown>, opts?: { timeout?: number }) =>
            db.$transaction(
              (tx) => fn(withRequirement(tx, failSecondCreate(tx.requirement))),
              opts,
            );
        },
      });

      try {
        await expect(
          persistRequirements({
            analysisId: ANALYSIS,
            projectId: PROJECT,
            synthesis: synthesis(["H1", "H2", "H3"]),
            findingIdsByIndex: [],
            degraded: null,
          }),
        ).rejects.toThrow("disk full");
      } finally {
        state.db = db;
      }

      expect(await titles()).toEqual(["F1", "F2"]);
      expect(await metadata()).toEqual(before);
    });

    it("an explicit 'draft' review status is not review work — the set is replaced", async () => {
      const [a] = await seedSet(["A"]);
      await db.requirement.update({ where: { id: a }, data: { reviewStatus: "draft" } });
      await seedSet(["C"]);
      expect(await titles()).toEqual(["C"]);
    });

    it("a soft-deleted data mapping is not review work — the set is replaced", async () => {
      const [a] = await seedSet(["A"]);
      const conn = await db.databaseConnection.create({
        data: { projectId: PROJECT, label: "db2", driver: "postgres" },
      });
      await db.requirementDataMapping.create({
        data: { requirementId: a, dbConnectorId: conn.id, tableName: "t", deletedAt: new Date() },
      });
      await seedSet(["C"]);
      expect(await titles()).toEqual(["C"]);
    });

    it("a degraded re-synthesis never overwrites an unreviewed HEALTHY set", async () => {
      await seedSet(["A", "B"]);
      const ids = await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F1"]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
      });
      expect(ids).toEqual([]);
      expect(await titles()).toEqual(["A", "B"]);
      const meta = await metadata();
      expect(meta.requirementReplacementWithheld).toMatchObject({
        reason: "degraded-synthesis",
        existingCount: 2,
        reviewedCount: 0,
        proposedCount: 1,
      });
      expect(meta.synthesisDegraded).toBeUndefined();
    });

    it("a degraded synthesis may replace a previous DEGRADED set, and records itself", async () => {
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F1"]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
      });
      expect(await titles()).toEqual(["F1"]);
      expect((await metadata()).synthesisDegraded).toMatchObject({ reason: "non-json" });

      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F2"]),
        findingIdsByIndex: [],
        degraded: { ...DEGRADED, reason: "provider-error" },
      });
      expect(await titles()).toEqual(["F2"]);
      expect((await metadata()).synthesisDegraded).toMatchObject({ reason: "provider-error" });
    });

    it("a healthy re-synthesis replaces a degraded set and clears both stale markers", async () => {
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F1"]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
      });
      // A refusal recorded earlier must not outlive the next allowed replacement.
      await db.analysis.update({
        where: { id: ANALYSIS },
        data: {
          metadata: JSON.stringify({
            ...(await metadata()),
            requirementReplacementWithheld: { reason: "degraded-synthesis" },
            model: "keep-me",
          }),
        },
      });
      await seedSet(["H"]);
      expect(await titles()).toEqual(["H"]);
      const meta = await metadata();
      expect(meta.synthesisDegraded).toBeUndefined();
      expect(meta.requirementReplacementWithheld).toBeUndefined();
      expect(meta.model).toBe("keep-me");
    });

    it("leaves the degraded/withheld markers alone when the caller does not report synthesis health", async () => {
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F1"]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
      });
      // The approval-gate promotion path (#1104) does not know the health of
      // the synthesis it promotes; the orchestrator recorded it already.
      await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["G"]),
        findingIdsByIndex: [],
      });
      expect(await titles()).toEqual(["G"]);
      expect((await metadata()).synthesisDegraded).toMatchObject({ reason: "non-json" });
    });

    it("a degraded first synthesis with nothing to protect is persisted", async () => {
      const ids = await persistRequirements({
        analysisId: ANALYSIS,
        projectId: PROJECT,
        synthesis: synthesis(["F1", "F2"]),
        findingIdsByIndex: [],
        degraded: DEGRADED,
      });
      expect(ids).toHaveLength(2);
      expect(await titles()).toEqual(["F1", "F2"]);
    });

    it("never consults another analysis's requirements (scoped by analysisId)", async () => {
      await db.analysis.create({
        data: { id: "other", projectId: PROJECT, startedById: USER, status: "completed" },
      });
      const other = await db.requirement.create({
        data: {
          analysisId: "other",
          projectId: PROJECT,
          title: "O",
          body: "b",
          reviewStatus: "approved",
        },
      });
      await seedSet(["A"]);
      await seedSet(["C"]);
      expect(await titles()).toEqual(["C"]);
      expect(await db.requirement.count({ where: { id: other.id } })).toBe(1);
    });
  },
);
