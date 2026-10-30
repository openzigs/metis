/**
 * #1569 — a synthesis item that restates no reviewed requirement is offered for
 * approval and, once approved, promoted with its acceptance criteria, proven
 * against a REAL SQLite database built from the migration chain. The read-back
 * goes through the paths a reviewer's screen and the promoted rows use: the
 * analysis metadata's reviewed list, the approval rows, and the `requirements`
 * rows `promoteApprovedRequirements` writes.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseAcceptanceCriteria } from "@metis/shared";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

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

const { offerUnmatchedItemsForReview } =
  await import("../src/lib/analysis/offer-synthesis-items.js");
const { getStructuredRequirements } = await import("../src/lib/analysis/analysis-service.js");
const { approveAllPendingApprovalRequests } =
  await import("../src/lib/analysis/approval-checkpoint.js");
const { promoteApprovedRequirements } = await import("../src/lib/analysis/promote-requirements.js");

const PROJECT = "proj-1569";
const USER = "u-1569";
const REVIEWED = "ana-1569-reviewed";
const UNREVIEWED = "ana-1569-unreviewed";

const R1 = {
  id: "REQ-1",
  title: "Mark-all-as-read returns 204",
  description: "PUT mark-all-as-read answers 204 No Content.",
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
};
const item = (title: string, structuredIds: string[], criteria: string[], priority = "medium") => ({
  type: "feature",
  title,
  body: `${title}.`,
  priority,
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: criteria,
  structuredIds,
});
const X = item("Confirm mark-all-as-read returns 204", ["REQ-1"], ["Returns 204"]);
const OPENAPI = item(
  "Publish a machine-readable OpenAPI description for the v1 API",
  [],
  ["An OpenAPI 3 document is served", "It lists every /v1 route"],
  "high",
);
const PROXY = item(
  "Harden the media proxy against being used as an open proxy",
  [],
  ["The proxy refuses an unsigned URL"],
);
const SYNTHESIS = [X, OPENAPI, PROXY];

async function seed(db: PrismaClient, analysisId: string, reviewed: boolean): Promise<void> {
  await db.analysis.create({
    data: {
      id: analysisId,
      projectId: PROJECT,
      startedById: USER,
      status: "completed",
      metadata: JSON.stringify({
        structuredRequirements: { requirements: [R1], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
        structuredRunId: `run-${analysisId}`,
      }),
    },
  });
  await db.agentResult.create({
    data: {
      analysisId,
      agentKey: "synthesis",
      status: "completed",
      output: JSON.stringify({ summary: "Three requirements.", requirements: SYNTHESIS }),
    },
  });
  if (reviewed) {
    await db.approvalRequest.create({
      data: { analysisId, type: "requirement", itemId: "REQ-1", status: "pending" },
    });
  }
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1569 — unmatched synthesis items are offered and promoted on a real database",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1569-offer-synthesis-items");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "u", email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      await seed(db, REVIEWED, true);
      await seed(db, UNREVIEWED, false);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const approvalsOf = (analysisId: string) =>
      db.approvalRequest.findMany({
        where: { analysisId },
        orderBy: { createdAt: "asc" },
        select: { itemId: true, status: true, type: true },
      });

    it("adds each item that restates nothing reviewed to the list, with a pending approval", async () => {
      const offered = await offerUnmatchedItemsForReview(REVIEWED, SYNTHESIS as never);
      expect(offered.map((r) => r.title)).toEqual([OPENAPI.title, PROXY.title]);

      const list = (await getStructuredRequirements(REVIEWED))!.requirements;
      expect(list.map((r) => r.title)).toEqual([R1.title, OPENAPI.title, PROXY.title]);
      expect(list[1]!.synthesisItemKey).toEqual(expect.any(String));
      expect(await approvalsOf(REVIEWED)).toEqual([
        { itemId: "REQ-1", status: "pending", type: "requirement" },
        { itemId: list[1]!.id, status: "pending", type: "requirement" },
        { itemId: list[2]!.id, status: "pending", type: "requirement" },
      ]);
    });

    it("offers nothing twice when synthesis runs again", async () => {
      expect(await offerUnmatchedItemsForReview(REVIEWED, SYNTHESIS as never)).toEqual([]);
      expect((await getStructuredRequirements(REVIEWED))!.requirements).toHaveLength(3);
      expect(await approvalsOf(REVIEWED)).toHaveLength(3);
    });

    it("approving promotes each offered requirement with its item's criteria and priority", async () => {
      await approveAllPendingApprovalRequests(REVIEWED, { reviewerId: USER });
      expect(await promoteApprovedRequirements(REVIEWED, { asApproved: true })).toEqual({
        status: "promoted",
        requirementCount: 3,
      });
      const rows = await db.requirement.findMany({
        where: { analysisId: REVIEWED },
        orderBy: { createdAt: "asc" },
        select: { title: true, priority: true, acceptanceCriteria: true },
      });
      expect(
        rows.map((r) => [r.title, r.priority, parseAcceptanceCriteria(r.acceptanceCriteria)]),
      ).toEqual([
        [R1.title, "high", ["Returns 204"]],
        [OPENAPI.title, "high", OPENAPI.acceptanceCriteria],
        [PROXY.title, "medium", PROXY.acceptanceCriteria],
      ]);
    });

    it("leaves an analysis with no reviewed requirements as it was", async () => {
      expect(await offerUnmatchedItemsForReview(UNREVIEWED, SYNTHESIS as never)).toEqual([]);
      expect((await getStructuredRequirements(UNREVIEWED))!.requirements).toHaveLength(1);
      expect(await approvalsOf(UNREVIEWED)).toEqual([]);
    });
  },
);
