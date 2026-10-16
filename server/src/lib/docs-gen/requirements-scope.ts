/**
 * #991 — the "requirements" docs-generation scope: a document (a BRD) built
 * from a chosen set of requirements — one analysis run, an explicit selection,
 * or the requirements under a formal review — and their recorded code links.
 *
 * Every statement in the document comes from a stored row: the requirement's
 * own title, body, priority, review status, verdict and acceptance criteria,
 * and the requirement→code mappings and merged-PR implementations recorded
 * against it. Nothing is written by a model, so nothing in it is ungrounded.
 *
 * Every read is filtered on `projectId` as well as the selector, so another
 * project's analysis, review or requirement id selects nothing.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseAcceptanceCriteria, stripMetisMarkers } from "@metis/shared";
import { prisma } from "../prisma.js";
import { formatStartedAt } from "../publishing/epic-title.js";

/** Upper bound on an explicit selection, so one request cannot name the whole table. */
export const MAX_SELECTED_REQUIREMENTS = 500;

/** The `scopeFilter` a requirements-scope document is generated from. */
export const requirementsScopeFilterSchema = z
  .object({
    analysisId: z.string().min(1).max(100).optional(),
    requirementIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(MAX_SELECTED_REQUIREMENTS)
      .optional(),
    reviewRequestId: z.string().min(1).max(100).optional(),
    /** Only requirements whose review status is `approved`. */
    approvedOnly: z.boolean().optional(),
  })
  .passthrough()
  .refine((f) => Boolean(f.analysisId || f.requirementIds || f.reviewRequestId), {
    message:
      "scopeFilter needs analysisId, requirementIds or reviewRequestId when scope is 'requirements'",
  });

export type RequirementsScopeFilter = z.infer<typeof requirementsScopeFilterSchema>;

/** Thrown when a requirements scope selects nothing in the project. */
export const REQUIREMENTS_SCOPE_EMPTY_CODE = "REQUIREMENTS_SCOPE_EMPTY";

/** The Prisma `where` for the requirements a filter selects, always within `projectId`. */
export function requirementsScopeWhere(projectId: string, filter: RequirementsScopeFilter) {
  return {
    projectId,
    deletedAt: null,
    ...(filter.analysisId ? { analysisId: filter.analysisId } : {}),
    ...(filter.requirementIds ? { id: { in: [...new Set(filter.requirementIds)] } } : {}),
    ...(filter.reviewRequestId
      ? {
          reviewItems: {
            some: { reviewRequestId: filter.reviewRequestId, reviewRequest: { projectId } },
          },
        }
      : {}),
    ...(filter.approvedOnly ? { reviewStatus: "approved" } : {}),
  };
}

/** How many requirements a filter selects in the project. */
export function countScopedRequirements(
  projectId: string,
  filter: RequirementsScopeFilter,
): Promise<number> {
  return prisma.requirement.count({ where: requirementsScopeWhere(projectId, filter) });
}

export interface ScopedRequirement {
  id: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  reviewStatus: string | null;
  verdict: string | null;
  acceptanceCriteria: string;
  version: number;
  updatedAt: Date;
  codeMappings: Array<{
    filePath: string;
    startLine: number | null;
    endLine: number | null;
    confidence: number;
    source: string;
  }>;
  implementations: Array<{
    prNumber: number;
    prUrl: string;
    filePath: string;
    startLine: number | null;
    endLine: number | null;
  }>;
}

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** The selected requirements with their code links, highest priority first. */
export async function loadScopedRequirements(
  projectId: string,
  filter: RequirementsScopeFilter,
): Promise<ScopedRequirement[]> {
  const rows = await prisma.requirement.findMany({
    where: requirementsScopeWhere(projectId, filter),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      body: true,
      type: true,
      priority: true,
      reviewStatus: true,
      verdict: true,
      acceptanceCriteria: true,
      version: true,
      updatedAt: true,
      codeMappings: {
        where: { projectId },
        orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
        select: { filePath: true, startLine: true, endLine: true, confidence: true, source: true },
      },
      implementations: {
        orderBy: [{ prNumber: "asc" }, { filePath: "asc" }],
        select: { prNumber: true, prUrl: true, filePath: true, startLine: true, endLine: true },
      },
    },
  });
  return [...rows].sort(
    (a, b) => (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4),
  );
}

/** Changes whenever a selected requirement or one of its code links does. */
export function requirementsSourceFingerprint(requirements: readonly ScopedRequirement[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        requirements.map((r) => [
          r.id,
          r.version,
          r.updatedAt.toISOString(),
          r.codeMappings,
          r.implementations,
        ]),
      ),
    )
    .digest("hex");
}

/**
 * Raw HTML in stored text is shown as text, never rendered: the PDF/HTML
 * exporter passes Markdown through `marked`, which keeps inline HTML, and a
 * requirement body can come from an external tracker. Code spans and fenced
 * blocks are left alone, since Markdown does not decode entities inside them.
 */
export function neutralizeHtml(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .split(/(`[^`\n]*`)/g)
            .map((piece, j) => (j % 2 === 1 ? piece : piece.replace(/</g, "&lt;")))
            .join(""),
    )
    .join("");
}

/**
 * One line of text safe inside a Markdown table cell or heading. Backslashes
 * are escaped first, so a stored `\|` cannot turn the added escape into a
 * literal backslash followed by a live column separator.
 */
function cell(value: string): string {
  return (
    value
      .replace(/\s+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      .replace(/</g, "&lt;")
      .trim() || "—"
  );
}

/** A repository path shown as inline code; backticks would break out of it. */
function codePath(path: string): string {
  return `\`${path.replace(/`/g, "'").replace(/\s+/g, " ")}\``;
}

function lineRange(start: number | null, end: number | null): string {
  if (start == null) return "";
  return end != null && end !== start ? `:${start}-${end}` : `:${start}`;
}

/** Only an http(s) URL becomes a link; anything else is shown as text. */
function prLink(prNumber: number, prUrl: string): string {
  return /^https?:\/\//i.test(prUrl) && !/[\s()<>]/.test(prUrl)
    ? `[PR #${prNumber}](${prUrl})`
    : `PR #${prNumber}`;
}

/**
 * #1170 — how the introduction names what the document covers. A reader cannot
 * use an internal id, so the run is named by its start time (as the publish epic
 * is, #1064) and a review by its title; neither id is ever printed.
 */
export interface RequirementsSourceNames {
  analysisStartedAt?: Date | null;
  reviewTitle?: string | null;
}

function runName(startedAt: Date | null | undefined): string {
  const when = formatStartedAt(startedAt);
  return when ? `the analysis run started ${when}` : "the selected analysis run";
}

function reviewName(title: string | null | undefined): string {
  return title?.trim() ? `review “${cell(title)}”` : "the selected review";
}

function selectionSummary(
  filter: RequirementsScopeFilter,
  count: number,
  names: RequirementsSourceNames,
): string {
  const sources: string[] = [];
  // #1129 — a selection within one run is a subset OF that run, not a second source.
  const chosenFromRun = Boolean(filter.analysisId && filter.requirementIds);
  if (filter.analysisId)
    sources.push(`${chosenFromRun ? "those chosen from " : ""}${runName(names.analysisStartedAt)}`);
  if (filter.reviewRequestId) sources.push(reviewName(names.reviewTitle));
  if (filter.requirementIds && !chosenFromRun)
    sources.push(`${filter.requirementIds.length} selected requirement(s)`);
  const approved = filter.approvedOnly ? ", approved requirements only" : "";
  return `This document covers ${count} requirement(s) from ${sources.join(" and ")}${approved}.`;
}

/** The shallowest heading a requirement body may use: below its own `### Rn.` title. */
const BODY_MIN_HEADING_LEVEL = 4;

/**
 * #1170 — a body's own headings, nested under the requirement's title. The
 * clarification pass writes `## Clarifications` into the body; copied as it was,
 * every requirement put an H2 beside the document's `## Requirements`, so the
 * Contents listed five "Clarifications" siblings and split each requirement in
 * two. Headings inside fenced code are text, and are left alone.
 */
function nestBodyHeadings(body: string): string {
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opener) {
        const mark = opener[1]!;
        if (fence === null) fence = mark;
        else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const heading = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
      if (!heading || heading[1]!.length >= BODY_MIN_HEADING_LEVEL) return line;
      return "#".repeat(BODY_MIN_HEADING_LEVEL) + line.slice(heading[0].length);
    })
    .join("\n");
}

/**
 * A requirement body as BRD content: METIS's internal markers removed first
 * (#1170 — escaped by {@link neutralizeHtml} they became visible
 * `<!-- metis:clarifications:start -->` text), its headings nested under the
 * requirement, then any other raw HTML neutralised.
 */
export function requirementBodyMarkdown(body: string): string {
  return neutralizeHtml(nestBodyHeadings(stripMetisMarkers(body)).trim());
}

/**
 * #1129 — the document's heading states how many requirements it covers, so a
 * BRD of five chosen requirements cannot be mistaken for one of the whole run.
 * A title that already names the count is left as it is.
 */
export function headingWithCount(title: string, count: number): string {
  const noun = count === 1 ? "requirement" : "requirements";
  // A fixed pattern (no regex built from data): every "<n> requirement(s)" the title names.
  const stated = [...title.matchAll(/(?<!\d)(\d+) requirements?\b/gi)].map((m) => Number(m[1]));
  if (stated.includes(count)) return title;
  return `${title} (${count} ${noun})`;
}

/** The Markdown document for a set of requirements. */
export function renderRequirementsDocument(
  title: string,
  filter: RequirementsScopeFilter,
  requirements: readonly ScopedRequirement[],
  names: RequirementsSourceNames = {},
): string {
  const linked = requirements.filter(
    (r) => r.codeMappings.length > 0 || r.implementations.length > 0,
  ).length;
  const out: string[] = [
    `# ${cell(headingWithCount(title, requirements.length))}`,
    "",
    selectionSummary(filter, requirements.length, names),
    `${linked} of ${requirements.length} have recorded code links.`,
    "",
    "## Summary",
    "",
    "| # | Requirement | Type | Priority | Review status | Verdict | Code links |",
    "|---|---|---|---|---|---|---|",
  ];
  requirements.forEach((r, i) => {
    out.push(
      `| R${i + 1} | ${cell(r.title)} | ${cell(r.type)} | ${cell(r.priority)} | ${cell(
        r.reviewStatus ?? "draft",
      )} | ${cell(r.verdict ?? "not assessed")} | ${r.codeMappings.length + r.implementations.length} |`,
    );
  });
  out.push("", "## Requirements");
  requirements.forEach((r, i) => {
    out.push(
      "",
      `### R${i + 1}. ${cell(r.title)}`,
      "",
      `**Type:** ${cell(r.type)} · **Priority:** ${cell(r.priority)} · **Review status:** ${cell(
        r.reviewStatus ?? "draft",
      )} · **Verdict:** ${cell(r.verdict ?? "not assessed")}`,
      "",
      requirementBodyMarkdown(r.body) || "_No description recorded._",
      "",
      "#### Acceptance criteria",
      "",
    );
    const criteria = parseAcceptanceCriteria(r.acceptanceCriteria);
    if (criteria.length) criteria.forEach((c) => out.push(`- ${cell(c)}`));
    else out.push("_No acceptance criteria were derived for this requirement._");
    out.push("", "#### Code links", "");
    if (!r.codeMappings.length && !r.implementations.length) {
      out.push("_No code links recorded for this requirement._");
      return;
    }
    for (const m of r.codeMappings) {
      out.push(
        `- ${codePath(m.filePath + lineRange(m.startLine, m.endLine))} — ${cell(
          m.source,
        )} mapping, confidence ${Math.round(m.confidence * 100)}%`,
      );
    }
    for (const impl of r.implementations) {
      out.push(
        `- ${codePath(impl.filePath + lineRange(impl.startLine, impl.endLine))} — implemented in ${prLink(
          impl.prNumber,
          impl.prUrl,
        )}`,
      );
    }
  });
  return `${out.join("\n")}\n`;
}

/** The start time and review title the introduction names, read within the project. */
async function loadSourceNames(
  projectId: string,
  filter: RequirementsScopeFilter,
): Promise<RequirementsSourceNames> {
  const [analysis, review] = await Promise.all([
    filter.analysisId
      ? prisma.analysis.findFirst({
          where: { id: filter.analysisId, projectId },
          select: { startedAt: true },
        })
      : null,
    filter.reviewRequestId
      ? prisma.reviewRequest.findFirst({
          where: { id: filter.reviewRequestId, projectId },
          select: { title: true },
        })
      : null,
  ]);
  return { analysisStartedAt: analysis?.startedAt ?? null, reviewTitle: review?.title ?? null };
}

/** Load, render and fingerprint the requirements a document is scoped to. */
export async function synthesizeRequirementsDocument(
  projectId: string,
  filter: RequirementsScopeFilter,
  title: string,
): Promise<{ markdown: string; sourceFingerprint: string; requirementCount: number }> {
  const requirements = await loadScopedRequirements(projectId, filter);
  if (requirements.length === 0) {
    throw new Error("No requirements match this document's scope");
  }
  return {
    markdown: renderRequirementsDocument(
      title,
      filter,
      requirements,
      await loadSourceNames(projectId, filter),
    ),
    sourceFingerprint: requirementsSourceFingerprint(requirements),
    requirementCount: requirements.length,
  };
}
