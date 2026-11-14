/**
 * #2239 — chat's read-only view of METIS's own results.
 *
 * Before this, chat had tools for documents (`search-knowledge`) and
 * requirements (`list_requirements` / `get_requirement`, #1030) and nothing
 * else, so "Explain the analysis results for my project" — a question the User
 * Guide suggests — was answered without reading a single result.
 *
 *   • `list_analyses` / `get_analysis` — the project's analysis runs, and one
 *     run's agent findings and cross-document findings.
 *   • `list_impact_analyses` / `get_impact_analysis` — the impact analyses that
 *     include the project, and one run's per-project results.
 *   • `list_portfolio_checks` / `get_portfolio_check` — the portfolio checks
 *     that came from the project or name its product, and one check's
 *     per-product results.
 *   • `list_clarification_answers` — the analyst's answers to the project's
 *     clarifying questions.
 *   • `get_governing_findings` — one analysis's governing findings, for all of
 *     its requirements or one of them.
 *
 * Every line the model reads carries the id of what it describes, so an answer
 * can cite (and link to) the result it came from.
 *
 * Security posture — each tool checks what the matching UI route checks:
 *   - The session's project is bound by the SERVER (`ctx.projectId`); the model
 *     never names one. An unscoped session is refused before any read.
 *   - The caller (the session's user, `ctx.userId`) needs `analysis.read`
 *     (every read route's `requirePermission`) and live access to the project
 *     (`requireProjectAccess` → `assertLiveProjectAccess`). The role is read
 *     from the database (`resolveDurableRole`), never taken from the model.
 *   - Analyses, findings, clarification answers and governing findings are read
 *     with the project as well as the id in the query, as `ensureAnalysisVisible`
 *     does; another project's id answers "not found".
 *   - An impact analysis is read through `loadAccessibleImpactDetail` (the
 *     caller must be able to open EVERY project of the run, as `GET
 *     /api/impact-analyses/:id`), and must include the session's project.
 *   - A portfolio check is read through `viewPortfolioAssessment` (products and
 *     repos the caller cannot read now are restricted or dropped, as `GET
 *     /api/portfolio-assessments/:id`), and must come from the session's
 *     project or name its product.
 *   - Read-only; risk `low` (no approval prompt, as `search-knowledge`).
 */
import { z } from "zod";
import {
  FINDING_SEVERITIES,
  RESTRICTED_SOURCE_BODY,
  RESTRICTED_SOURCE_TITLE,
  governingStaleNote,
  hasPermission as defaultHasPermission,
  type AuthPayload,
  type ImpactAnalysisDetail,
  type PermissionKey,
  type PortfolioAssessmentView,
  type RoleKey,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { chatToolReader, loadSourceGuard } from "./source-redaction.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../ai/types.js";
import { AppError } from "../../middleware/error-handler.js";
import { resolveDurableRole } from "../auth/durable-roles.js";
import { assertLiveProjectAccess } from "../custom-agents/authz.js";
import { asAuthPayload } from "../discussions/access.js";
import {
  isAdminActor,
  listMemberAccessibleProjectIds,
  type SchedulerActor,
} from "../scheduler/project-access.js";
import { listImpactAnalyses } from "../impact-analysis/impact-analysis-read.js";
import { loadAccessibleImpactDetail } from "../impact-analysis/impact-detail-access.js";
import { resolveReaderAccess, viewPortfolioAssessment } from "../portfolio/assessment-view.js";
import { mapWithConcurrency } from "../portfolio/gap-engine.js";
import { isGoverningDocsEnabled } from "../governing/flag.js";
import { listGoverningFindings } from "../governing/findings-store.js";
import { readGoverningApplicability } from "../governing/applicability-store.js";
import {
  storedRequirementStates,
  withGoverningStaleness,
} from "../governing/requirement-staleness.js";
import { isBackgroundAnalysis } from "./requirement-runs.js";
import type { ClarificationState } from "./types/requirements.js";

export const LIST_ANALYSES_TOOL_NAME = "list_analyses";
export const GET_ANALYSIS_TOOL_NAME = "get_analysis";
export const LIST_IMPACT_ANALYSES_TOOL_NAME = "list_impact_analyses";
export const GET_IMPACT_ANALYSIS_TOOL_NAME = "get_impact_analysis";
export const LIST_PORTFOLIO_CHECKS_TOOL_NAME = "list_portfolio_checks";
export const GET_PORTFOLIO_CHECK_TOOL_NAME = "get_portfolio_check";
export const LIST_CLARIFICATION_ANSWERS_TOOL_NAME = "list_clarification_answers";
export const GET_GOVERNING_FINDINGS_TOOL_NAME = "get_governing_findings";

export const RESULT_TOOL_NAMES = [
  LIST_ANALYSES_TOOL_NAME,
  GET_ANALYSIS_TOOL_NAME,
  LIST_IMPACT_ANALYSES_TOOL_NAME,
  GET_IMPACT_ANALYSIS_TOOL_NAME,
  LIST_PORTFOLIO_CHECKS_TOOL_NAME,
  GET_PORTFOLIO_CHECK_TOOL_NAME,
  LIST_CLARIFICATION_ANSWERS_TOOL_NAME,
  GET_GOVERNING_FINDINGS_TOOL_NAME,
] as const;

/** The permission every read route of these results requires. */
const READ_PERMISSION: PermissionKey = "analysis.read";
/** Analysis rows one listing reads before leaving background rows out. */
const ANALYSIS_SCAN = 200;
/** Portfolio checks one listing looks at (the UI list's page size). */
const PORTFOLIO_SCAN = 25;
/** Clarification dialogs one listing reads. */
const CLARIFICATION_SCAN = 50;
/** Longest stretch of stored prose quoted into one line. */
const PROSE_MAX = 400;

export interface ResultToolsDeps {
  /** The caller's role; defaults to the durable role in the database. */
  resolveRole?: (userId: string) => Promise<RoleKey>;
  /** Defaults to the shared RBAC registry's `hasPermission`. */
  hasPermission?: (role: RoleKey, permission: PermissionKey) => boolean;
}

const UNSCOPED: ToolResult = {
  text: "ERROR: METIS results can only be read in a project-scoped chat session",
  isError: true,
};
const NO_PERMISSION: ToolResult = {
  text: `ERROR: reading METIS results requires the ${READ_PERMISSION} permission`,
  isError: true,
};
const PROJECT_CLOSED: ToolResult = {
  text: "ERROR: this chat's project is not open to you",
  isError: true,
};

function notFound(what: string, id: string, listTool: string): ToolResult {
  return {
    text: `ERROR: No ${what} with id ${id} in this project. Use ${listTool} to find ids.`,
    isError: true,
  };
}

/** Who is reading, once the route-equivalent checks have passed. */
interface Reader {
  projectId: string;
  actor: SchedulerActor;
  payload: AuthPayload;
}

/**
 * The checks every read route makes before it reads: a project-scoped session,
 * `analysis.read`, and live access to the project. A result is a refusal.
 */
async function authorize(ctx: ToolContext, deps: ResultToolsDeps): Promise<Reader | ToolResult> {
  const projectId = ctx.projectId;
  if (!projectId) return UNSCOPED;
  const role = await (deps.resolveRole ?? resolveDurableRole)(ctx.userId);
  if (!(deps.hasPermission ?? defaultHasPermission)(role, READ_PERMISSION)) return NO_PERMISSION;
  const payload = await asAuthPayload({ id: ctx.userId, role });
  try {
    await assertLiveProjectAccess(payload, projectId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return PROJECT_CLOSED;
    throw err;
  }
  return { projectId, actor: { id: ctx.userId, role }, payload };
}

function isRefusal(r: Reader | ToolResult): r is ToolResult {
  return "text" in r;
}

function clip(text: string, max = PROSE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function day(d: Date | string): string {
  return (typeof d === "string" ? d : d.toISOString()).slice(0, 10);
}

const limitArg = (max: number) => z.number().int().min(1).max(max).optional();

// ─── analyses and findings ──────────────────────────────────────────────────

const listAnalysesSchema = z.object({ limit: limitArg(50) });

export function createListAnalysesTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof listAnalysesSchema> {
  return {
    name: LIST_ANALYSES_TOOL_NAME,
    description:
      "List this project's METIS analysis runs, newest first: id, status, dates, and how many " +
      "requirements, findings, cross-document findings and governing findings each produced. " +
      "Read one run's findings with get_analysis.",
    schema: listAnalysesSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      const rows = await prisma.analysis.findMany({
        where: { projectId: reader.projectId, deletedAt: null },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: ANALYSIS_SCAN,
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          errorMessage: true,
          metadata: true,
          agentResults: {
            select: { agentKey: true, status: true, _count: { select: { findings: true } } },
          },
          _count: {
            select: {
              requirements: { where: { deletedAt: null } },
              crossDocFindings: true,
              governingFindings: true,
            },
          },
        },
      });
      // As the analysis history does: code-graph ingests and the like are not runs.
      const runs = rows.filter((r) => !isBackgroundAnalysis(r.metadata));
      const shown = runs.slice(0, args.limit ?? 10);
      if (shown.length === 0) {
        return {
          text: "This project has no analysis runs.",
          data: { analyses: [] },
          resultCount: 0,
        };
      }
      const analyses = shown.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        requirements: r._count.requirements,
        findings: r.agentResults.reduce((n, a) => n + a._count.findings, 0),
        crossDocFindings: r._count.crossDocFindings,
        governingFindings: r._count.governingFindings,
        failedAgents: r.agentResults.filter((a) => a.status === "failed").map((a) => a.agentKey),
        errorMessage: r.errorMessage,
      }));
      const lines = analyses.map(
        (a) =>
          `- [${a.id}] ${a.status}, started ${day(a.startedAt)}` +
          (a.completedAt ? `, completed ${day(a.completedAt)}` : "") +
          `: ${a.requirements} requirements, ${a.findings} findings, ` +
          `${a.crossDocFindings} cross-document findings, ${a.governingFindings} governing findings` +
          (a.failedAgents.length ? `; failed agents: ${a.failedAgents.join(", ")}` : "") +
          (a.errorMessage ? `; error: ${clip(a.errorMessage, 200)}` : ""),
      );
      const header =
        runs.length > shown.length
          ? `Showing the ${shown.length} newest of ${runs.length} analysis runs.`
          : `${runs.length} analysis run${runs.length === 1 ? "" : "s"}.`;
      return {
        text: `${header}\n${lines.join("\n")}`,
        data: { analyses },
        resultCount: analyses.length,
      };
    },
  };
}

const getAnalysisSchema = z.object({
  analysisId: z.string().min(1).max(200).describe("Id from list_analyses"),
  minSeverity: z
    .enum(FINDING_SEVERITIES)
    .optional()
    .describe("Only findings at this severity or worse"),
  limit: limitArg(100),
});

const severityRank = (s: string): number => {
  const i = (FINDING_SEVERITIES as readonly string[]).indexOf(s);
  return i === -1 ? FINDING_SEVERITIES.length : i;
};

export function createGetAnalysisTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof getAnalysisSchema> {
  return {
    name: GET_ANALYSIS_TOOL_NAME,
    description:
      "Read one of this project's METIS analysis runs: its status, each agent's outcome, and " +
      "its findings (security, architecture, rationale, …) and cross-document findings " +
      "(contradictions and completeness gaps across the documents), worst first, each with its " +
      "id. Take the id from list_analyses. Its requirements are read with list_requirements.",
    schema: getAnalysisSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      const a = await prisma.analysis.findFirst({
        where: { id: args.analysisId, projectId: reader.projectId, deletedAt: null },
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
          errorMessage: true,
          agentResults: {
            orderBy: { startedAt: "asc" },
            select: {
              agentKey: true,
              status: true,
              errorMessage: true,
              findings: {
                select: {
                  id: true,
                  category: true,
                  severity: true,
                  title: true,
                  body: true,
                  derivation: true,
                  confidence: true,
                  verificationStatus: true,
                  sourceIds: true,
                },
              },
            },
          },
          crossDocFindings: {
            select: {
              id: true,
              kind: true,
              severity: true,
              title: true,
              detail: true,
              sourceIds: true,
            },
          },
        },
      });
      if (!a) return notFound("analysis", args.analysisId, LIST_ANALYSES_TOOL_NAME);

      // #2447 — a finding the user cannot see a source of is its placeholder:
      // the model is never handed its text to cite. Ids and severity stay.
      const guarded = (row: { sourceIds: string | null }) => ({
        analysisId: a.id,
        sourceIds: row.sourceIds,
      });
      const guard = await loadSourceGuard(chatToolReader(ctx), [
        ...a.agentResults.flatMap((r) => r.findings.map(guarded)),
        ...a.crossDocFindings.map(guarded),
      ]);
      const findingRows = a.agentResults.flatMap((r) =>
        r.findings.map(({ sourceIds, ...f }) =>
          guard.canSee(guarded({ sourceIds }))
            ? { ...f, agentKey: r.agentKey }
            : {
                ...f,
                agentKey: r.agentKey,
                title: RESTRICTED_SOURCE_TITLE,
                body: RESTRICTED_SOURCE_BODY,
                verificationStatus: null,
                restricted: true as const,
              },
        ),
      );
      const crossDocRows = a.crossDocFindings.map(({ sourceIds, ...f }) =>
        guard.canSee(guarded({ sourceIds }))
          ? f
          : {
              ...f,
              title: RESTRICTED_SOURCE_TITLE,
              detail: RESTRICTED_SOURCE_BODY,
              restricted: true as const,
            },
      );

      const worst = args.minSeverity ? severityRank(args.minSeverity) : Infinity;
      const keep = (s: string) => severityRank(s) <= worst;
      const findings = findingRows
        .filter((f) => keep(f.severity))
        .sort((x, y) => severityRank(x.severity) - severityRank(y.severity));
      const crossDoc = crossDocRows
        .filter((f) => keep(f.severity))
        .sort((x, y) => severityRank(x.severity) - severityRank(y.severity));
      const limit = args.limit ?? 30;
      const shownFindings = findings.slice(0, limit);
      const shownCrossDoc = crossDoc.slice(0, limit);

      const out: string[] = [
        `# Analysis [${a.id}]`,
        `Status: ${a.status}; started ${day(a.startedAt)}` +
          (a.completedAt ? `; completed ${day(a.completedAt)}` : "") +
          (a.errorMessage ? `; error: ${clip(a.errorMessage, 200)}` : ""),
        `Agents: ${
          a.agentResults.length
            ? a.agentResults
                .map(
                  (r) =>
                    `${r.agentKey} ${r.status}` +
                    (r.errorMessage ? ` (${clip(r.errorMessage, 120)})` : ""),
                )
                .join("; ")
            : "none ran"
        }`,
        "",
        findings.length > shownFindings.length
          ? `Findings (worst ${shownFindings.length} of ${findings.length}):`
          : `Findings (${findings.length}):`,
        ...(shownFindings.length
          ? shownFindings.map(
              (f) =>
                `- [finding:${f.id}] ${f.severity} ${f.category} (${f.agentKey}): ${clip(f.title, 200)}` +
                ` — ${clip(f.body)}` +
                ` (${f.derivation}, confidence ${f.confidence.toFixed(2)}` +
                (f.verificationStatus ? `, code citation ${f.verificationStatus}` : "") +
                ")",
            )
          : ["- none"]),
        "",
        crossDoc.length > shownCrossDoc.length
          ? `Cross-document findings (worst ${shownCrossDoc.length} of ${crossDoc.length}):`
          : `Cross-document findings (${crossDoc.length}):`,
        ...(shownCrossDoc.length
          ? shownCrossDoc.map(
              (f) =>
                `- [cross-doc:${f.id}] ${f.severity} ${f.kind}: ${clip(f.title, 200)} — ${clip(f.detail)}`,
            )
          : ["- none"]),
      ];
      return {
        text: out.join("\n"),
        data: {
          id: a.id,
          status: a.status,
          findings: shownFindings,
          crossDocFindings: shownCrossDoc,
          totals: { findings: findings.length, crossDocFindings: crossDoc.length },
        },
        resultCount: shownFindings.length + shownCrossDoc.length || 1,
      };
    },
  };
}

// ─── impact analyses ────────────────────────────────────────────────────────

async function projectNames(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.project.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((p) => [p.id, p.name]));
}

const listImpactSchema = z.object({ limit: limitArg(50) });

export function createListImpactAnalysesTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof listImpactSchema> {
  return {
    name: LIST_IMPACT_ANALYSES_TOOL_NAME,
    description:
      "List the METIS impact analyses that include this project (what a requirement change " +
      "affects in the code and data of one or more projects), newest first: id, status, date, " +
      "the projects it covered and its summary. Read one with get_impact_analysis.",
    schema: listImpactSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      // GET /api/impact-analyses?projectId= — the same filter and the same names rule.
      const accessibleProjectIds = isAdminActor(reader.actor)
        ? null
        : await listMemberAccessibleProjectIds(reader.actor);
      const rows = await listImpactAnalyses({
        accessibleProjectIds,
        actorId: reader.actor.id,
        projectId: reader.projectId,
        limit: args.limit ?? 10,
      });
      if (rows.length === 0) {
        return {
          text: "No impact analysis includes this project.",
          data: { impactAnalyses: [] },
          resultCount: 0,
        };
      }
      // A run's summary describes every project it covered, so it is shown only
      // when the reader can open all of them — as get_impact_analysis requires
      // (loadAccessibleImpactDetail). Otherwise the row lists without it.
      // `projectIds` is already narrowed to the reader's projects; `projectCount`
      // is the run's full count, so a shorter list means a project they can't open.
      const readable = (r: (typeof rows)[number]): boolean =>
        accessibleProjectIds === null || r.projectIds.length === r.projectCount;
      const visibleRows = rows.map((r) => (readable(r) ? r : { ...r, summary: null }));
      const names = await projectNames(visibleRows.flatMap((r) => r.projectIds));
      const lines = visibleRows.map(
        (r) =>
          `- [${r.id}] ${r.status}, started ${day(r.startedAt)}; ${r.projectCount} project(s)` +
          (r.projectIds.length
            ? `: ${r.projectIds.map((id) => names.get(id) ?? id).join(", ")}`
            : "") +
          `; ${r.totalImpactedSymbols} impacted symbols` +
          (r.rerunOfId ? `; re-run of ${r.rerunOfId}` : "") +
          (r.summary ? ` — ${clip(r.summary, 240)}` : ""),
      );
      return {
        text: `${rows.length} impact analys${rows.length === 1 ? "is" : "es"}.\n${lines.join("\n")}`,
        data: { impactAnalyses: visibleRows },
        resultCount: rows.length,
      };
    },
  };
}

const getImpactSchema = z.object({
  impactAnalysisId: z.string().min(1).max(200).describe("Id from list_impact_analyses"),
});

function renderImpact(detail: ImpactAnalysisDetail, names: Map<string, string>): string {
  const out: string[] = [
    `# Impact analysis [${detail.id}]`,
    `Status: ${detail.status}; started ${day(detail.startedAt)}` +
      (detail.completedAt ? `; completed ${day(detail.completedAt)}` : "") +
      `; ${detail.totalImpactedSymbols} impacted symbols` +
      (detail.errorMessage ? `; error: ${clip(detail.errorMessage, 200)}` : ""),
  ];
  if (detail.summary) out.push(`Summary: ${clip(detail.summary, 800)}`);
  if (detail.sourceText) out.push(`Change analysed: ${clip(detail.sourceText, 600)}`);
  const outcomes = new Map(detail.projectOutcomes.map((o) => [o.projectId, o]));
  for (const projectId of detail.projectIds) {
    const o = outcomes.get(projectId);
    const items = detail.items.filter((i) => i.projectId === projectId);
    out.push(
      "",
      `## ${names.get(projectId) ?? projectId} [project:${projectId}] — ` +
        (o ? `${o.outcome}${o.reason ? ` (${o.reason})` : ""}` : "no outcome recorded") +
        `; ${items.length} impacted change(s)`,
    );
    for (const i of items) {
      const tables = [...new Set(i.affectedTables.map((t) => t.tableName))];
      out.push(
        `- [item:${i.id}] ${clip(i.requirementTitle ?? "Requirement change", 160)}` +
          (i.requirementId ? ` (requirement ${i.requirementId})` : "") +
          `: ${i.changeType}, severity ${i.severity}, impact ${i.impactScore.toFixed(2)}, ` +
          `match ${i.matchQuality}; ${i.affectedFileCount} files, ${i.affectedSymbolCount} symbols` +
          (tables.length ? `; tables: ${tables.slice(0, 10).join(", ")}` : "") +
          (i.summary ? ` — ${clip(i.summary, 300)}` : ""),
      );
    }
  }
  if (detail.sharedTableImpacts.length) {
    out.push(
      "",
      "Tables impacted in more than one project:",
      ...detail.sharedTableImpacts.map(
        (s) => `- ${s.tableName}: ${s.projectIds.map((id) => names.get(id) ?? id).join(", ")}`,
      ),
    );
  }
  return out.join("\n");
}

export function createGetImpactAnalysisTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof getImpactSchema> {
  return {
    name: GET_IMPACT_ANALYSIS_TOOL_NAME,
    description:
      "Read one METIS impact analysis that includes this project: the change it analysed, its " +
      "summary, and per project what was affected (each change's severity, files, symbols and " +
      "database tables) or why a project was not checked. Take the id from list_impact_analyses.",
    schema: getImpactSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      const missing = notFound(
        "impact analysis",
        args.impactAnalysisId,
        LIST_IMPACT_ANALYSES_TOOL_NAME,
      );
      let detail: ImpactAnalysisDetail;
      try {
        detail = await loadAccessibleImpactDetail(reader.actor, args.impactAnalysisId);
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 404) return missing;
        throw err;
      }
      // Project-scoped: a run that does not include this chat's project is not its result.
      if (!detail.projectIds.includes(reader.projectId)) return missing;
      const names = await projectNames(detail.projectIds);
      const { sourceText: _sourceText, ...rest } = detail;
      return {
        text: renderImpact(detail, names),
        data: { ...rest, projectNames: Object.fromEntries(names) },
        resultCount: 1,
      };
    },
  };
}

// ─── portfolio checks ───────────────────────────────────────────────────────

async function projectProductId(projectId: string): Promise<string | null> {
  const p = await prisma.project.findFirst({
    where: { id: projectId },
    select: { productId: true },
  });
  return p?.productId ?? null;
}

/** Whether a check, as the reader sees it, is this project's: from it, or naming its product. */
function concernsProject(
  view: PortfolioAssessmentView,
  projectId: string,
  productId: string | null,
): boolean {
  if (view.sourceProjectId === projectId) return true;
  return (
    productId !== null &&
    view.products.some((p) => p.productId === productId && p.coverage !== "restricted")
  );
}

const listPortfolioSchema = z.object({ limit: limitArg(PORTFOLIO_SCAN) });

export function createListPortfolioChecksTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof listPortfolioSchema> {
  return {
    name: LIST_PORTFOLIO_CHECKS_TOOL_NAME,
    description:
      "List the METIS portfolio checks (a requirement checked across the product portfolio: " +
      "which products already cover it and which must change) that came from this project or " +
      "include its product, newest first: id, status, verdict and the requirement checked. Read " +
      "one with get_portfolio_check.",
    schema: listPortfolioSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      const productId = await projectProductId(reader.projectId);
      const rows = await prisma.portfolioAssessment.findMany({
        where: {
          OR: [
            { sourceProjectId: reader.projectId },
            ...(productId
              ? [{ products: { some: { productId, coverage: { not: "restricted" } } } }]
              : []),
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PORTFOLIO_SCAN,
        select: { id: true },
      });
      // Every row is re-read as this reader may see it now, as the UI list does.
      const access = await resolveReaderAccess(reader.payload);
      const views = (
        await mapWithConcurrency(rows, 5, (r) => viewPortfolioAssessment(access, r.id))
      ).filter(
        (v): v is PortfolioAssessmentView =>
          v !== null && concernsProject(v, reader.projectId, productId),
      );
      const shown = views.slice(0, args.limit ?? 10);
      if (shown.length === 0) {
        return {
          text: "No portfolio check came from this project or includes its product.",
          data: { portfolioChecks: [] },
          resultCount: 0,
        };
      }
      const lines = shown.map(
        (v) =>
          `- [${v.id}] ${v.status}, ${day(v.createdAt)}; verdict ${v.verdict ?? "none yet"}; ` +
          `${v.productIds.length} product(s) — ${clip(v.statement, 200)}`,
      );
      return {
        text: `${shown.length} portfolio check${shown.length === 1 ? "" : "s"}.\n${lines.join("\n")}`,
        data: {
          portfolioChecks: shown.map((v) => ({
            id: v.id,
            status: v.status,
            verdict: v.verdict,
            statement: v.statement,
            createdAt: v.createdAt,
          })),
        },
        resultCount: shown.length,
      };
    },
  };
}

const getPortfolioSchema = z.object({
  portfolioCheckId: z.string().min(1).max(200).describe("Id from list_portfolio_checks"),
});

function renderPortfolio(v: PortfolioAssessmentView): string {
  const name = (id: string) => v.productNames[id] ?? id;
  const out: string[] = [
    `# Portfolio check [${v.id}]`,
    `Status: ${v.status}; verdict: ${v.verdict ?? "none yet"}; created ${day(v.createdAt)}` +
      (v.hostProductId ? `; to be built in ${name(v.hostProductId)}` : ""),
    `Requirement checked: ${clip(v.statement, 800)}`,
  ];
  if (v.summary) out.push(`Summary: ${clip(v.summary, 800)}`);
  out.push("", "Products:");
  for (const p of v.products) {
    if (p.coverage === "restricted") {
      out.push(`- [product:${p.productId}] restricted: you cannot read this product`);
      continue;
    }
    out.push(
      `- [product:${p.productId}] ${name(p.productId)}: ${p.coverage}` +
        (p.impactKind !== "none" ? `; ${p.impactKind}${p.via ? ` via ${p.via}` : ""}` : "") +
        (p.severity ? `; severity ${p.severity}` : "") +
        (p.baSummary ? ` — ${clip(p.baSummary)}` : ""),
    );
  }
  if (v.products.length === 0) out.push("- none yet");
  return out.join("\n");
}

export function createGetPortfolioCheckTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof getPortfolioSchema> {
  return {
    name: GET_PORTFOLIO_CHECK_TOOL_NAME,
    description:
      "Read one METIS portfolio check of this project: the requirement checked, the verdict, " +
      "its summary, and per product whether it covers the requirement, partly covers it or must " +
      "change, and how it is affected downstream. Take the id from list_portfolio_checks.",
    schema: getPortfolioSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      const access = await resolveReaderAccess(reader.payload);
      const view = await viewPortfolioAssessment(access, args.portfolioCheckId);
      if (
        !view ||
        !concernsProject(view, reader.projectId, await projectProductId(reader.projectId))
      ) {
        return notFound("portfolio check", args.portfolioCheckId, LIST_PORTFOLIO_CHECKS_TOOL_NAME);
      }
      return {
        text: renderPortfolio(view),
        data: {
          id: view.id,
          status: view.status,
          verdict: view.verdict,
          statement: view.statement,
          summary: view.summary,
          products: view.products,
          productNames: view.productNames,
        },
        resultCount: 1,
      };
    },
  };
}

// ─── clarification answers ──────────────────────────────────────────────────

const listClarificationSchema = z.object({
  analysisId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Only this analysis's answers (id from list_analyses)"),
  limit: limitArg(200),
});

interface ClarificationAnswerLine {
  analysisId: string;
  round: number;
  questionId: string;
  requirementId: string | null;
  question: string;
  answer: string;
  governing: boolean;
}

/** The answered questions of one stored dialog, oldest round first. */
function answersOf(analysisId: string, raw: string): ClarificationAnswerLine[] {
  let state: ClarificationState;
  try {
    state = JSON.parse(raw) as ClarificationState;
  } catch {
    return [];
  }
  const out: ClarificationAnswerLine[] = [];
  for (const round of Array.isArray(state?.rounds) ? state.rounds : []) {
    const questions = new Map((round.questions ?? []).map((q) => [q.id, q]));
    for (const a of round.answers ?? []) {
      if (typeof a?.answer !== "string" || a.answer.trim() === "") continue;
      const q = questions.get(a.questionId);
      out.push({
        analysisId,
        round: round.round,
        questionId: a.questionId,
        requirementId: q?.governing?.requirementId ?? q?.requirementId ?? null,
        question: q?.question ?? "(question not recorded)",
        answer: a.answer,
        governing: q?.governing !== undefined,
      });
    }
  }
  return out;
}

export function createListClarificationAnswersTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof listClarificationSchema> {
  return {
    name: LIST_CLARIFICATION_ANSWERS_TOOL_NAME,
    description:
      "List the analyst's answers to the clarifying questions METIS asked during this " +
      "project's analyses (and to questions that settled whether a governing rule applies), " +
      "newest analysis first: each with its analysis id, question id, the requirement it was " +
      "about, the question and the answer.",
    schema: listClarificationSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      if (args.analysisId) {
        const a = await prisma.analysis.findFirst({
          where: { id: args.analysisId, projectId: reader.projectId, deletedAt: null },
          select: { id: true },
        });
        if (!a) return notFound("analysis", args.analysisId, LIST_ANALYSES_TOOL_NAME);
      }
      const rows = await prisma.clarificationDialogState.findMany({
        where: {
          analysis: {
            projectId: reader.projectId,
            deletedAt: null,
            ...(args.analysisId ? { id: args.analysisId } : {}),
          },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: CLARIFICATION_SCAN,
        select: { analysisId: true, state: true },
      });
      const all = rows.flatMap((r) => answersOf(r.analysisId, r.state));
      const shown = all.slice(0, args.limit ?? 50);
      if (shown.length === 0) {
        return {
          text: args.analysisId
            ? "No clarifying question of that analysis has been answered."
            : "No clarifying question in this project has been answered.",
          data: { answers: [] },
          resultCount: 0,
        };
      }
      const lines = shown.map(
        (a) =>
          `- [analysis:${a.analysisId} question:${a.questionId}] round ${a.round}` +
          (a.requirementId ? `, requirement ${a.requirementId}` : "") +
          (a.governing ? ", governing rule" : "") +
          `\n  Q: ${clip(a.question)}\n  A: ${clip(a.answer, 800)}`,
      );
      const header =
        all.length > shown.length
          ? `Showing ${shown.length} of ${all.length} answers.`
          : `${all.length} answer${all.length === 1 ? "" : "s"}.`;
      return {
        text: `${header}\n${lines.join("\n")}`,
        data: { answers: shown },
        resultCount: shown.length,
      };
    },
  };
}

// ─── governing findings ─────────────────────────────────────────────────────

const governingSchema = z.object({
  analysisId: z.string().min(1).max(200).describe("Id from list_analyses"),
  requirementId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Only this requirement's findings: the analysis's requirement id as the findings name it " +
        "(for example REQ-002). Omit to read every requirement's.",
    ),
});

export function createGetGoverningFindingsTool(
  deps: ResultToolsDeps = {},
): ToolDefinition<typeof governingSchema> {
  return {
    name: GET_GOVERNING_FINDINGS_TOOL_NAME,
    description:
      "Read the governing findings of one of this project's analyses: each governing rule " +
      "(policy, standard or regulation control) checked against a requirement, as Compliant, " +
      "Gap or Needs BA input, with the clause it cites and the analyst's decision. Pass " +
      "requirementId for one requirement. Take the analysis id from list_analyses.",
    schema: governingSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const reader = await authorize(ctx, deps);
      if (isRefusal(reader)) return reader;
      // As the route: no governing findings exist while the feature is off.
      if (!isGoverningDocsEnabled()) {
        return {
          text: "ERROR: governing documents are turned off on this server",
          isError: true,
        };
      }
      const a = await prisma.analysis.findFirst({
        where: { id: args.analysisId, projectId: reader.projectId, deletedAt: null },
        select: { id: true },
      });
      if (!a) return notFound("analysis", args.analysisId, LIST_ANALYSES_TOOL_NAME);
      // Read by the analysis id alone, which the query above bound to this project.
      const [stored, applicability, states] = await Promise.all([
        listGoverningFindings(a.id),
        readGoverningApplicability(a.id),
        storedRequirementStates(a.id, reader.projectId),
      ]);
      // #2222 — as the route: a finding that judged an earlier wording says so.
      const all = withGoverningStaleness(stored, states, applicability);
      const findings = args.requirementId
        ? all.filter((f) => f.requirementId === args.requirementId)
        : all;
      if (findings.length === 0) {
        const checked = applicability?.requirements.some((r) => !r.error) ?? false;
        return {
          text: !checked
            ? "The governing check did not run on this analysis, so it has no governing findings."
            : args.requirementId
              ? `No governing rule applied to requirement ${args.requirementId} in this analysis.`
              : "The governing check ran on this analysis and no governing rule applied.",
          data: { findings: [] },
          resultCount: 0,
        };
      }
      const textOf = new Map(
        (applicability?.requirements ?? []).map((r) => [r.requirementId, r.text]),
      );
      const out: string[] = [`# Governing findings of analysis [${a.id}]`];
      let current: string | null = null;
      for (const f of findings) {
        if (f.requirementId !== current) {
          current = f.requirementId;
          const text = textOf.get(f.requirementId);
          out.push("", `## Requirement ${f.requirementId}${text ? `: ${clip(text, 300)}` : ""}`);
        }
        out.push(
          `- [governing:${f.id}] ${f.status} — ${f.controlId} (${clip(f.documentTitle, 120)} ` +
            `${f.revisionLabel}, ${f.clauseRef}): ${clip(f.reasoning)}` +
            (f.clauseExcerpt ? `\n  Cited clause: "${clip(f.clauseExcerpt, 300)}"` : "") +
            (f.citationDropped
              ? "\n  The citation could not be verified, so it was dropped."
              : "") +
            (f.businessQuestion ? `\n  Open question: ${clip(f.businessQuestion, 300)}` : "") +
            (f.stale?.length ? `\n  ${clip(governingStaleNote(f.stale) ?? "", 300)}` : "") +
            (f.decision
              ? `\n  Analyst ${f.decision} it${f.decisionNote ? `: ${clip(f.decisionNote, 300)}` : ""}`
              : ""),
        );
      }
      return {
        text: out.join("\n"),
        data: { analysisId: a.id, findings },
        resultCount: findings.length,
      };
    },
  };
}

/** Idempotent boot registration (`server.ts`). */
export function registerResultTools(
  registry: { register: (t: ToolDefinition) => void; unregister: (n: string) => boolean },
  deps: ResultToolsDeps = {},
): void {
  const tools = [
    createListAnalysesTool(deps),
    createGetAnalysisTool(deps),
    createListImpactAnalysesTool(deps),
    createGetImpactAnalysisTool(deps),
    createListPortfolioChecksTool(deps),
    createGetPortfolioCheckTool(deps),
    createListClarificationAnswersTool(deps),
    createGetGoverningFindingsTool(deps),
  ];
  for (const t of tools) {
    registry.unregister(t.name);
    registry.register(t as unknown as ToolDefinition);
  }
}
