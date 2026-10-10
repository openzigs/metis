/**
 * Issue #744 — three Publishing-page defects, proven against a REAL SQLite
 * database built by the real migration chain, reading back through the same
 * production queries the Publishing page uses:
 *
 *  1. a rejected requirement becomes no draft, and a draft generated for it
 *     before the rejection is withdrawn rather than left publishable;
 *  2. no `finding:<id>` label reaches a draft or the dry-run plan, and the plan
 *     upserts only labels some draft carries (not all nine base labels);
 *  3. the dry-run plan carries the approval gate's verdict and marks the drafts
 *     a live run would refuse with 409 APPROVAL_REQUIRED.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { DryRunPlan } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const { generateDrafts, listDraftCandidates } =
  await import("../src/lib/publishing/draft-generator.js");
const { runBatch } = await import("../src/lib/publishing/publisher.js");

const T0 = "2026-09-01T00:00:00.000Z";
const target = { targetOwner: "acme", targetRepo: "metis" };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#744 — rejected requirements, internal-id labels and the dry-run approval gate (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("744-publishing");
      sqlite.exec(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [T0, T0],
      );
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /** A project + analysis with a kept, a rejected and a legacy-rejected requirement. */
    async function seed(p: string) {
      await db.project.create({
        data: { id: p, name: "Miniflux", slug: `slug-${p}`, createdById: "u1" },
      });
      const analysisId = `an_${p}`;
      await db.analysis.create({ data: { id: analysisId, projectId: p, startedById: "u1" } });
      const req = (id: string, title: string, extra: Record<string, unknown>) =>
        db.requirement.create({
          data: {
            id: `${id}_${p}`,
            projectId: p,
            analysisId,
            title,
            body: `${title} body`,
            ...extra,
          },
        });
      await req("keep", "Feed refresh", {
        reviewStatus: "approved",
        labels: JSON.stringify(["feeds", "finding:cmv1tix0d0vyu7d9kr8tbqrgq"]),
      });
      await req("rej", "Legacy Atom 0.3 support", {
        reviewStatus: "rejected",
        labels: JSON.stringify(["finding:cmv1tj3gm0vyy7d9k9dncw7fg"]),
      });
      // Written before the typed column existed: the status lives in a label.
      await req("legacy", "OPML import", {
        labels: JSON.stringify(["review:rejected"]),
      });
      return { analysisId, keepId: `keep_${p}`, rejId: `rej_${p}`, legacyId: `legacy_${p}` };
    }

    async function liveDrafts(projectId: string) {
      return db.issueDraft.findMany({ where: { projectId, deletedAt: null } });
    }

    async function dryRun(projectId: string): Promise<{
      plan: DryRunPlan;
      errorMessage: string | null;
    }> {
      const drafts = await liveDrafts(projectId);
      const batch = await db.publishBatch.create({
        data: {
          projectId,
          ...target,
          dryRun: true,
          startedById: "u1",
          metadata: JSON.stringify({ draftIds: drafts.map((d) => d.id), additionalLabels: [] }),
        },
      });
      await runBatch({ batchId: batch.id, dryRun: true, secretRef: null });
      const row = await db.publishBatch.findUniqueOrThrow({ where: { id: batch.id } });
      return {
        plan: JSON.parse(row.dryRunPlan ?? "null") as DryRunPlan,
        errorMessage: row.errorMessage,
      };
    }

    it("drafts no rejected requirement (typed column or legacy label)", async () => {
      const { analysisId, keepId, rejId, legacyId } = await seed("p1");
      await generateDrafts({ projectId: "p1", analysisId, ...target });

      const drafts = await liveDrafts("p1");
      const reqIds = drafts.map((d) => d.requirementId).filter(Boolean);
      expect(reqIds).toEqual([keepId]);
      expect(reqIds).not.toContain(rejId);
      expect(reqIds).not.toContain(legacyId);
      const epic = drafts.find((d) => d.draftType === "epic")!;
      expect(JSON.parse(epic.metadata ?? "{}").requirementIds).toEqual([keepId]);

      const candidates = await listDraftCandidates("p1", analysisId);
      expect(candidates.requirements.map((r) => r.id)).toEqual([keepId]);
    });

    it("never copies a finding:<id> label onto a draft", async () => {
      const feature = (await liveDrafts("p1")).find((d) => d.draftType !== "epic")!;
      const labels = JSON.parse(feature.labels) as string[];
      expect(labels).toContain("feeds");
      expect(labels.some((l) => l.startsWith("finding:"))).toBe(false);
    });

    it("withdraws an unpublished draft generated before its requirement was rejected", async () => {
      const { analysisId, keepId } = await seed("p2");
      await generateDrafts({ projectId: "p2", analysisId, ...target });
      // Reviewer rejects the kept requirement after drafts exist.
      await db.requirement.update({ where: { id: keepId }, data: { reviewStatus: "rejected" } });
      await db.requirement.create({
        data: {
          id: "other_p2",
          projectId: "p2",
          analysisId,
          title: "Keyboard shortcuts",
          body: "b",
          reviewStatus: "approved",
        },
      });
      await generateDrafts({ projectId: "p2", analysisId, ...target });

      const live = await liveDrafts("p2");
      expect(live.map((d) => d.requirementId)).not.toContain(keepId);
      expect(live.map((d) => d.requirementId)).toContain("other_p2");
      const withdrawn = await db.issueDraft.findFirstOrThrow({ where: { requirementId: keepId } });
      expect(withdrawn.deletedAt).not.toBeNull();
    });

    it("leaves a published draft of a later-rejected requirement alone", async () => {
      const { analysisId, keepId } = await seed("p3");
      await generateDrafts({ projectId: "p3", analysisId, ...target });
      const published = await db.issueDraft.findFirstOrThrow({ where: { requirementId: keepId } });
      await db.issueDraft.update({ where: { id: published.id }, data: { status: "published" } });
      await db.requirement.update({ where: { id: keepId }, data: { reviewStatus: "rejected" } });

      await expect(
        generateDrafts({ projectId: "p3", analysisId, ...target }),
      ).rejects.toMatchObject({ code: "NO_REQUIREMENTS", details: { rejectedCount: 3 } });
      const after = await db.issueDraft.findUniqueOrThrow({ where: { id: published.id } });
      expect(after.deletedAt).toBeNull();
      expect(after.status).toBe("published");
    });

    it("plans no internal-id label and only the labels some draft carries", async () => {
      // Legacy drafts generated before #744 still carry finding labels.
      const legacy = (await liveDrafts("p1")).find((d) => d.draftType !== "epic")!;
      await db.issueDraft.update({
        where: { id: legacy.id },
        data: {
          labels: JSON.stringify([...JSON.parse(legacy.labels), "finding:cmv1tj3gq0vz27d9k"]),
        },
      });

      const { plan } = await dryRun("p1");
      const upserted = plan.actions
        .filter((a) => a.kind === "label.upsert")
        .flatMap((a) => a.labels ?? []);
      expect(upserted.some((l) => l.startsWith("finding:"))).toBe(false);
      for (const unused of ["bug", "task", "priority:low", "priority:critical"]) {
        expect(upserted).not.toContain(unused);
      }
      const carried = new Set(
        plan.actions.filter((a) => a.kind === "issue.create").flatMap((a) => a.labels ?? []),
      );
      expect(new Set(upserted)).toEqual(carried);
      for (const a of plan.actions.filter((x) => x.kind === "issue.create")) {
        expect((a.labels ?? []).some((l) => l.startsWith("finding:"))).toBe(false);
      }
    });

    it("reports the gate as off when the project does not require approval", async () => {
      const { plan, errorMessage } = await dryRun("p1");
      expect(plan.approvalGate).toEqual({ check: "off", blockedDraftIds: [] });
      expect(plan.actions.some((a) => a.blockedByApprovalGate)).toBe(false);
      // Only the (missing) credential is warned about.
      expect(errorMessage).not.toContain("APPROVAL_REQUIRED");
    });

    it("marks the drafts the gate would block, and warns the live run will be refused", async () => {
      await db.project.update({ where: { id: "p1" }, data: { requireApprovedReview: true } });
      const { plan, errorMessage } = await dryRun("p1");

      const drafts = await liveDrafts("p1");
      expect(plan.approvalGate?.check).toBe("blocked");
      expect([...(plan.approvalGate?.blockedDraftIds ?? [])].sort()).toEqual(
        drafts.map((d) => d.id).sort(),
      );
      const creates = plan.actions.filter((a) => a.kind === "issue.create");
      expect(creates.length).toBe(2);
      expect(creates.every((a) => a.blockedByApprovalGate === true)).toBe(true);
      expect(errorMessage).toContain("APPROVAL_REQUIRED");
    });

    it("passes the gate once the requirement has an approved, current review", async () => {
      const keep = await db.requirement.findUniqueOrThrow({ where: { id: "keep_p1" } });
      await db.reviewRequest.create({
        data: {
          projectId: "p1",
          title: "Sign-off",
          status: "approved",
          requestedById: "u1",
          items: { create: [{ requirementId: keep.id, pinnedVersion: keep.version }] },
        },
      });
      const { plan, errorMessage } = await dryRun("p1");
      expect(plan.approvalGate).toEqual({ check: "passed", blockedDraftIds: [] });
      expect(plan.actions.some((a) => a.blockedByApprovalGate)).toBe(false);
      expect(errorMessage ?? "").not.toContain("approval gate");
    });
  },
);
