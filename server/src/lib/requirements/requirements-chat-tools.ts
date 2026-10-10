/**
 * #1030 — chat's read-only view of the project's own requirements.
 *
 * Before this, chat had no tool that read METIS requirements: asked which
 * approved requirements touch the database, it searched the knowledge base
 * (which holds uploaded documents, not requirements), found nothing, and told
 * the analyst her requirements did not exist.
 *
 *   • `list_requirements` — the session project's requirements, filtered by
 *     review status, visible label and/or a text query over title + body.
 *   • `get_requirement` — one requirement with its acceptance criteria, code
 *     links, data (table/column) mappings and requirement → spec → code trace.
 *
 * Security posture:
 *   - Project-scoped by the SERVER: every query filters on `ctx.projectId`
 *     (the session's bound project) as well as the id; the model never names a
 *     project. An unscoped session is refused before any read.
 *   - Read-only; risk `low` (no approval prompt, as `search-knowledge`).
 *   - Hidden `finding:*` / legacy `review:*` labels are never shown or matched.
 *   - Text filtering is done in memory, so no model text reaches a query.
 */
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  REQUIREMENT_REVIEW_STATUSES,
  parseAcceptanceCriteria,
  type RequirementReviewStatus,
  type RequirementTraceabilityChain,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import type { ToolDefinition, ToolResult } from "../ai/types.js";
import { resolveRequirementReviewStatus } from "../analysis/analysis-service.js";
import {
  parseRequirementLabels,
  visibleRequirementLabels,
} from "../analysis/requirement-labels.js";
import { getRequirementChain } from "../traceability/traceability-spine.js";

export const LIST_REQUIREMENTS_TOOL_NAME = "list_requirements";
export const GET_REQUIREMENT_TOOL_NAME = "get_requirement";

/** Rows read per listing — a ceiling on one project's scan, not a page size. */
const MAX_SCAN = 5000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export interface RequirementToolsDeps {
  prisma?: Pick<PrismaClient, "requirement">;
  /** The requirement → spec → code chain (`traceability-spine.ts`). */
  chain?: (projectId: string, requirementId: string) => Promise<RequirementTraceabilityChain>;
}

const UNSCOPED: ToolResult = {
  text: "ERROR: requirements can only be read in a project-scoped chat session",
  isError: true,
};

const listSchema = z.object({
  status: z
    .enum(REQUIREMENT_REVIEW_STATUSES)
    .optional()
    .describe("Only requirements in this review status"),
  label: z.string().min(1).max(200).optional().describe("Only requirements carrying this label"),
  query: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Words to look for in the title or body; a requirement matching any word is kept"),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

const getSchema = z.object({
  requirementId: z.string().min(1).max(200).describe("Id from list_requirements"),
});

interface ListedRequirement {
  id: string;
  title: string;
  status: RequirementReviewStatus;
  type: string;
  priority: string;
  labels: string[];
  codeLinks: number;
  dataMappings: number;
}

function pickPrisma(deps: RequirementToolsDeps): Pick<PrismaClient, "requirement"> {
  return deps.prisma ?? (defaultPrisma as unknown as Pick<PrismaClient, "requirement">);
}

function queryTerms(query: string | undefined): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function createListRequirementsTool(
  deps: RequirementToolsDeps = {},
): ToolDefinition<typeof listSchema> {
  return {
    name: LIST_REQUIREMENTS_TOOL_NAME,
    description:
      "List this project's METIS requirements (the ones produced by analyses or imported), " +
      "optionally filtered by review status (draft|approved|rejected|deferred), label, or words " +
      "in the title/body. Use this — not the knowledge-base search — whenever the user asks " +
      "about the project's requirements. Returns id, title, status, labels and how many code " +
      "links and data (table/column) mappings each has; read one in full with get_requirement.",
    schema: listSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      if (!ctx.projectId) return UNSCOPED;
      const terms = queryTerms(args.query);
      const scanned = await pickPrisma(deps).requirement.findMany({
        where: { projectId: ctx.projectId, deletedAt: null },
        select: {
          id: true,
          title: true,
          // The body is only read to match query words; skip it otherwise.
          body: terms.length > 0,
          type: true,
          priority: true,
          labels: true,
          reviewStatus: true,
          _count: { select: { codeMappings: true, dataMappings: { where: { deletedAt: null } } } },
        },
        orderBy: [{ updatedAt: "desc" }],
        take: MAX_SCAN + 1,
      });
      const truncated = scanned.length > MAX_SCAN;
      const rows = truncated ? scanned.slice(0, MAX_SCAN) : scanned;
      const partial = truncated
        ? ` Only the ${MAX_SCAN} most recently updated requirements were scanned, so totals and matches are partial.`
        : "";

      const totals: Record<RequirementReviewStatus, number> = {
        draft: 0,
        approved: 0,
        rejected: 0,
        deferred: 0,
      };
      const label = args.label?.toLowerCase();
      const matched: ListedRequirement[] = [];
      for (const r of rows) {
        const status = resolveRequirementReviewStatus(
          r.reviewStatus,
          parseRequirementLabels(r.labels),
        );
        totals[status] += 1;
        const labels = visibleRequirementLabels(r.labels);
        if (args.status && status !== args.status) continue;
        if (label && !labels.some((l) => l.toLowerCase() === label)) continue;
        if (terms.length > 0) {
          const haystack = `${r.title}\n${r.body ?? ""}`.toLowerCase();
          if (!terms.some((t) => haystack.includes(t))) continue;
        }
        matched.push({
          id: r.id,
          title: r.title,
          status,
          type: r.type,
          priority: r.priority,
          labels,
          codeLinks: r._count.codeMappings,
          dataMappings: r._count.dataMappings,
        });
      }

      const limit = args.limit ?? DEFAULT_LIMIT;
      const shown = matched.slice(0, limit);
      if (shown.length === 0) {
        const breakdown = REQUIREMENT_REVIEW_STATUSES.map((s) => `${s}: ${totals[s]}`).join(", ");
        return {
          text:
            `No requirement matched those filters. This project has ${rows.length} ` +
            `requirements in total (${breakdown}).${partial}`,
          data: { requirements: [], total: 0, projectTotals: totals },
          resultCount: 0,
        };
      }
      const lines = shown.map(
        (r) =>
          `- [${r.id}] ${r.title} (${r.status}, ${r.priority}, ${r.type})` +
          `${r.labels.length ? ` labels: ${r.labels.join(", ")};` : ""}` +
          ` code links: ${r.codeLinks}; data mappings: ${r.dataMappings}`,
      );
      const header =
        matched.length > shown.length
          ? `Showing ${shown.length} of ${matched.length} matching requirements.`
          : `${matched.length} matching requirement${matched.length === 1 ? "" : "s"}.`;
      return {
        text: `${header}${partial}\n${lines.join("\n")}`,
        data: { requirements: shown, total: matched.length, projectTotals: totals },
        resultCount: shown.length,
      };
    },
  };
}

function notFoundText(id: string): string {
  return `ERROR: No requirement with id ${id} in this project. Use list_requirements to find ids.`;
}

function lineRange(start: number | null, end: number | null): string {
  if (start === null) return "";
  return end !== null && end !== start ? `:${start}-${end}` : `:${start}`;
}

export function createGetRequirementTool(
  deps: RequirementToolsDeps = {},
): ToolDefinition<typeof getSchema> {
  return {
    name: GET_REQUIREMENT_TOOL_NAME,
    description:
      "Read one of this project's METIS requirements in full: body, review status, labels, " +
      "acceptance criteria, code links, data (table/column) mappings, and its requirement → " +
      "spec → code trace with the tests that cover it. Take the id from list_requirements.",
    schema: getSchema,
    risk: "low",
    async exec(args, ctx): Promise<ToolResult> {
      const projectId = ctx.projectId;
      if (!projectId) return UNSCOPED;
      const r = await pickPrisma(deps).requirement.findFirst({
        where: { id: args.requirementId, projectId, deletedAt: null },
        select: {
          id: true,
          title: true,
          body: true,
          type: true,
          priority: true,
          labels: true,
          reviewStatus: true,
          acceptanceCriteria: true,
          verdict: true,
          coverage: true,
          externalUrl: true,
          implementedByPr: true,
          dataMappings: {
            where: { deletedAt: null },
            select: {
              schemaName: true,
              tableName: true,
              columnName: true,
              dbConnector: { select: { label: true } },
            },
          },
        },
      });
      if (!r) {
        return {
          text: notFoundText(args.requirementId),
          isError: true,
        };
      }
      let chain: RequirementTraceabilityChain;
      try {
        chain = await (deps.chain ?? getRequirementChain)(projectId, r.id);
      } catch (err) {
        // Soft-deleted between the read above and the trace: same answer as not found.
        if ((err as { code?: string } | null)?.code === "REQUIREMENT_NOT_FOUND") {
          return { text: notFoundText(args.requirementId), isError: true };
        }
        throw err;
      }

      const status = resolveRequirementReviewStatus(
        r.reviewStatus,
        parseRequirementLabels(r.labels),
      );
      const labels = visibleRequirementLabels(r.labels);
      const criteria = parseAcceptanceCriteria(r.acceptanceCriteria);
      const out: string[] = [
        `# ${r.title} [${r.id}]`,
        `Status: ${status}; type: ${r.type}; priority: ${r.priority}` +
          (r.verdict ? `; verdict: ${r.verdict}` : "") +
          (r.coverage ? `; coverage: ${r.coverage}` : ""),
        `Labels: ${labels.length ? labels.join(", ") : "none"}`,
      ];
      if (r.implementedByPr !== null) out.push(`Implemented by PR #${r.implementedByPr}`);
      if (r.externalUrl) out.push(`Source: ${r.externalUrl}`);
      out.push("", r.body, "");
      out.push(
        criteria.length
          ? `Acceptance criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}`
          : "Acceptance criteria: none derived",
      );
      out.push(
        chain.directCode.length
          ? `Code links:\n${chain.directCode
              .map((c) => `- ${c.filePath}${lineRange(c.startLine, c.endLine)} (${c.source})`)
              .join("\n")}`
          : "Code links: none",
      );
      out.push(
        r.dataMappings.length
          ? `Data mappings:\n${r.dataMappings
              .map(
                (m) =>
                  `- ${m.dbConnector.label}: ${m.schemaName ? `${m.schemaName}.` : ""}${m.tableName}` +
                  (m.columnName ? `.${m.columnName}` : ""),
              )
              .join("\n")}`
          : "Data mappings: none",
      );
      if (chain.specs.length) {
        out.push(
          `Specs:\n${chain.specs
            .map(
              (s) =>
                `- ${s.specTitle ?? s.specDocumentId}` +
                (s.code.length
                  ? ` → ${s.code.map((c) => `${c.filePath}${lineRange(c.startLine, c.endLine)}`).join(", ")}`
                  : ""),
            )
            .join("\n")}`,
        );
      }
      if (chain.testedBy.length) {
        out.push(
          `Tested by:\n${chain.testedBy.map((t) => `- ${t.filePath} (${t.name})`).join("\n")}`,
        );
      }
      return {
        text: out.join("\n"),
        data: {
          id: r.id,
          title: r.title,
          body: r.body,
          status,
          type: r.type,
          priority: r.priority,
          labels,
          acceptanceCriteria: criteria,
          dataMappings: r.dataMappings,
          trace: chain,
        },
        resultCount: 1,
      };
    },
  };
}

/** Idempotent boot registration (`server.ts`). */
export function registerRequirementTools(
  registry: { register: (t: ToolDefinition) => void; unregister: (n: string) => boolean },
  deps: RequirementToolsDeps = {},
): void {
  registry.unregister(LIST_REQUIREMENTS_TOOL_NAME);
  registry.unregister(GET_REQUIREMENT_TOOL_NAME);
  registry.register(createListRequirementsTool(deps) as unknown as ToolDefinition);
  registry.register(createGetRequirementTool(deps) as unknown as ToolDefinition);
}
