/**
 * #1030 — chat's read-only view of the project's own requirements.
 *
 * Before this, chat had no tool that read METIS requirements: asked which
 * approved requirements touch the database, it searched the knowledge base
 * (which holds uploaded documents, not requirements), found nothing, and told
 * the analyst her requirements did not exist.
 *
 *   • `list_requirements` — the session project's requirements, filtered by
 *     review status, visible label and/or a query over title + body. Since
 *     #1841 a query is matched by MEANING as well as by words: candidates from
 *     the requirement index (#1835) are fused by reciprocal rank with the word
 *     matches, approved requirements first at equal relevance, so "let
 *     customers pay later" finds "Deferred settlement terms". Every word match
 *     the old path found is still found.
 *   • `get_requirement` — one requirement with its acceptance criteria, code
 *     links, data (table/column) mappings and requirement → spec → code trace.
 *
 * Security posture:
 *   - Project-scoped by the SERVER: every query filters on `ctx.projectId`
 *     (the session's bound project) as well as the id; the model never names a
 *     project. An unscoped session is refused before any read.
 *   - Read-only; risk `low` (no approval prompt, as `search-knowledge`).
 *   - Hidden `finding:*` / legacy `review:*` labels are never shown or matched.
 *   - Text filtering is done in memory, so no model text reaches a query. The
 *     meaning search embeds the query and reads only the session project's
 *     vector namespace; its hits are kept only when they are among the
 *     project's live, filtered rows read here.
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
import { reciprocalRankFusion } from "../rag/bm25-index.js";
import { createChildLogger } from "../logger.js";
import { findNearestRequirements } from "./requirement-embeddings.js";

const log = createChildLogger("requirements-chat-tools");

export const LIST_REQUIREMENTS_TOOL_NAME = "list_requirements";
export const GET_REQUIREMENT_TOOL_NAME = "get_requirement";

/** Rows read per listing — a ceiling on one project's scan, not a page size. */
const MAX_SCAN = 5000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** #1841 — meaning-based candidates fetched per query, before the filters. */
export const SEMANTIC_POOL = 50;
/**
 * #1841 — the cosine below which a meaning-based candidate is not relevant to
 * a question at all. A question scores lower against a requirement than two
 * requirements do against each other (#1836's 0.65 floor is for those), so this
 * floor is its own: measured by `eval:req-retrieval` (issue #1841).
 */
export const SEMANTIC_MIN_SCORE = 0.5;

/** One meaning-based candidate: a requirement id and its cosine to the query. */
export interface SemanticRequirementHit {
  requirementId: string;
  score: number;
}

export type SemanticRequirementSearch = (
  projectId: string,
  query: string,
  limit: number,
) => Promise<SemanticRequirementHit[]>;

export interface RequirementToolsDeps {
  prisma?: Pick<PrismaClient, "requirement">;
  /** The requirement → spec → code chain (`traceability-spine.ts`). */
  chain?: (projectId: string, requirementId: string) => Promise<RequirementTraceabilityChain>;
  /** #1841 — meaning-based search over the requirement index. Defaults to #1835's. */
  semantic?: SemanticRequirementSearch;
}

const defaultSemantic: SemanticRequirementSearch = (projectId, query, limit) =>
  findNearestRequirements(projectId, query, { limit });

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
    .describe(
      "What to look for, in the analyst's own words: requirements are matched by meaning and by " +
        "any word in the title or body, best match first, approved before draft at equal match",
    ),
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
  /** #1841 — with a query only: how it matched. */
  matchedBy?: "meaning" | "words" | "meaning and words";
}

/** The rows that passed the status and label filters, with their word hits. */
interface Eligible extends ListedRequirement {
  /** Query words found in the title or body: the word path's membership test since #1030. */
  termHits: number;
  /** #1841 — of those, the words that carry meaning ({@link isKeyTerm}): what ranks it. */
  keyHits: number;
}

/**
 * #1841 — words too short or too common to rank on. The word path still KEEPS
 * a requirement that matches only these (it always has: "a" is a substring of
 * nearly every body), but ranks it after every real match.
 */
const RANKING_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "what",
  "where",
  "when",
  "who",
  "how",
  "can",
  "are",
  "was",
  "has",
  "have",
  "our",
  "their",
  "they",
  "them",
  "any",
  "all",
  "not",
  "let",
  "get",
  "does",
  "there",
  "which",
  "into",
  "about",
]);

function isKeyTerm(term: string): boolean {
  return term.length >= 3 && !RANKING_STOP_WORDS.has(term);
}

const approvedFirst = (a: ListedRequirement, b: ListedRequirement): number =>
  Number(b.status === "approved") - Number(a.status === "approved");

/**
 * #1841 — rank a query's matches: meaning-based hits at or above
 * {@link SEMANTIC_MIN_SCORE} and word matches, each ordered best first with
 * approved ahead at an equal score, fused by reciprocal rank. Only `eligible`
 * rows (the project's live rows that passed the filters) can be returned.
 */
function rankQueryMatches(
  eligible: readonly Eligible[],
  semanticHits: readonly SemanticRequirementHit[],
): ListedRequirement[] {
  const byId = new Map(eligible.map((r) => [r.id, r]));
  const meaning = semanticHits
    .filter((h) => h.score >= SEMANTIC_MIN_SCORE && byId.has(h.requirementId))
    .map((h) => ({ row: byId.get(h.requirementId) as Eligible, score: h.score }))
    .sort((a, b) => b.score - a.score || approvedFirst(a.row, b.row))
    .map((h) => h.row);
  const words = eligible
    .filter((r) => r.keyHits > 0)
    .sort((a, b) => b.keyHits - a.keyHits || approvedFirst(a, b));
  const meaningIds = new Set(meaning.map((r) => r.id));
  const wordIds = new Set(eligible.filter((r) => r.termHits > 0).map((r) => r.id));
  const fused = reciprocalRankFusion([
    meaning.map((r) => ({ chunkId: r.id })),
    words.map((r) => ({ chunkId: r.id })),
  ])
    .map((f) => ({ row: byId.get(f.chunkId) as Eligible, score: f.score }))
    .sort((a, b) => b.score - a.score || approvedFirst(a.row, b.row))
    .map(({ row }) => row);
  const fusedIds = new Set(fused.map((r) => r.id));
  // Matched only through a short or common word: still listed, after every real match.
  const weak = eligible.filter((r) => r.termHits > 0 && !fusedIds.has(r.id)).sort(approvedFirst);
  return [...fused, ...weak].map((row) => {
    const { termHits: _termHits, keyHits: _keyHits, ...listed } = row;
    const both = meaningIds.has(row.id) && wordIds.has(row.id);
    return {
      ...listed,
      matchedBy: both ? "meaning and words" : meaningIds.has(row.id) ? "meaning" : "words",
    };
  });
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
      const eligible: Eligible[] = [];
      for (const r of rows) {
        const status = resolveRequirementReviewStatus(
          r.reviewStatus,
          parseRequirementLabels(r.labels),
        );
        totals[status] += 1;
        const labels = visibleRequirementLabels(r.labels);
        if (args.status && status !== args.status) continue;
        if (label && !labels.some((l) => l.toLowerCase() === label)) continue;
        const haystack = terms.length > 0 ? `${r.title}\n${r.body ?? ""}`.toLowerCase() : "";
        eligible.push({
          id: r.id,
          title: r.title,
          status,
          type: r.type,
          priority: r.priority,
          labels,
          codeLinks: r._count.codeMappings,
          dataMappings: r._count.dataMappings,
          termHits: terms.filter((t) => haystack.includes(t)).length,
          keyHits: terms.filter((t) => isKeyTerm(t) && haystack.includes(t)).length,
        });
      }

      let matched: ListedRequirement[];
      let unavailable = "";
      if (terms.length === 0 || args.query === undefined) {
        matched = eligible.map(({ termHits: _termHits, keyHits: _keyHits, ...listed }) => listed);
      } else {
        let semanticHits: SemanticRequirementHit[] = [];
        try {
          semanticHits = await (deps.semantic ?? defaultSemantic)(
            ctx.projectId,
            args.query,
            SEMANTIC_POOL,
          );
        } catch (err) {
          // Words still match: a missing embedder narrows the search, never fails it.
          log.warn("list_requirements: search by meaning failed; matching words only", {
            projectId: ctx.projectId,
            error: (err as Error).message,
          });
          unavailable = " Search by meaning was unavailable, so only words were matched.";
        }
        matched = rankQueryMatches(eligible, semanticHits);
      }

      const limit = args.limit ?? DEFAULT_LIMIT;
      const shown = matched.slice(0, limit);
      if (shown.length === 0) {
        const breakdown = REQUIREMENT_REVIEW_STATUSES.map((s) => `${s}: ${totals[s]}`).join(", ");
        return {
          text:
            `No requirement matched those filters. This project has ${rows.length} ` +
            `requirements in total (${breakdown}).${partial}${unavailable}`,
          data: { requirements: [], total: 0, projectTotals: totals },
          resultCount: 0,
        };
      }
      const lines = shown.map(
        (r) =>
          `- [${r.id}] ${r.title} (${r.status}, ${r.priority}, ${r.type})` +
          `${r.labels.length ? ` labels: ${r.labels.join(", ")};` : ""}` +
          ` code links: ${r.codeLinks}; data mappings: ${r.dataMappings}` +
          (r.matchedBy ? `; matched by ${r.matchedBy}` : ""),
      );
      const header =
        matched.length > shown.length
          ? `Showing ${shown.length} of ${matched.length} matching requirements.`
          : `${matched.length} matching requirement${matched.length === 1 ? "" : "s"}.`;
      return {
        text: `${header}${partial}${unavailable}\n${lines.join("\n")}`,
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
          `Tested by:\n${chain.testedBy
            .map(
              (t) =>
                `- ${t.filePath} (${t.name})` +
                // #1108 — a weak link must not read as coverage to the model.
                (t.relation === "entry-point"
                  ? " — only calls a shared entry point; not evidence this requirement is tested"
                  : ""),
            )
            .join("\n")}`,
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
