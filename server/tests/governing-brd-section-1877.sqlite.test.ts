/**
 * #1877 (epic #1866) — the governing-rules section of a requirements BRD over
 * the REAL routers and a REAL SQLite database built by the migration chain;
 * only the audit sink is a double and no model is called.
 *
 * Workspace A holds project PA: an analysis run with two requirements, a
 * governing document with one revision and three rules, and three stored
 * findings, one per status. A's member rejects the gap through the decision
 * route. Workspace B holds project PB with its own run and a finding.
 *
 *   - The BRD generated through `POST …/docs/generate` lists all three
 *     findings, the rejected one marked, and its statuses and decisions are
 *     exactly those `GET …/analyses/:id/governing-findings` returns.
 *   - It carries no compliance claim, and no finding of PB.
 *   - With the flag off, the same document has no governing section.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  findForbiddenComplianceClaims,
  getPermissionsForRole,
  type AuthPayload,
} from "@metis/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

const { generatedDocsRouter } = await import("../src/routes/generated-docs.js");
const { initAnalysisRouter } = await import("../src/routes/analysis.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { GOVERNING_SECTION_HEADING } = await import("../src/lib/docs-gen/governing-section.js");

const WS_A = "ws-1877-a";
const WS_B = "ws-1877-b";
const PA = "proj-1877-a";
const PB = "proj-1877-b";
const ALICE = "alice-1877";
const MALLORY = "mallory-1877";
const RUN_A = "run-1877-a";
const RUN_B = "run-1877-b";

const POLICY = [
  "# Information Handling Policy",
  "§4.3 The company never stores a full payment card number in any system.",
  "§5.1 Every bulk export of customer records is written to the audit log.",
  "§6.2 Statements are kept for seven years and then destroyed.",
].join("\n\n");
const CLAUSES = {
  card: ["EN-03", "§4.3", "never stores a full payment card number in any system"],
  audit: ["AL-02", "§5.1", "Every bulk export of customer records is written to the audit log"],
  keep: ["RT-01", "§6.2", "Statements are kept for seven years"],
} as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1877 — the governing-rules section of a requirements BRD (real routers, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, ws: string) =>
      issueTokens({
        userId,
        username: userId,
        role: "coordinator",
        permissions: getPermissionsForRole("coordinator"),
        workspaces: [ws],
      } satisfies AuthPayload).accessToken;
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/docs", generatedDocsRouter());
      a.use("/api/projects/:projectId/analyses", initAnalysisRouter().projectScoped);
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const findingsPath = `/api/projects/${PA}/analyses/${RUN_A}/governing-findings`;

    async function generateBrd(): Promise<string> {
      const res = await request(app())
        .post(`/api/projects/${PA}/docs/generate`)
        .set("Authorization", `Bearer ${token(ALICE, WS_A)}`)
        .send({ title: "Checkout BRD", scope: "requirements", scopeFilter: { analysisId: RUN_A } });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      const docId = res.body.data.id as string;
      // Generation runs in the background; a requirements document calls no model.
      let doc = await db.generatedDocument.findUniqueOrThrow({ where: { id: docId } });
      const settled = ["ready", "failed", "cancelled"];
      for (let i = 0; i < 100 && !settled.includes(doc.status); i++) {
        await new Promise((r) => setTimeout(r, 100));
        doc = await db.generatedDocument.findUniqueOrThrow({ where: { id: docId } });
      }
      expect(doc.status, doc.errorMessage ?? "").toBe("ready");
      return doc.content ?? "";
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1877-governing-brd");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.role.create({ data: { id: "role-coordinator", key: "coordinator", name: "c" } });
      for (const [user, ws, project, run] of [
        [ALICE, WS_A, PA, RUN_A],
        [MALLORY, WS_B, PB, RUN_B],
      ] as const) {
        await db.user.create({
          data: { id: user, username: user, displayName: user, email: `${user}@example.test` },
        });
        await db.userRole.create({ data: { userId: user, roleId: "role-coordinator" } });
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({
          data: { workspaceId: ws, userId: user, role: "member" },
        });
        await db.project.create({
          data: {
            id: project,
            name: project,
            slug: project,
            createdById: user,
            workspaceId: ws,
            status: "active",
          },
        });
        await db.analysis.create({
          data: {
            id: run,
            projectId: project,
            startedById: user,
            status: "completed",
            metadata: JSON.stringify({
              governingApplicability: {
                decidedAt: "2026-11-08T00:00:00.000Z",
                requirements: [
                  {
                    requirementId: "REQ-001",
                    text: "Saved cards keep only the last four digits.",
                    decisions: [],
                  },
                  {
                    requirementId: "REQ-002",
                    text: "Customers get a monthly statement.",
                    decisions: [],
                  },
                ],
              },
            }),
          },
        });
      }
      let created = Date.parse("2026-10-01T00:00:00Z");
      for (const [id, project, run, title] of [
        ["req-1877-card", PA, RUN_A, "Save a card"],
        ["req-1877-statement", PA, RUN_A, "Monthly statement"],
        ["req-1877-b", PB, RUN_B, "Mallory's requirement"],
      ] as const) {
        await db.requirement.create({
          data: {
            id,
            projectId: project,
            analysisId: run,
            title,
            body: `Body of ${title}.`,
            priority: "high",
            acceptanceCriteria: JSON.stringify([`Criterion of ${title}.`]),
            createdAt: new Date((created += 1_000)),
          },
        });
      }

      const doc = await db.governingDocument.create({
        data: { workspaceId: WS_A, title: "Information Handling Policy", createdById: ALICE },
      });
      const rev = await db.governingDocumentRevision.create({
        data: {
          documentId: doc.id,
          revisionLabel: "v1",
          effectiveDate: new Date("2026-01-01"),
          storagePath: `${doc.id}/v1`,
          contentHash: `${doc.id}-v1`,
          mimeType: "text/markdown",
          sizeBytes: POLICY.length,
          extractedText: POLICY,
          indexState: "indexed",
          extractionState: "done",
          uploadedById: ALICE,
        },
      });
      const finding = async (
        analysisId: string,
        requirementId: string,
        key: keyof typeof CLAUSES,
        extra: Record<string, unknown>,
      ) => {
        const [controlId, clauseRef, excerpt] = CLAUSES[key];
        const start = POLICY.indexOf(excerpt);
        const rule = await db.governingRule.create({
          data: {
            revisionId: rev.id,
            controlId,
            summary: `${controlId} summary`,
            clauseRef,
            clauseStart: start,
            clauseEnd: start + excerpt.length,
            clauseExcerpt: excerpt,
          },
        });
        await db.governingFinding.create({
          data: {
            analysisId,
            requirementId,
            ruleId: rule.id,
            revisionId: rev.id,
            revisionLabel: "v1",
            documentTitle: doc.title,
            controlId,
            clauseRef,
            status: "gap",
            reasoning: "Stored reasoning.",
            clauseStart: start,
            clauseEnd: start + excerpt.length,
            clauseExcerpt: excerpt,
            ...extra,
          },
        });
      };
      await finding(RUN_A, "REQ-001", "card", {
        status: "compliant",
        reasoning: "Only the last four digits are kept, so it is SOC 2 compliant.",
      });
      await finding(RUN_A, "REQ-001", "audit", {
        status: "gap",
        reasoning: "Bulk exports are not mentioned.",
      });
      await finding(RUN_A, "REQ-002", "keep", {
        status: "needs-ba-input",
        reasoning: "Depends on how long statements are kept.",
        businessQuestion: "How long are monthly statements kept?",
      });
      // Another project's finding, which A's document must never show.
      await finding(RUN_B, "REQ-001", "card", { reasoning: "Mallory's finding." });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      delete process.env.GOVERNING_DOCS_ENABLED;
    });
    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the BRD lists all three findings with the analysis route's statuses and decisions, the rejected one marked", async () => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
      const auth = `Bearer ${token(ALICE, WS_A)}`;
      const gap = await db.governingFinding.findFirstOrThrow({
        where: { analysisId: RUN_A, controlId: "AL-02" },
      });
      const decided = await request(app())
        .post(`${findingsPath}/${gap.id}/decision`)
        .set("Authorization", auth)
        .send({ decision: "rejected", note: "Exports are out of scope." });
      expect(decided.status).toBe(200);

      const route = await request(app()).get(findingsPath).set("Authorization", auth);
      expect(route.status).toBe(200);
      const fromRoute = (
        route.body.data.findings as Array<{
          requirementId: string;
          controlId: string;
          status: string;
          decision: string | null;
        }>
      ).map((f) => [f.requirementId, f.controlId, f.status, f.decision ?? "none"]);
      expect(fromRoute).toHaveLength(3);

      const markdown = await generateBrd();
      const section = markdown.slice(markdown.indexOf(GOVERNING_SECTION_HEADING));
      expect(markdown).toContain(GOVERNING_SECTION_HEADING);
      const label: Record<string, string> = {
        Compliant: "compliant",
        Gap: "gap",
        "Needs BA input": "needs-ba-input",
      };
      const decision: Record<string, string> = {
        Accepted: "accepted",
        Rejected: "rejected",
        "Not decided": "none",
      };
      const fromBrd = section
        .split("\n")
        .filter((l) => /^\| REQ-/.test(l))
        .map((l) => l.slice(2, -2).split(" | "))
        .map(([requirementId, controlId, status, d]) => [
          requirementId,
          controlId,
          label[status!],
          decision[d!],
        ]);
      expect(fromBrd).toEqual(fromRoute);
      expect(fromBrd).toContainEqual(["REQ-001", "AL-02", "gap", "rejected"]);

      for (const [controlId, , excerpt] of Object.values(CLAUSES)) {
        expect(section).toContain(`> “${excerpt}”`);
        expect(section).toContain(`**${controlId} — `);
      }
      expect(section).toContain("Rule of Information Handling Policy, revision v1, clause §5.1.");
      expect(section).toContain(`Decision: **Rejected** by ${ALICE} on `);
      expect(section).toContain("- **Analyst's note:** Exports are out of scope.");
      expect(findForbiddenComplianceClaims(markdown)).toEqual([]);
      expect(markdown).not.toContain("Mallory's finding.");
    });

    it("with the flag off the BRD has no governing section", async () => {
      const markdown = await generateBrd();
      expect(markdown).toContain("### R1. Save a card");
      expect(markdown).not.toContain(GOVERNING_SECTION_HEADING);
      expect(markdown).not.toContain("EN-03");
    });
  },
);
