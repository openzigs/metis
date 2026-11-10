/**
 * Issue #1580 (`b-7-8`) — a requirement edited in the approval checkpoint,
 * before it is approved, is the requirement approving promotes.
 *
 * Real SQLite built by the migration chain. Every assertion reads back through
 * a production reader: the reviewed list through `getStructuredRequirements`
 * (what the checkpoint and the clarify dialog read), and the promoted rows
 * through `promoteApprovedRequirements` and the `requirements` table.
 *
 * The synthesis items here name no structured ids (output from before #1033,
 * or a degraded run), so promotion joins them to the reviewed list by title.
 * A retitled requirement must still be joined to the item written against its
 * extracted title, or it is promoted without its acceptance criteria.
 */
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
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const { editCheckpointRequirement } =
  await import("../src/lib/analysis/checkpoint-requirement-edit.js");
const { getStructuredRequirements } = await import("../src/lib/analysis/analysis-service.js");
const { promoteApprovedRequirements } = await import("../src/lib/analysis/promote-requirements.js");

const PROJECT = "proj-1580";
const USER = "u-1580";
const RUN_ID = "extraction-run-1580";

const structured = (id: string, title: string) => ({
  id,
  title,
  description: `${title}.`,
  type: "functional",
  stakeholders: [],
  priority: "must-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});
const R1 = structured("REQ-1", "Mark all entries older than a threshold as read");
const R2 = structured("REQ-2", "Archive feeds older than a year");
/** No `structuredIds`: the title join places these. */
const item = (title: string) => ({
  type: "feature",
  title,
  body: `${title}.`,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes: [],
  acceptanceCriteria: [`${title} works.`],
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1580 — edit a requirement in the approval checkpoint (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    /** A run at its checkpoint: two reviewed requirements, both pending. */
    async function seedAnalysis() {
      seq += 1;
      const id = `ana-1580-${seq}`;
      await db.analysis.create({
        data: {
          id,
          projectId: PROJECT,
          startedById: USER,
          status: "completed",
          metadata: JSON.stringify({
            structuredRequirements: {
              requirements: [R1, R2],
              totalAmbiguities: 0,
              totalEvidenceNeeds: 0,
            },
            structuredRunId: RUN_ID,
          }),
        },
      });
      await db.agentResult.create({
        data: {
          analysisId: id,
          agentKey: "synthesis",
          status: "completed",
          output: JSON.stringify({
            summary: "Two requirements.",
            requirements: [item(R1.title), item(R2.title)],
          }),
        },
      });
      const approvals: Record<string, string> = {};
      for (const itemId of ["REQ-1", "REQ-2"]) {
        const row = await db.approvalRequest.create({
          data: { analysisId: id, type: "requirement", itemId, status: "pending" },
        });
        approvals[itemId] = row.id;
      }
      return { id, approvals };
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1580-checkpoint-edit");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("stores the reviewed title and description, keeping the extracted title once", async () => {
      const { id, approvals } = await seedAnalysis();

      const returned = await editCheckpointRequirement(id, approvals["REQ-1"]!, {
        title: "Mark entries published before a date as read",
        description: "Compare against published_at, exclusive.",
      });
      await editCheckpointRequirement(id, approvals["REQ-1"]!, {
        title: "Mark entries published before X as read",
      });

      const list = await getStructuredRequirements(id);
      const [r1, r2] = list!.requirements;
      expect(r1).toMatchObject({
        id: "REQ-1",
        title: "Mark entries published before X as read",
        description: "Compare against published_at, exclusive.",
        // The first edit's original, not the second edit's.
        extractedTitle: R1.title,
      });
      expect(returned.title).toBe("Mark entries published before a date as read");
      expect(r2).toEqual(R2);
      // The list's run is untouched: the clarify dialog still matches its ids.
      expect(list!.runId).toBe(RUN_ID);
    });

    it("leaves the extracted title unset when only the description changes", async () => {
      const { id, approvals } = await seedAnalysis();

      await editCheckpointRequirement(id, approvals["REQ-2"]!, { description: "" });

      const r2 = (await getStructuredRequirements(id))!.requirements[1]!;
      expect(r2.title).toBe(R2.title);
      expect(r2.description).toBe("");
      expect(r2).not.toHaveProperty("extractedTitle");
    });

    it("promotes the edited text, with the criteria synthesis wrote for the extracted title", async () => {
      const { id, approvals } = await seedAnalysis();
      // Shares one significant word with the extracted title: joined on the
      // reviewed title, it would match no item at all.
      await editCheckpointRequirement(id, approvals["REQ-1"]!, {
        title: "Bulk read-state cleanup by publication date",
        description: "Compare against published_at, exclusive.",
      });
      await db.approvalRequest.updateMany({
        where: { analysisId: id },
        data: { status: "approved", reviewedAt: new Date() },
      });

      const outcome = await promoteApprovedRequirements(id, { asApproved: true });

      expect(outcome).toEqual({ status: "promoted", requirementCount: 2 });
      const rows = await db.requirement.findMany({
        where: { analysisId: id },
        orderBy: { promotedStructuredId: "asc" },
        select: { title: true, body: true, acceptanceCriteria: true },
      });
      expect(rows[0]).toEqual({
        title: "Bulk read-state cleanup by publication date",
        body: "Compare against published_at, exclusive.",
        acceptanceCriteria: JSON.stringify([`${R1.title} works.`]),
      });
      expect(rows[1]!.acceptanceCriteria).toBe(JSON.stringify([`${R2.title} works.`]));
    });

    it("refuses a resolved approval with 409 and leaves the list as it was", async () => {
      const { id, approvals } = await seedAnalysis();
      await db.approvalRequest.update({
        where: { id: approvals["REQ-1"]! },
        data: { status: "approved", reviewedAt: new Date() },
      });

      await expect(
        editCheckpointRequirement(id, approvals["REQ-1"]!, { title: "Too late" }),
      ).rejects.toMatchObject({ statusCode: 409, code: "APPROVAL_ALREADY_REVIEWED" });
      expect((await getStructuredRequirements(id))!.requirements[0]).toEqual(R1);
    });

    it("answers 404 for an approval of another analysis, and edits neither", async () => {
      const a = await seedAnalysis();
      const b = await seedAnalysis();

      await expect(
        editCheckpointRequirement(a.id, b.approvals["REQ-1"]!, { title: "Cross-run" }),
      ).rejects.toMatchObject({ statusCode: 404, code: "APPROVAL_NOT_FOUND" });
      expect((await getStructuredRequirements(a.id))!.requirements[0]).toEqual(R1);
      expect((await getStructuredRequirements(b.id))!.requirements[0]).toEqual(R1);
    });

    it("refuses an approval that does not review a requirement", async () => {
      const { id } = await seedAnalysis();
      const evidence = await db.approvalRequest.create({
        data: { analysisId: id, type: "evidence", itemId: "REQ-1", status: "pending" },
      });

      await expect(
        editCheckpointRequirement(id, evidence.id, { title: "Not mine" }),
      ).rejects.toMatchObject({ statusCode: 400, code: "APPROVAL_NOT_A_REQUIREMENT" });
      expect((await getStructuredRequirements(id))!.requirements[0]).toEqual(R1);
    });

    it("answers 404 when the reviewed list no longer holds the requirement", async () => {
      const { id } = await seedAnalysis();
      const stale = await db.approvalRequest.create({
        data: { analysisId: id, type: "requirement", itemId: "REQ-9", status: "pending" },
      });

      await expect(
        editCheckpointRequirement(id, stale.id, { title: "Gone" }),
      ).rejects.toMatchObject({ statusCode: 404, code: "CHECKPOINT_REQUIREMENT_NOT_FOUND" });
    });
  },
);
