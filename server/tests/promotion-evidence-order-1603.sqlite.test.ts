/**
 * #1603 — promotion resolves synthesis's `evidenceFindingIndexes` against the
 * order synthesis numbered the findings in, not the database's.
 *
 * With the #1110 panel flag on, synthesis ranks the findings by panel
 * confidence before numbering them, so its `[0]` can be the database's second
 * finding. Promotion from the Approvals tab read them in database order, so
 * every promoted requirement could link the WRONG finding: wrong `finding:`
 * evidence labels, and code links seeded from the wrong finding's citations.
 *
 * Here the two orders are each other's reverse: the database holds an
 * unjudged finding (no panel) first and a `high`-confidence one second, so
 * synthesis numbers the `high` one `[0]`. Each requirement must link the
 * finding synthesis cited, on the first promotion and on the append a
 * reopened-then-approved requirement takes. Real SQLite, built by the
 * migration chain; read back from the `requirements` rows and their code links.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import type { FindingSupportPanel } from "@metis/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { promoteApprovedRequirements } = await import("../src/lib/analysis/promote-requirements.js");
const { readFlattenedFindings } = await import("../src/lib/analysis/analysis-service.js");
const { inSynthesisOrder } = await import("../src/lib/analysis/synthesis-finding-order.js");

const PROJECT = "proj-1603";
const USER = "u-1603";
const RUN_ID = "extraction-run-1603";

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
const R1 = structured("REQ-1", "Export the monthly invoice report");
const R2 = structured("REQ-2", "Archive feeds older than a year");
/** Synthesis's items: REQ-1 cites its `[0]`, REQ-2 its `[1]`. */
const item = (title: string, structuredIds: string[], evidenceFindingIndexes: number[]) => ({
  type: "feature",
  title,
  body: `${title}.`,
  priority: "medium",
  labels: [],
  evidenceFindingIndexes,
  acceptanceCriteria: [`${title} works.`],
  structuredIds,
});
const SYNTHESIS = [item(R1.title, ["REQ-1"], [0]), item(R2.title, ["REQ-2"], [1])];

/** A `high` panel: three lenses, all supported. */
const HIGH: FindingSupportPanel = {
  confidence: "high",
  votes: (["support", "scope", "currency"] as const).map((lens, i) => ({
    lens,
    judgement: "supported" as const,
    discardReason: null,
    citation: `src/invoices.ts:${10 + i}`,
    reasoning: "the excerpt says so",
    counted: true,
  })),
  countedVotes: 3,
  supportedVotes: 3,
  unsupportedVotes: 0,
  uncertainVotes: 0,
  noSignalVotes: 0,
  uncitedVotes: 0,
  usage: { promptTokens: 5, completionTokens: 1, llmCalls: 3 },
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1603 — promotion links the finding synthesis cited",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    /**
     * A run at its checkpoint, its two findings in database order: the
     * unjudged archive finding (citing `src/archive.ts`) first, the `high`
     * invoice finding (citing `src/invoices.ts`) second.
     */
    async function seedAnalysis(
      statuses: { r1: string; r2: string },
      /** The archive finding cites a document, not code (for the evidence mark). */
      archiveCitesDocument = false,
    ) {
      seq += 1;
      const id = `ana-1603-${seq}`;
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
      const code = await db.agentResult.create({
        data: { analysisId: id, agentKey: "code", status: "completed", startedAt: new Date() },
      });
      const finding = async (
        title: string,
        filePath: string,
        supportPanel?: FindingSupportPanel,
        citesDocument = false,
      ) =>
        (
          await db.finding.create({
            data: {
              agentResultId: code.id,
              category: "architecture",
              severity: "info",
              title,
              body: `${title}.`,
              derivation: "inferred",
              confidence: 0.9,
              evidence: JSON.stringify({
                tags: [],
                citations: citesDocument
                  ? [{ documentId: "doc-1603", chunkIndex: 0 }]
                  : [{ filePath, startLine: 1, endLine: 20 }],
                ...(supportPanel ? { supportPanel } : {}),
              }),
            },
          })
        ).id;
      const archive = await finding(
        "Feeds are kept forever",
        "src/archive.ts",
        undefined,
        archiveCitesDocument,
      );
      const invoices = await finding("Invoices export as CSV", "src/invoices.ts", HIGH);
      await db.agentResult.create({
        data: {
          analysisId: id,
          agentKey: "synthesis",
          status: "completed",
          output: JSON.stringify({ summary: "Two requirements.", requirements: SYNTHESIS }),
        },
      });
      for (const [itemId, status] of [
        ["REQ-1", statuses.r1],
        ["REQ-2", statuses.r2],
      ] as const) {
        await db.approvalRequest.create({
          data: {
            analysisId: id,
            type: "requirement",
            itemId,
            status,
            ...(status === "pending" ? {} : { reviewedAt: new Date() }),
          },
        });
      }
      return { id, archive, invoices };
    }

    /** Each promoted requirement's evidence findings and seeded code-link files. */
    async function links(analysisId: string) {
      const rows = await db.requirement.findMany({
        where: { analysisId },
        orderBy: { title: "asc" },
        select: { id: true, title: true, labels: true },
      });
      const out: Record<string, { findings: string[]; files: string[] }> = {};
      for (const r of rows) {
        const labels = JSON.parse(r.labels) as string[];
        const mappings = await db.requirementCodeMapping.findMany({
          where: { requirementId: r.id },
          select: { filePath: true },
        });
        out[r.title] = {
          findings: labels.filter((l) => l.startsWith("finding:")).map((l) => l.slice(8)),
          files: mappings.map((m) => m.filePath).sort(),
        };
      }
      return out;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1603-promotion-evidence-order");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: "u", email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
      // The code graph the seeded links resolve against: one symbol per file.
      const graph = await db.codeGraph.create({ data: { projectId: PROJECT } });
      for (const filePath of ["src/archive.ts", "src/invoices.ts"]) {
        await db.codeSymbol.create({
          data: {
            codeGraphId: graph.id,
            projectId: PROJECT,
            kind: "function",
            name: filePath,
            qualifiedName: `${filePath}::main`,
            filePath,
            startLine: 1,
            endLine: 40,
            language: "typescript",
            contentHash: `h-${filePath}`,
          },
        });
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the two orderings differ: synthesis's [0] is the database's second finding", async () => {
      const { id, archive, invoices } = await seedAnalysis({ r1: "pending", r2: "pending" });
      const dbOrder = (await readFlattenedFindings(id)).map((f) => f.findingId);
      expect(dbOrder).toEqual([archive, invoices]);
      expect(inSynthesisOrder(await readFlattenedFindings(id)).map((f) => f.findingId)).toEqual([
        invoices,
        archive,
      ]);
    });

    it("links each promoted requirement to the finding synthesis cited, and its code", async () => {
      const { id, archive, invoices } = await seedAnalysis({ r1: "approved", r2: "approved" });
      expect(await promoteApprovedRequirements(id, { asApproved: true })).toMatchObject({
        status: "promoted",
        requirementCount: 2,
      });
      expect(await links(id)).toEqual({
        [R1.title]: { findings: [invoices], files: ["src/invoices.ts"] },
        [R2.title]: { findings: [archive], files: ["src/archive.ts"] },
      });
    });

    it("does the same on the append a reopened-then-approved requirement takes", async () => {
      const { id, archive, invoices } = await seedAnalysis({ r1: "rejected", r2: "approved" });
      expect(await promoteApprovedRequirements(id, { asApproved: true })).toMatchObject({
        status: "promoted",
        requirementCount: 1,
      });
      // REQ-1 is reopened and approved after the set was promoted.
      await db.approvalRequest.updateMany({
        where: { analysisId: id, itemId: "REQ-1" },
        data: { status: "approved", reviewedAt: new Date(Date.now() + 1000) },
      });
      expect(await promoteApprovedRequirements(id, { asApproved: true })).toMatchObject({
        status: "promoted",
        requirementCount: 1,
      });
      // #1657 — and its code links are seeded from that finding's citations.
      expect(await links(id)).toEqual({
        [R1.title]: { findings: [invoices], files: ["src/invoices.ts"] },
        [R2.title]: { findings: [archive], files: ["src/archive.ts"] },
      });
    });

    it("reads findings in the order they were written, not the storage order (#1657)", async () => {
      const { id, archive, invoices } = await seedAnalysis({ r1: "pending", r2: "pending" });
      // Storage order stays archive, invoices (SQLite's rowid order); the
      // write order, `createdAt`, now says invoices came first. Only an
      // `orderBy` reads the second: Postgres guarantees no order without one.
      await db.finding.update({
        where: { id: invoices },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });
      expect((await readFlattenedFindings(id)).map((f) => f.findingId)).toEqual([
        invoices,
        archive,
      ]);
    });

    it("marks 'no code evidence' on the Approvals tab by the finding synthesis cited", async () => {
      // REQ-1 cites synthesis's [0], the invoice finding, which cites code;
      // REQ-2 cites [1], the archive finding, which cites only a document.
      const { id } = await seedAnalysis({ r1: "pending", r2: "pending" }, true);
      const app = express();
      app.use(express.json());
      app.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      app.use(notFoundHandler);
      app.use(errorHandler);
      const token = issueTokens({
        userId: USER,
        username: USER,
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
      const res = await request(app)
        .get(`/api/projects/${PROJECT}/analyses/${id}/approvals`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const items = res.body.data.items as Array<{ itemId: string; noCodeEvidence?: boolean }>;
      expect(Object.fromEntries(items.map((a) => [a.itemId, a.noCodeEvidence === true]))).toEqual({
        "REQ-1": false,
        "REQ-2": true,
      });
    });
  },
);
