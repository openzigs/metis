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
import { formatStartedAt } from "../analysis/run-start-label.js";

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
 * two. Setext headings (`Title` over `===` / `---`, common in imported issue
 * bodies) are nested too, rewritten as ATX. Headings inside fenced code are
 * text, and are left alone; a thematic break and a table's delimiter row are
 * never read as an underline.
 *
 * Line endings are normalised first: a body imported from a tracker can carry
 * CRLF, and every pattern below anchors on `$`, which a trailing `\r` defeats.
 */
function nestBodyHeadings(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  // Index in `out` of the first line of the open paragraph, or null. Only a plain
  // paragraph can be a setext heading's text: not a list item or quote, which a
  // `---` under them ends with a thematic break.
  let paragraphStart: number | null = null;
  let inContainer = false;
  // Inside a list or quote across blank lines: an indented paragraph after one
  // may be the item's continuation, and rewriting it at column 0 would end the
  // list. Such a paragraph is left as it is (PR #1179, third panel).
  let inList = false;
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      // CommonMark: a closing fence is the same character, at least as long as
      // the opener, and carries no info string — ` ```js ` inside is content.
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closer && closer[1]![0] === fence[0] && closer[1]!.length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      fence = opener[1]!;
      paragraphStart = null;
      out.push(line);
      continue;
    }
    if (line.trim() === "") {
      paragraphStart = null;
      inContainer = false;
      out.push(line);
      continue;
    }
    const heading = /^( {0,3})(#{1,6})(?=[ \t]|$)/.exec(line);
    if (heading) {
      paragraphStart = null;
      // The indent is kept, so a heading inside a list item stays in it.
      out.push(
        heading[2]!.length >= BODY_MIN_HEADING_LEVEL
          ? line
          : heading[1]! + "#".repeat(BODY_MIN_HEADING_LEVEL) + line.slice(heading[0].length),
      );
      continue;
    }
    // A setext underline (`===` or `---`, nothing else on the line) under a plain
    // paragraph makes that paragraph a heading: rewrite it as an ATX H4.
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && paragraphStart !== null && !inContainer) {
      const text = out
        .splice(paragraphStart)
        .map((l) => l.trim())
        .join(" ");
      out.push(`${"#".repeat(BODY_MIN_HEADING_LEVEL)} ${text}`);
      paragraphStart = null;
      continue;
    }
    // Four columns of indent — four spaces, or a tab within the first four — is code.
    const indentedCode = /^(?: {0,3}\t| {4})/.test(line);
    const thematicBreak =
      !indentedCode && /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.replace(/[ \t]/g, ""));
    const containerStart =
      !indentedCode && /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|^ {0,3}>/.test(line);
    if (thematicBreak) {
      // Ends any paragraph; never part of a heading's text (CommonMark).
      paragraphStart = null;
      inContainer = false;
      inList = false;
    } else if (containerStart) {
      // A list item or quote interrupts the paragraph above it, and the text it
      // starts is inside the container, so no underline below can make it a heading.
      paragraphStart = out.length;
      inContainer = true;
      inList = true;
    } else if (paragraphStart === null && !indentedCode) {
      paragraphStart = out.length;
      // An indented paragraph after a list may continue an item; only an
      // unindented one is certainly top level.
      inList = inList && /^[ \t]/.test(line);
      inContainer = inList;
    }
    // A table row: a `---` under it is never read as this paragraph's underline.
    if (line.includes("|")) inContainer = true;
    out.push(line);
  }
  return out.join("\n");
}

/**
 * A requirement body as BRD content: METIS's internal markers removed first
 * (#1170 — escaped by {@link neutralizeHtml} they became visible
 * `<!-- metis:clarifications:start -->` text), its headings nested under the
 * requirement, then any other raw HTML neutralised.
 */
export function requirementBodyMarkdown(body: string): string {
  // Leading blank lines only, not `trim()`: the first line's indent is Markdown
  // (a tab-indented line is code), and dropping it can turn code into a heading.
  return neutralizeHtml(
    nestBodyHeadings(stripMetisMarkers(body))
      .replace(/^(?:[ \t]*\n)+/, "")
      .trimEnd(),
  );
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

/** What {@link renderRequirementEntry} shows besides the requirement's own text. */
export interface RequirementEntryOptions {
  /** #1218 — the stored requirement id, on the line under the heading. */
  showId?: boolean;
  /** The recorded code links (default true). A business reader's main part leaves them out. */
  codeLinks?: boolean;
}

/**
 * One requirement as BRD content, exactly as stored: its `### R<n>.` heading,
 * type, priority, review status and verdict, its body (markers removed,
 * headings nested), its acceptance criteria as written, and its code links.
 * Nothing is reworded. Returned as lines, without a leading blank line.
 */
export function renderRequirementEntry(
  r: ScopedRequirement,
  n: number,
  options: RequirementEntryOptions = {},
): string[] {
  const out: string[] = [
    `### R${n}. ${cell(r.title)}`,
    "",
    `${options.showId ? `**Requirement id:** ${codePath(r.id)} · ` : ""}**Type:** ${cell(
      r.type,
    )} · **Priority:** ${cell(r.priority)} · **Review status:** ${cell(
      r.reviewStatus ?? "draft",
    )} · **Verdict:** ${cell(r.verdict ?? "not assessed")}`,
    "",
    requirementBodyMarkdown(r.body) || "_No description recorded._",
    "",
    "#### Acceptance criteria",
    "",
  ];
  const criteria = parseAcceptanceCriteria(r.acceptanceCriteria);
  if (criteria.length) criteria.forEach((c) => out.push(`- ${cell(c)}`));
  else out.push("_No acceptance criteria were derived for this requirement._");
  if (options.codeLinks === false) return out;
  out.push("", "#### Code links", "");
  if (!r.codeMappings.length && !r.implementations.length) {
    out.push("_No code links recorded for this requirement._");
    return out;
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
  return out;
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
  requirements.forEach((r, i) => out.push("", ...renderRequirementEntry(r, i + 1)));
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
