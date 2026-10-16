/**
 * Issue #1220 — import re-sync no longer reverts analysts' edits.
 *
 * Re-sync used to be "source wins": every imported row whose text differed
 * from the source was rewritten, even when the source had not changed. Each
 * row now remembers the source content it was last synced to (a fingerprint),
 * so a re-sync can tell the four cases apart, plus rows that predate it.
 *
 * Proven end to end against a real SQLite database built from the migration
 * chain: the real ImportService (GitHub importer over a stubbed `fetch`), the
 * real requirements router (edit, "Take the source version", "Keep mine",
 * History) with the real project-access guard, the real analysis snapshot, and
 * the real approval gate.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
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
    // `persistRequirements` (the #769 replacement guard) asks which backend.
    resolveDatabaseProvider: () => "sqlite",
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { ImportService } = await import("../src/lib/importers/import-service.js");
const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { assertRequirementsExportable } = await import("../src/lib/reviews/approval-gate.js");
const { getAnalysisSnapshot, persistRequirements } =
  await import("../src/lib/analysis/analysis-service.js");
const { SOURCE_TAKEN_VERSION_REASON } =
  await import("../src/lib/requirements/source-divergence.js");
const { audit } = await import("../src/lib/audit/audit-service.js");

const PROJECT = "proj-1220";
const ANALYSIS = "ana-1220";
const ANALYST = "u-1220-analyst";
const READER = "u-1220-reader";
const OUTSIDER = "u-1220-out";

interface GhIssue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  labels: Array<{ name: string }>;
}

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function ghIssue(number: number, over: Partial<GhIssue> = {}): GhIssue {
  return {
    number,
    title: `Export orders ${number}`,
    body: "As imported",
    html_url: `https://github.com/o/r/issues/${number}`,
    state: "open",
    labels: [{ name: "export" }],
    ...over,
  };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1220 — import re-sync keeps analysts' edits",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let ANALYST_TOKEN = "";
    let READER_TOKEN = "";
    let OUTSIDER_TOKEN = "";
    let issues: GhIssue[] = [];
    let svc: InstanceType<typeof ImportService>;
    let sourceId = "";
    let seq = 0;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/requirements", requirementsCollaborationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const edit = (id: string, body: Record<string, unknown>, token = ANALYST_TOKEN) =>
      request(app())
        .put(`/api/requirements/${id}`)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
    const resolve = (id: string, body: Record<string, unknown>, token = ANALYST_TOKEN) =>
      request(app())
        .post(`/api/requirements/${id}/source-divergence`)
        .set("Authorization", `Bearer ${token}`)
        .send(body);
    const history = (id: string) =>
      request(app())
        .get(`/api/requirements/${id}/history`)
        .set("Authorization", `Bearer ${ANALYST_TOKEN}`);

    const sync = () => svc.runSource(sourceId, { trigger: "manual" });
    const row = (id: string) => db.requirement.findUniqueOrThrow({ where: { id } });
    const versionsOf = (requirementId: string) =>
      db.requirementVersion.findMany({ where: { requirementId }, orderBy: { version: "desc" } });
    const importedId = async (number: number) =>
      (
        await db.requirement.findFirstOrThrow({
          where: { importSourceId: sourceId, externalId: String(number) },
        })
      ).id;

    /** An approved review pinned to the requirement's current version. */
    const approve = async (requirementId: string) => {
      seq += 1;
      const { version } = await row(requirementId);
      await db.reviewRequest.create({
        data: {
          id: `rr-1220-${seq}`,
          projectId: PROJECT,
          title: "Sign-off",
          status: "approved",
          requestedById: ANALYST,
          items: { create: [{ requirementId, pinnedVersion: version }] },
        },
      });
    };
    const isApprovedCurrent = async (requirementId: string) =>
      assertRequirementsExportable({
        projectId: PROJECT,
        requirementIds: [requirementId],
        context: "test.1220",
      }).then(
        () => true,
        () => false,
      );

    /** Import #n, edit it locally, approve it, then change it upstream. */
    const diverge = async (n: number) => {
      issues = [ghIssue(n)];
      await sync();
      const id = await importedId(n);
      expect((await edit(id, { body: "Refined by the analyst", version: 0 })).status).toBe(200);
      await approve(id);
      issues = [ghIssue(n, { body: "Changed upstream" })];
      const run = await sync();
      expect(run).toMatchObject({ status: "completed", divergedCount: 1 });
      return id;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1220-import-resync");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [ANALYST, READER, OUTSIDER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1220", name: "ws", slug: "ws-1220" } });
      await db.workspace.create({ data: { id: "ws-1220-x", name: "wsx", slug: "ws-1220-x" } });
      for (const userId of [ANALYST, READER]) {
        await db.workspaceMember.create({
          data: { workspaceId: "ws-1220", userId, role: "member" },
        });
      }
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1220-x", userId: OUTSIDER, role: "owner" },
      });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: ANALYST,
          workspaceId: "ws-1220",
          // The approval gate is off by default; without it every
          // `isApprovedCurrent` would read true whatever the version.
          requireApprovedReview: true,
        },
      });
      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJECT, startedById: ANALYST, status: "completed" },
      });
      const token = (userId: string, role: "coordinator" | "reader", ws: string) =>
        issueTokens({ userId, username: userId, role, permissions: [], workspaces: [ws] })
          .accessToken;
      ANALYST_TOKEN = token(ANALYST, "coordinator", "ws-1220");
      READER_TOKEN = token(READER, "reader", "ws-1220");
      OUTSIDER_TOKEN = token(OUTSIDER, "coordinator", "ws-1220-x");

      svc = new ImportService({
        prisma: db,
        vault: {
          create: vi.fn(),
          read: vi.fn(async () => ({ summary: {} as never, plaintext: "tok" })),
          delete: vi.fn(),
        },
        enqueueTask: vi.fn(async () => ({ id: "task_1" })),
        createScheduledJob: vi.fn(async () => ({ id: "job_1" })),
        deleteScheduledJob: vi.fn(async () => undefined),
        resolveJira: vi.fn(),
        importerDeps: {
          fetchFn: vi.fn(async (url: string | URL | Request) =>
            String(url).includes("/graphql")
              ? res(200, { data: { search: { issueCount: issues.length } } })
              : res(200, issues),
          ),
          assertHostAllowed: () => undefined,
          backoff: { sleep: async () => undefined, now: () => 0, random: () => 0 },
        },
      } as unknown as ConstructorParameters<typeof ImportService>[0]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(async () => {
      // A fresh source per test, so each one's imported rows are its own.
      seq += 1;
      const source = await db.importSource.create({
        data: {
          projectId: PROJECT,
          analysisId: ANALYSIS,
          source: "github",
          label: `GH ${seq}`,
          filter: JSON.stringify({ owner: "o", repo: `r${seq}`, state: "open" }),
          secretId: "secret_1",
          createdById: ANALYST,
        },
      });
      sourceId = source.id;
      // Each source imports into its own external-id space.
      await db.requirement.updateMany({
        where: { projectId: PROJECT, externalSource: "github" },
        data: { deletedAt: new Date() },
      });
      vi.mocked(audit).mockClear();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("records the source fingerprint on import, and an unchanged re-sync writes nothing", async () => {
      issues = [ghIssue(1)];
      expect(await sync()).toMatchObject({ status: "completed", createdCount: 1 });
      const id = await importedId(1);
      const imported = await row(id);
      expect(imported.sourceFingerprint).toMatch(/^v1:[0-9a-f]{64}$/);

      const again = await sync();

      expect(again).toMatchObject({
        createdCount: 0,
        updatedCount: 0,
        keptLocalCount: 0,
        divergedCount: 0,
      });
      expect((await row(id)).updatedAt).toEqual(imported.updatedAt);
    });

    it("source unchanged, local edited: keeps the edit, and an approved review stays current", async () => {
      issues = [ghIssue(2)];
      await sync();
      const id = await importedId(2);
      const edited = await edit(id, {
        title: "Export orders as CSV",
        body: "Refined by the analyst",
        priority: "high",
        labels: ["export", "csv"],
        version: 0,
      });
      expect(edited.status).toBe(200);
      // Control: the gate is live — an unapproved requirement does not pass.
      expect(await isApprovedCurrent(id)).toBe(false);
      await approve(id);
      expect(await isApprovedCurrent(id)).toBe(true);

      const run = await sync();

      expect(run).toMatchObject({ updatedCount: 0, keptLocalCount: 1, divergedCount: 0 });
      expect(await row(id)).toMatchObject({
        title: "Export orders as CSV",
        body: "Refined by the analyst",
        priority: "high",
        labels: JSON.stringify(["export", "csv"]),
        version: 1,
        sourcePending: null,
      });
      expect(await versionsOf(id)).toHaveLength(1);
      expect(await isApprovedCurrent(id)).toBe(true);
    });

    it("a kept row is still re-pointed at a recreated source and a moved issue URL", async () => {
      issues = [ghIssue(20)];
      await sync();
      const id = await importedId(20);
      expect((await edit(id, { body: "Refined by the analyst", version: 0 })).status).toBe(200);
      const firstSource = sourceId;

      // The source is recreated (new id), and the issue now lives at a new URL.
      seq += 1;
      const recreated = await db.importSource.create({
        data: {
          projectId: PROJECT,
          analysisId: ANALYSIS,
          source: "github",
          label: `GH recreated ${seq}`,
          filter: JSON.stringify({ owner: "o", repo: "moved", state: "open" }),
          secretId: "secret_1",
          createdById: ANALYST,
        },
      });
      sourceId = recreated.id;
      issues = [ghIssue(20, { html_url: "https://github.com/o/moved/issues/20" })];

      expect(await sync()).toMatchObject({ keptLocalCount: 1, updatedCount: 0, createdCount: 0 });
      expect(await row(id)).toMatchObject({
        body: "Refined by the analyst",
        version: 1,
        externalUrl: "https://github.com/o/moved/issues/20",
        importSourceId: recreated.id,
      });
      expect(recreated.id).not.toBe(firstSource);
    });

    it("source changed, local not edited: applies the source", async () => {
      issues = [ghIssue(3)];
      await sync();
      const id = await importedId(3);
      const before = await row(id);

      issues = [ghIssue(3, { title: "Export orders 3 to CSV", labels: [{ name: "csv" }] })];
      const run = await sync();

      expect(run).toMatchObject({ updatedCount: 1, keptLocalCount: 0, divergedCount: 0 });
      const after = await row(id);
      expect(after).toMatchObject({
        title: "Export orders 3 to CSV",
        labels: JSON.stringify(["csv"]),
        sourcePending: null,
      });
      expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
      // And the applied source is now the baseline: a further sync does nothing.
      expect(await sync()).toMatchObject({ updatedCount: 0, keptLocalCount: 0, divergedCount: 0 });
    });

    it("both changed: diverged — keeps the analyst's text, records the source's, review stays current", async () => {
      const id = await diverge(4);
      const after = await row(id);

      expect(after).toMatchObject({ body: "Refined by the analyst", version: 1 });
      expect(JSON.parse(after.sourcePending!)).toMatchObject({
        title: "Export orders 4",
        body: "Changed upstream",
        labels: ["export"],
      });
      expect(await versionsOf(id)).toHaveLength(1);
      expect(await isApprovedCurrent(id)).toBe(true);

      // The analysis snapshot carries the source's version for the card.
      const snapshot = await getAnalysisSnapshot(ANALYSIS);
      const req = snapshot!.requirements.find((r) => r.id === id)!;
      expect(req.sourceDivergence).toMatchObject({
        sourceFingerprint: JSON.parse(after.sourcePending!).fingerprint,
        source: { body: "Changed upstream", title: "Export orders 4" },
      });

      // A further sync of the same source leaves the record as it was.
      expect(await sync()).toMatchObject({ divergedCount: 1, updatedCount: 0 });
      expect((await row(id)).sourcePending).toBe(after.sourcePending);
    });

    it("Keep mine: no version, the approved review stays current, the decision is the analyst's", async () => {
      const id = await diverge(5);
      const { sourcePending } = await row(id);
      const fingerprint = JSON.parse(sourcePending!).fingerprint as string;
      expect(await isApprovedCurrent(id)).toBe(true);

      const kept = await resolve(id, { choice: "local", sourceFingerprint: fingerprint });

      expect(kept.status).toBe(200);
      expect(kept.body.data).toMatchObject({ choice: "local", changed: false, version: 1 });
      const after = await row(id);
      expect(after).toMatchObject({
        body: "Refined by the analyst",
        version: 1,
        sourcePending: null,
        sourceFingerprint: fingerprint,
        sourceDecisionActorId: ANALYST,
      });
      expect(after.sourceDecidedAt).toBeInstanceOf(Date);
      // No version row: the only one is the analyst's earlier edit.
      expect(await versionsOf(id)).toHaveLength(1);
      // The analyst's text is unchanged, so the approval of it stands...
      expect(await isApprovedCurrent(id)).toBe(true);
      // ...and the gate is live: a requirement with no approved review is refused.
      issues = [ghIssue(55)];
      await sync();
      expect(await isApprovedCurrent(await importedId(55))).toBe(false);
      issues = [ghIssue(5, { body: "Changed upstream" })];
      const h = await history(id);
      expect(h.body.data.sourceDecision).toMatchObject({ choice: "local", actorId: ANALYST });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "requirement.source_divergence.resolve" }),
      );

      // The declined source is now the baseline: the next sync keeps the edit.
      expect(await sync()).toMatchObject({ keptLocalCount: 1, divergedCount: 0, updatedCount: 0 });
    });

    it("Take the source version: a History version row, and an approved review goes stale", async () => {
      const id = await diverge(6);
      const fingerprint = JSON.parse((await row(id)).sourcePending!).fingerprint as string;

      const taken = await resolve(id, {
        choice: "source",
        sourceFingerprint: fingerprint,
        version: 1,
      });

      expect(taken.status).toBe(200);
      expect(taken.body.data).toMatchObject({ choice: "source", changed: true, version: 2 });
      expect(await row(id)).toMatchObject({
        body: "Changed upstream",
        version: 2,
        sourcePending: null,
        sourceFingerprint: fingerprint,
      });
      const [v2] = await versionsOf(id);
      expect(v2).toMatchObject({
        version: 2,
        actorId: ANALYST,
        reason: SOURCE_TAKEN_VERSION_REASON,
      });
      expect(JSON.parse(v2!.changedFields)).toEqual({
        body: { from: "Refined by the analyst", to: "Changed upstream" },
      });
      expect(await isApprovedCurrent(id)).toBe(false);
      expect((await history(id)).body.data.sourceDecision).toMatchObject({ choice: "source" });

      expect(await sync()).toMatchObject({ keptLocalCount: 0, divergedCount: 0, updatedCount: 0 });
    });

    it("rows imported before the fingerprint: equal ones are recorded, edited ones flagged, never overwritten", async () => {
      issues = [ghIssue(7), ghIssue(8)];
      await sync();
      const same = await importedId(7);
      const edited = await importedId(8);
      // What the sync records for #7: the fingerprint of its (unchanged) source.
      const expectedFingerprint = (await row(same)).sourceFingerprint;
      expect(expectedFingerprint).toMatch(/^v1:/);
      // As a pre-#1220 import left them: no fingerprint; #8 edited since.
      await db.requirement.updateMany({
        where: { id: { in: [same, edited] } },
        data: { sourceFingerprint: null },
      });
      await db.requirement.update({ where: { id: edited }, data: { body: "Edited before #1220" } });
      expect((await row(same)).sourceFingerprint).toBeNull();

      const run = await sync();

      expect(run).toMatchObject({ updatedCount: 0, keptLocalCount: 0, divergedCount: 1 });
      expect(await row(same)).toMatchObject({
        sourceFingerprint: expectedFingerprint,
        sourcePending: null,
        body: "As imported",
      });
      const flagged = await row(edited);
      expect(flagged).toMatchObject({ body: "Edited before #1220", sourceFingerprint: null });
      expect(JSON.parse(flagged.sourcePending!)).toMatchObject({ body: "As imported" });
    });

    it("after Keep mine, the requirement set is protected from replacement by a re-synthesis (#769)", async () => {
      // Each in its own analysis, so nothing else in the set counts as review work.
      const setUp = async (n: number) => {
        const analysisId = `ana-1220-guard-${n}`;
        await db.analysis.create({
          data: { id: analysisId, projectId: PROJECT, startedById: ANALYST, status: "completed" },
        });
        seq += 1;
        const source = await db.importSource.create({
          data: {
            projectId: PROJECT,
            analysisId,
            source: "github",
            label: `GH guard ${n}`,
            filter: JSON.stringify({ owner: "o", repo: `guard${n}`, state: "open" }),
            secretId: "secret_1",
            createdById: ANALYST,
          },
        });
        sourceId = source.id;
        issues = [ghIssue(n)];
        await sync();
        const id = await importedId(n);
        // A pre-#1220 edit: written straight to the row, so no version, no actor.
        await db.requirement.update({
          where: { id },
          data: { body: "Edited before #1220", sourceFingerprint: null },
        });
        expect(await sync()).toMatchObject({ divergedCount: 1 });
        expect(await row(id)).toMatchObject({ version: 0 });
        return { analysisId, id };
      };
      const resynthesise = (analysisId: string) => {
        const onWithheld = vi.fn();
        return persistRequirements({
          analysisId,
          projectId: PROJECT,
          synthesis: {
            summary: "s",
            requirements: [
              {
                type: "feature",
                title: "Replacement",
                body: "b",
                priority: "medium",
                labels: [],
                evidenceFindingIndexes: [],
                acceptanceCriteria: [],
              },
            ],
          },
          findingIdsByIndex: [],
          onWithheld,
        }).then(() => onWithheld);
      };

      // Control: a diverged row nobody answered is not review work — replaced.
      const control = await setUp(15);
      expect(await resynthesise(control.analysisId)).not.toHaveBeenCalled();
      expect(await db.requirement.findUnique({ where: { id: control.id } })).toBeNull();

      // Keep mine makes it the analyst's: the replacement is withheld.
      const kept = await setUp(16);
      const fingerprint = JSON.parse((await row(kept.id)).sourcePending!).fingerprint as string;
      expect(
        (await resolve(kept.id, { choice: "local", sourceFingerprint: fingerprint })).status,
      ).toBe(200);
      // Recorded as the analyst's decision, with no version row.
      expect(await versionsOf(kept.id)).toHaveLength(0);
      expect(await row(kept.id)).toMatchObject({ version: 0, sourceDecisionActorId: ANALYST });
      expect(await resynthesise(kept.analysisId)).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "reviewed-work" }),
      );
      expect(await row(kept.id)).toMatchObject({ body: "Edited before #1220" });
    });

    it("Take the source version keeps METIS's hidden traceability labels", async () => {
      const id = await diverge(14);
      // Labels METIS adds itself; the source never carries them.
      await db.requirement.update({
        where: { id },
        data: { labels: JSON.stringify(["export", "finding:f-1220", "review:approved"]) },
      });
      const fingerprint = JSON.parse((await row(id)).sourcePending!).fingerprint as string;

      const taken = await resolve(id, { choice: "source", sourceFingerprint: fingerprint });

      expect(taken.status).toBe(200);
      const labels = JSON.parse((await row(id)).labels) as string[];
      expect(labels).toEqual(
        expect.arrayContaining(["export", "finding:f-1220", "review:approved"]),
      );
      expect((await row(id)).body).toBe("Changed upstream");
      // And the kept hidden labels do not make the next sync see a divergence.
      expect(await sync()).toMatchObject({ keptLocalCount: 0, divergedCount: 0, updatedCount: 0 });
    });

    describe("POST /api/requirements/:id/source-divergence", () => {
      it("refuses an answer to a source that moved since it was loaded", async () => {
        const id = await diverge(9);
        const r = await resolve(id, { choice: "source", sourceFingerprint: "v1:stale" });
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe("SOURCE_MOVED");
        expect((await row(id)).body).toBe("Refined by the analyst");
      });

      it("refuses a requirement that is not diverged", async () => {
        issues = [ghIssue(10)];
        await sync();
        const id = await importedId(10);
        const r = await resolve(id, { choice: "local", sourceFingerprint: "v1:any" });
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe("NOT_DIVERGED");
      });

      it("taking the source over a version the analyst did not see is a conflict", async () => {
        const id = await diverge(11);
        const fingerprint = JSON.parse((await row(id)).sourcePending!).fingerprint as string;
        const r = await resolve(id, {
          choice: "source",
          sourceFingerprint: fingerprint,
          version: 0,
        });
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe("VERSION_CONFLICT");
        expect(await row(id)).toMatchObject({ body: "Refined by the analyst", version: 1 });
      });

      it("validates the body", async () => {
        const id = await diverge(12);
        for (const body of [{}, { choice: "both", sourceFingerprint: "x" }, { choice: "local" }]) {
          expect((await resolve(id, body)).status).toBe(400);
        }
      });

      it("is the project's: a reader cannot answer, an outsider cannot see it", async () => {
        const id = await diverge(13);
        const fingerprint = JSON.parse((await row(id)).sourcePending!).fingerprint as string;
        const body = { choice: "source", sourceFingerprint: fingerprint };

        expect((await resolve(id, body, READER_TOKEN)).status).toBe(403);
        expect((await resolve(id, body, OUTSIDER_TOKEN)).status).toBe(404);
        expect(
          (await request(app()).post(`/api/requirements/${id}/source-divergence`).send(body))
            .status,
        ).toBe(401);
        expect(await row(id)).toMatchObject({ body: "Refined by the analyst", version: 1 });
        expect((await row(id)).sourcePending).not.toBeNull();
      });
    });
  },
);
