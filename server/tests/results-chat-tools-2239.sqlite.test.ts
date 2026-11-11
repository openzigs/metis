/**
 * #2239 — chat's read-only tools for METIS's own results.
 *
 * Real SQLite database from the migration chain, and the real access helpers
 * (`assertLiveProjectAccess`, `loadAccessibleImpactDetail`,
 * `viewPortfolioAssessment`): nothing on the authorization path is mocked, so a
 * query that drops the project scope is caught by another project's row
 * reaching the model.
 *
 * Fixture: workspace WS holds projects P (the chat's) and P2 (a sibling) and
 * product PROD (bound to P). Workspace WS_OTHER holds P_OTHER and PROD_OTHER.
 * MEMBER belongs to WS only, OUTSIDER to WS_OTHER only.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));

const tools = await import("../src/lib/analysis/results-chat-tools.js");
const { ToolRegistry } = await import("../src/lib/ai/tool-registry.js");
type ToolContext = import("../src/lib/ai/types.js").ToolContext;
type ToolResult = import("../src/lib/ai/types.js").ToolResult;

const WS = "ws-2239";
const WS_OTHER = "ws-2239-other";
const P = "p-2239";
const P2 = "p-2239-sibling";
const P_OTHER = "p-2239-other";
const P_EMPTY = "p-2239-empty";
const PROD = "prod-2239";
const PROD_OTHER = "prod-2239-other";
const PROD_LOOSE = "prod-2239-loose";
const A1 = "ana-2239";
const A_BG = "ana-2239-bg";
const A_FAILED = "ana-2239-failed";
const A_OTHER = "ana-2239-other";

const MEMBER = "u-member";
const OUTSIDER = "u-out";
const ADMIN = "u-admin";

const ctx = (userId: string, projectId: string | null = P): ToolContext => ({
  sessionId: "s-2239",
  userId,
  ...(projectId ? { projectId } : {}),
});

async function run(
  tool: { exec: (args: never, ctx: ToolContext) => Promise<ToolResult> },
  args: Record<string, unknown>,
  c: ToolContext = ctx(MEMBER),
): Promise<ToolResult> {
  return tool.exec(args as never, c);
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2239 — chat reads METIS's own results",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2239-results-chat-tools");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      for (const id of [ADMIN, MEMBER, OUTSIDER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      const adminRole = await db.role.create({ data: { key: "admin", name: "Admin" } });
      await db.userRole.create({ data: { userId: ADMIN, roleId: adminRole.id } });
      await db.workspace.create({ data: { id: WS, name: WS, slug: WS } });
      await db.workspace.create({ data: { id: WS_OTHER, name: WS_OTHER, slug: WS_OTHER } });
      await db.workspaceMember.create({
        data: { workspaceId: WS, userId: MEMBER, role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: WS_OTHER, userId: OUTSIDER, role: "member" },
      });

      for (const [id, name, workspaceId] of [
        [PROD, "Billing", WS],
        [PROD_OTHER, "Other billing", WS_OTHER],
        [PROD_LOOSE, "Unrelated", null],
      ] as const) {
        await db.product.create({
          data: { id, name, slug: id, createdById: MEMBER, workspaceId },
        });
      }
      for (const [id, name, workspaceId, productId] of [
        [P, "Payments", WS, PROD],
        [P2, "Ledger", WS, null],
        [P_EMPTY, "Nothing yet", WS, null],
        [P_OTHER, "Secret project", WS_OTHER, PROD_OTHER],
      ] as const) {
        await db.project.create({
          data: { id, name, slug: id, createdById: MEMBER, workspaceId, productId },
        });
      }

      // ── analyses ──
      await db.analysis.create({
        data: {
          id: A1,
          projectId: P,
          startedById: MEMBER,
          status: "completed",
          startedAt: new Date("2026-11-01T00:00:00Z"),
          completedAt: new Date("2026-11-01T01:00:00Z"),
          agentResults: {
            create: [
              {
                agentKey: "security-scanner",
                status: "completed",
                findings: {
                  create: [
                    {
                      category: "security",
                      severity: "low",
                      title: "Verbose errors",
                      body: "Stack traces reach the client.",
                    },
                    {
                      category: "security",
                      severity: "high",
                      title: "Refund endpoint lacks auth",
                      body: "POST /refunds accepts any caller.",
                      verificationStatus: "confirmed",
                    },
                  ],
                },
              },
              { agentKey: "codebase-assessor", status: "failed", errorMessage: "timed out" },
            ],
          },
          crossDocFindings: {
            create: {
              kind: "contradiction",
              severity: "medium",
              title: "Refund window differs",
              detail: "The FRD says 14 days; the policy says 30.",
            },
          },
          requirements: {
            create: [
              { projectId: P, title: "Refunds within 14 days", body: "b" },
              { projectId: P, title: "Deleted one", body: "b", deletedAt: new Date() },
            ],
          },
          clarificationDialog: {
            create: {
              state: JSON.stringify({
                analysisId: A1,
                currentRound: 1,
                maxRounds: 3,
                rounds: [
                  {
                    round: 1,
                    questions: [
                      {
                        id: "q1",
                        requirementId: "REQ-001",
                        ambiguityField: "window",
                        question: "Is the refund window calendar or business days?",
                        context: "",
                      },
                      {
                        id: "q2",
                        requirementId: "REQ-002",
                        ambiguityField: "who",
                        question: "Who may approve a refund?",
                        context: "",
                      },
                      {
                        id: "q3",
                        requirementId: "governing:REQ-001",
                        ambiguityField: "governing",
                        question: "Are card numbers stored?",
                        context: "",
                        governing: { kind: "governing", ruleIds: ["r1"], requirementId: "REQ-001" },
                      },
                    ],
                    answers: [
                      { questionId: "q1", answer: "Calendar days." },
                      { questionId: "q2", answer: "   " },
                      { questionId: "q3", answer: "No, tokens only." },
                    ],
                  },
                ],
                resolvedAmbiguities: [],
                escalatedToSonnet: false,
                completed: false,
              }),
            },
          },
          governingFindings: {
            create: [
              {
                ...governing("REQ-001", "r1", "gap", "PCI-3.4"),
                clauseExcerpt: "Card numbers must be rendered unreadable.",
                businessQuestion: "Are card numbers stored at rest?",
                decision: "accepted",
                decisionNote: "Confirmed with security.",
              },
              { ...governing("REQ-001", "r3", "needs-ba-input", "PCI-9.9"), citationDropped: true },
              governing("REQ-002", "r2", "compliant", "SOX-1"),
            ],
          },
          metadata: JSON.stringify({
            governingApplicability: {
              decidedAt: "2026-11-01T00:30:00.000Z",
              requirements: [
                { requirementId: "REQ-001", text: "Refunds within 14 days", decisions: [] },
              ],
            },
          }),
        },
      });
      await db.analysis.create({
        data: {
          id: A_FAILED,
          projectId: P,
          startedById: MEMBER,
          status: "failed",
          startedAt: new Date("2026-10-01T00:00:00Z"),
          errorMessage: "provider down",
        },
      });
      await db.analysis.create({
        data: {
          id: A_BG,
          projectId: P,
          startedById: MEMBER,
          status: "completed",
          metadata: JSON.stringify({ source: "code-graph-ingest" }),
        },
      });
      await db.analysis.create({
        data: {
          id: A_OTHER,
          projectId: P_OTHER,
          startedById: OUTSIDER,
          status: "completed",
          agentResults: {
            create: {
              agentKey: "security-scanner",
              status: "completed",
              findings: {
                create: {
                  category: "security",
                  severity: "critical",
                  title: "OTHER SECRET",
                  body: "x",
                },
              },
            },
          },
          clarificationDialog: {
            create: {
              state: JSON.stringify({
                analysisId: A_OTHER,
                rounds: [
                  {
                    round: 1,
                    questions: [{ id: "qx", requirementId: "REQ-001", question: "OTHER Q" }],
                    answers: [{ questionId: "qx", answer: "OTHER ANSWER" }],
                  },
                ],
              }),
            },
          },
          governingFindings: { create: [governing("REQ-001", "r9", "gap", "OTHER-CTRL")] },
        },
      });

      // ── impact analyses ──
      await db.impactAnalysis.create({
        data: {
          id: "ia-both",
          status: "completed",
          startedById: MEMBER,
          summary: "Refund changes touch payments only.",
          sourceText: "Refunds within 14 days",
          totalImpactedSymbols: 4,
          projects: {
            create: [
              { projectId: P, outcome: "affected" },
              { projectId: P2, outcome: "not-checked", outcomeReason: "no-index" },
            ],
          },
          items: {
            create: {
              projectId: P,
              requirementTitle: "Refunds within 14 days",
              severity: "high",
              impactScore: 0.8,
              affectedFileCount: 3,
              affectedSymbolCount: 4,
              summary: "The refund service changes.",
              affectedTables: { create: { tableName: "public.refunds" } },
            },
          },
        },
      });
      await db.impactItem.create({
        data: {
          impactAnalysisId: "ia-both",
          projectId: P2,
          affectedTables: { create: { tableName: "refunds" } },
        },
      });
      await db.impactAnalysis.create({
        data: {
          id: "ia-cross",
          status: "completed",
          startedById: OUTSIDER,
          summary: "CROSS SECRET",
          projects: { create: [{ projectId: P }, { projectId: P_OTHER }] },
        },
      });
      await db.impactAnalysis.create({
        data: {
          id: "ia-sibling",
          status: "completed",
          startedById: MEMBER,
          summary: "Ledger only",
          projects: { create: [{ projectId: P2 }] },
        },
      });

      // ── portfolio checks ──
      await db.portfolioAssessment.create({
        data: {
          id: "pa-mine",
          statement: "Refunds within 14 days",
          sourceProjectId: P,
          scope: "product",
          productIds: JSON.stringify([PROD, PROD_OTHER]),
          status: "completed",
          portfolioVerdict: "partial",
          summary: "Billing must change.",
          hostProductId: PROD,
          createdById: MEMBER,
          products: {
            create: [
              {
                productId: PROD,
                coverage: "partial",
                impactKind: "direct-change",
                via: "api",
                severity: "high",
                baSummary: "Billing refunds after 30 days today.",
              },
              { productId: PROD_OTHER, coverage: "covers", baSummary: "PRODUCT SECRET" },
            ],
          },
        },
      });
      await db.portfolioAssessment.create({
        data: {
          id: "pa-other",
          statement: "OTHER STATEMENT",
          sourceProjectId: P_OTHER,
          scope: "product",
          productIds: JSON.stringify([PROD_OTHER]),
          status: "completed",
          createdById: OUTSIDER,
          products: { create: { productId: PROD_OTHER, coverage: "covers" } },
        },
      });
      await db.portfolioAssessment.create({
        data: {
          id: "pa-unrelated",
          statement: "Unrelated statement",
          scope: "product",
          productIds: JSON.stringify([PROD_LOOSE]),
          status: "completed",
          createdById: MEMBER,
          products: { create: { productId: PROD_LOOSE, coverage: "covers" } },
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    afterEach(() => {
      delete process.env.GOVERNING_DOCS_ENABLED;
    });

    // ── the route-equivalent checks, on every tool ──────────────────────────
    const everyTool = () =>
      [
        [tools.createListAnalysesTool(), {}],
        [tools.createGetAnalysisTool(), { analysisId: A1 }],
        [tools.createListImpactAnalysesTool(), {}],
        [tools.createGetImpactAnalysisTool(), { impactAnalysisId: "ia-both" }],
        [tools.createListPortfolioChecksTool(), {}],
        [tools.createGetPortfolioCheckTool(), { portfolioCheckId: "pa-mine" }],
        [tools.createListClarificationAnswersTool(), {}],
        [tools.createGetGoverningFindingsTool(), { analysisId: A1 }],
      ] as const;

    it("refuses an unscoped session on every tool", async () => {
      for (const [tool, args] of everyTool()) {
        const r = await run(tool, args, ctx(MEMBER, null));
        expect(r.isError, tool.name).toBe(true);
        expect(r.text).toMatch(/project-scoped chat session/);
      }
    });

    it("refuses a caller who cannot open the chat's project on every tool", async () => {
      for (const [tool, args] of everyTool()) {
        const r = await run(tool, args, ctx(OUTSIDER));
        expect(r.isError, tool.name).toBe(true);
        expect(r.text).toBe("ERROR: this chat's project is not open to you");
      }
    });

    it("refuses a role without analysis.read on every tool", async () => {
      const hasPermission = vi.fn(() => false);
      const deps = { hasPermission };
      for (const tool of [
        tools.createListAnalysesTool(deps),
        tools.createGetAnalysisTool(deps),
        tools.createListImpactAnalysesTool(deps),
        tools.createGetImpactAnalysisTool(deps),
        tools.createListPortfolioChecksTool(deps),
        tools.createGetPortfolioCheckTool(deps),
        tools.createListClarificationAnswersTool(deps),
        tools.createGetGoverningFindingsTool(deps),
      ]) {
        const r = await run(tool, { analysisId: A1, impactAnalysisId: "x", portfolioCheckId: "x" });
        expect(r.isError, tool.name).toBe(true);
        expect(r.text).toMatch(/requires the analysis\.read permission/);
      }
      // The role it was asked about is the caller's durable role.
      expect(hasPermission).toHaveBeenCalledWith("reader", "analysis.read");
    });

    // ── analyses and findings ───────────────────────────────────────────────
    it("lists the project's analyses with counts, leaving background rows out", async () => {
      const r = await run(tools.createListAnalysesTool(), {});
      expect(r.isError).toBeUndefined();
      expect(r.resultCount).toBe(2);
      expect(r.text.indexOf(A1)).toBeLessThan(r.text.indexOf(A_FAILED));
      expect(r.text).toContain(`[${A_FAILED}] failed, started 2026-10-01: 0 requirements`);
      expect(r.text).toContain("error: provider down");
      expect(r.text).toContain(`[${A1}] completed`);
      expect(r.text).toContain(
        "1 requirements, 2 findings, 1 cross-document findings, 3 governing findings",
      );
      expect(r.text).toContain("failed agents: codebase-assessor");
      expect(r.text).not.toContain(A_BG);
      expect(r.text).not.toContain(A_OTHER);
    });

    it("reads one analysis's findings worst first, each with its id", async () => {
      const r = await run(tools.createGetAnalysisTool(), { analysisId: A1 });
      const ids = await db.finding.findMany({
        where: { agentResult: { analysisId: A1 } },
        select: { id: true, severity: true },
      });
      const high = ids.find((f) => f.severity === "high")!;
      const low = ids.find((f) => f.severity === "low")!;
      expect(r.text).toContain(`[finding:${high.id}] high security`);
      expect(r.text.indexOf(high.id)).toBeLessThan(r.text.indexOf(low.id));
      expect(r.text).toContain("code citation confirmed");
      expect(r.text).toMatch(/\[cross-doc:\w+\] medium contradiction: Refund window differs/);
      expect(r.text).toContain("codebase-assessor failed (timed out)");

      const filtered = await run(tools.createGetAnalysisTool(), {
        analysisId: A1,
        minSeverity: "medium",
      });
      expect(filtered.text).toContain(high.id);
      expect(filtered.text).not.toContain(low.id);
      expect(filtered.text).toContain("Refund window differs");
    });

    it("answers not found for another project's analysis id", async () => {
      const r = await run(tools.createGetAnalysisTool(), { analysisId: A_OTHER });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`No analysis with id ${A_OTHER} in this project`);
      expect(r.text).not.toContain("OTHER SECRET");
      // An admin, who may open the other project, still reads only the chat's.
      const asAdmin = await run(tools.createGetAnalysisTool(), { analysisId: A_OTHER }, ctx(ADMIN));
      expect(asAdmin.isError).toBe(true);
    });

    // ── impact analyses ─────────────────────────────────────────────────────
    it("lists the impact analyses that include the project", async () => {
      const r = await run(tools.createListImpactAnalysesTool(), {});
      expect(r.text).toContain("[ia-both] completed");
      expect(r.text).toContain("Payments, Ledger");
      expect(r.text).not.toContain("ia-sibling");
      // A run that also covers a project the caller cannot open names only theirs.
      expect(r.text).toContain("[ia-cross]");
      expect(r.text).not.toContain("Secret project");
      // …and without its summary, which describes the project they cannot open.
      expect(r.text).not.toContain("CROSS SECRET");
      expect(JSON.stringify(r.data)).not.toContain("CROSS SECRET");
      // An admin, who may open every project of ia-cross, sees it.
      const admin = await run(tools.createListImpactAnalysesTool(), {}, ctx(ADMIN));
      expect(admin.text).toContain("CROSS SECRET");
    });

    it("reads one impact analysis per project", async () => {
      const r = await run(tools.createGetImpactAnalysisTool(), { impactAnalysisId: "ia-both" });
      expect(r.isError).toBeUndefined();
      expect(r.text).toContain("Summary: Refund changes touch payments only.");
      expect(r.text).toContain(`## Payments [project:${P}] — affected; 1 impacted change(s)`);
      expect(r.text).toContain("tables: public.refunds");
      expect(r.text).toContain("Change analysed: Refunds within 14 days");
      expect(r.text).toContain("- refunds: Payments, Ledger");
      expect(r.text).toContain(
        `## Ledger [project:${P2}] — not-checked (no-index); 1 impacted change(s)`,
      );
      expect(r.text).toMatch(/\[item:\w+\] Requirement change: modified/);
      expect(r.text).toMatch(
        /\[item:\w+\] Refunds within 14 days: modified, severity high, impact 0\.80, match \w+; 3 files, 4 symbols/,
      );
    });

    it("refuses an impact analysis with a project the caller cannot open, or without this project", async () => {
      const cross = await run(tools.createGetImpactAnalysisTool(), {
        impactAnalysisId: "ia-cross",
      });
      expect(cross.isError).toBe(true);
      expect(cross.text).not.toContain("CROSS SECRET");
      const sibling = await run(tools.createGetImpactAnalysisTool(), {
        impactAnalysisId: "ia-sibling",
      });
      expect(sibling.isError).toBe(true);
      expect(sibling.text).toContain("No impact analysis with id ia-sibling in this project");
      // An admin may open every project of ia-cross, so reads it in P's chat.
      const admin = await run(
        tools.createGetImpactAnalysisTool(),
        { impactAnalysisId: "ia-cross" },
        ctx(ADMIN),
      );
      expect(admin.text).toContain("CROSS SECRET");
    });

    // ── portfolio checks ────────────────────────────────────────────────────
    it("lists only the portfolio checks of this project the caller may read", async () => {
      const r = await run(tools.createListPortfolioChecksTool(), {});
      expect(r.resultCount).toBe(1);
      expect(r.text).toContain("[pa-mine] completed");
      expect(r.text).not.toContain("pa-other");
      expect(r.text).not.toContain("pa-unrelated");
    });

    it("reads a portfolio check per product, with an unreadable product restricted", async () => {
      const r = await run(tools.createGetPortfolioCheckTool(), { portfolioCheckId: "pa-mine" });
      expect(r.isError).toBeUndefined();
      // The reader sees less than the run did, so the summary is recomputed, as on the page.
      expect(r.text).toContain("Summary: Partly covered by Billing");
      expect(r.text).not.toContain("Billing must change.");
      expect(r.text).toContain(
        `[product:${PROD}] Billing: partial; direct-change via api; severity high — Billing refunds after 30 days today.`,
      );
      expect(r.text).toContain(`[product:${PROD_OTHER}] restricted`);
      expect(r.text).not.toContain("PRODUCT SECRET");
    });

    it("answers not found for a portfolio check the caller cannot read or of another project", async () => {
      for (const id of ["pa-other", "pa-unrelated", "missing"]) {
        const r = await run(tools.createGetPortfolioCheckTool(), { portfolioCheckId: id });
        expect(r.isError, id).toBe(true);
        expect(r.text).toContain(`No portfolio check with id ${id} in this project`);
      }
    });

    // ── clarification answers ───────────────────────────────────────────────
    it("lists the project's answered clarifying questions, with ids", async () => {
      const r = await run(tools.createListClarificationAnswersTool(), {});
      expect(r.resultCount).toBe(2);
      expect(r.text).toContain(`[analysis:${A1} question:q1] round 1, requirement REQ-001`);
      expect(r.text).toContain("A: Calendar days.");
      expect(r.text).toContain(
        `[analysis:${A1} question:q3] round 1, requirement REQ-001, governing rule`,
      );
      // A blank answer is not an answer.
      expect(r.text).not.toContain("q2");
      expect(r.text).not.toContain("OTHER ANSWER");
    });

    it("narrows clarification answers to one analysis, and refuses another project's", async () => {
      const one = await run(tools.createListClarificationAnswersTool(), { analysisId: A1 });
      expect(one.resultCount).toBe(2);
      const none = await run(tools.createListClarificationAnswersTool(), { analysisId: A_BG });
      expect(none.resultCount).toBe(0);
      expect(none.text).toBe("No clarifying question of that analysis has been answered.");
      const other = await run(tools.createListClarificationAnswersTool(), { analysisId: A_OTHER });
      expect(other.isError).toBe(true);
      expect(other.text).not.toContain("OTHER ANSWER");
    });

    // ── governing findings ──────────────────────────────────────────────────
    it("reads an analysis's governing findings, for all requirements or one", async () => {
      const all = await run(tools.createGetGoverningFindingsTool(), { analysisId: A1 });
      expect(all.resultCount).toBe(3);
      expect(all.text).toContain('Cited clause: "Card numbers must be rendered unreadable."');
      expect(all.text).toContain("Open question: Are card numbers stored at rest?");
      expect(all.text).toContain("Analyst accepted it: Confirmed with security.");
      expect(all.text).toMatch(/PCI-9\.9[^\n]*\n  The citation could not be verified/);
      // One heading per requirement, however many findings it has.
      expect(all.text.match(/## Requirement REQ-001/g)).toHaveLength(1);
      expect(all.text).toContain("## Requirement REQ-001: Refunds within 14 days");
      expect(all.text).toMatch(/\[governing:\w+\] gap — PCI-3\.4 \(Card policy v2, §3\.4\)/);
      expect(all.text).toContain("SOX-1");

      const one = await run(tools.createGetGoverningFindingsTool(), {
        analysisId: A1,
        requirementId: "REQ-002",
      });
      expect(one.resultCount).toBe(1);
      expect(one.text).toContain("SOX-1");
      expect(one.text).not.toContain("PCI-3.4");

      const missing = await run(tools.createGetGoverningFindingsTool(), {
        analysisId: A1,
        requirementId: "REQ-404",
      });
      expect(missing.resultCount).toBe(0);
      expect(missing.text).toBe(
        "No governing rule applied to requirement REQ-404 in this analysis.",
      );
    });

    it("#2222 — says a finding judged an earlier version of an edited requirement", async () => {
      const req = await db.requirement.create({
        data: {
          analysisId: A1,
          projectId: P,
          title: "Store card tokens only",
          body: "b",
          version: 2,
        },
      });
      const row = await db.governingFinding.create({
        data: {
          ...governing(req.id, "r7", "gap", "PCI-3.5"),
          analysisId: A1,
          requirementVersions: JSON.stringify({ [req.id]: 1 }),
        },
      });
      try {
        const r = await run(tools.createGetGoverningFindingsTool(), {
          analysisId: A1,
          requirementId: req.id,
        });
        expect(r.resultCount).toBe(1);
        expect(r.text).toContain(
          'Stale: "Store card tokens only" was checked at v1 and is now v2. This result judges the earlier wording.',
        );
      } finally {
        await db.governingFinding.delete({ where: { id: row.id } });
        await db.requirement.delete({ where: { id: req.id } });
      }
    });

    it("says when the governing check never ran", async () => {
      const r = await run(tools.createGetGoverningFindingsTool(), { analysisId: A_BG });
      expect(r.resultCount).toBe(0);
      expect(r.text).toMatch(/did not run on this analysis/);
    });

    it("refuses another project's governing findings, and every read while the feature is off", async () => {
      const other = await run(tools.createGetGoverningFindingsTool(), { analysisId: A_OTHER });
      expect(other.isError).toBe(true);
      expect(other.text).not.toContain("OTHER-CTRL");

      process.env.GOVERNING_DOCS_ENABLED = "false";
      const off = await run(tools.createGetGoverningFindingsTool(), { analysisId: A1 });
      expect(off.isError).toBe(true);
      expect(off.text).toMatch(/turned off/);
    });

    // ── edge cases ──────────────────────────────────────────────────────────
    it("says so when the project has none of a result", async () => {
      const c = ctx(MEMBER, P_EMPTY);
      expect((await run(tools.createListAnalysesTool(), {}, c)).text).toBe(
        "This project has no analysis runs.",
      );
      expect((await run(tools.createListImpactAnalysesTool(), {}, c)).text).toBe(
        "No impact analysis includes this project.",
      );
      expect((await run(tools.createListPortfolioChecksTool(), {}, c)).text).toBe(
        "No portfolio check came from this project or includes its product.",
      );
      const answers = await run(tools.createListClarificationAnswersTool(), {}, c);
      expect(answers.resultCount).toBe(0);
      expect(answers.text).toBe("No clarifying question in this project has been answered.");
    });

    it("pages a listing and says how much it left out", async () => {
      const runs = await run(tools.createListAnalysesTool(), { limit: 1 });
      expect(runs.resultCount).toBe(1);
      expect(runs.text).toMatch(/^Showing the 1 newest of 2 analysis runs\./);
      const answers = await run(tools.createListClarificationAnswersTool(), { limit: 1 });
      expect(answers.resultCount).toBe(1);
      expect(answers.text).toMatch(/^Showing 1 of 2 answers\./);
      const findings = await run(tools.createGetAnalysisTool(), { analysisId: A1, limit: 1 });
      expect(findings.text).toContain("Findings (worst 1 of 2):");
      expect(findings.text).not.toContain("Verbose errors");
    });

    it("reads a run with no agents and no findings as a result, not an empty one", async () => {
      const r = await run(tools.createGetAnalysisTool(), { analysisId: A_FAILED });
      expect(r.resultCount).toBe(1);
      expect(r.text).toContain("Status: failed; started 2026-10-01; error: provider down");
      expect(r.text).toContain("Agents: none ran");
      expect(r.text).toContain("Findings (0):\n- none");
    });

    it("names a portfolio check's host product, and every product to an admin", async () => {
      const r = await run(
        tools.createGetPortfolioCheckTool(),
        { portfolioCheckId: "pa-mine" },
        ctx(ADMIN),
      );
      expect(r.text).toContain("; to be built in Billing");
      // An admin reads every product, so sees the stored summary and the other product.
      expect(r.text).toContain("Summary: Billing must change.");
      expect(r.text).toContain(`[product:${PROD_OTHER}] Other billing: covers — PRODUCT SECRET`);
    });

    it("lists an admin every impact analysis of the project, naming every project", async () => {
      const r = await run(tools.createListImpactAnalysesTool(), {}, ctx(ADMIN));
      expect(r.text).toContain("Payments, Secret project");
    });

    // ── registration ────────────────────────────────────────────────────────
    it("registers every tool once, read-only and low risk, idempotently", () => {
      const registry = new ToolRegistry();
      tools.registerResultTools(registry);
      tools.registerResultTools(registry);
      const names = registry.list().map((t) => t.name);
      for (const name of tools.RESULT_TOOL_NAMES) {
        expect(names.filter((n) => n === name)).toHaveLength(1);
        expect(registry.get(name)?.risk).toBe("low");
      }
    });
  },
);

function governing(requirementId: string, ruleId: string, status: string, controlId: string) {
  return {
    requirementId,
    ruleId,
    revisionId: "rev-1",
    revisionLabel: "v2",
    documentTitle: "Card policy",
    controlId,
    clauseRef: "§3.4",
    status,
    reasoning: `${controlId} reasoning`,
  };
}
