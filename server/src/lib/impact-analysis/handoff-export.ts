/**
 * Issue #2595 — the business analyst's hand-off: a change request and its
 * impact analysis as ONE readable document, exported as Word or PDF through the
 * generated-docs pipeline (`docs-gen/exporters.ts`, `exportDocument`).
 *
 * The markdown export of an impact run (`serializeImpactAnalysisMarkdown`) is
 * the full record. This is the document a BA sends on: the summary, each
 * requirement with the source passage it rests on, the files to edit with their
 * code citations, the clarifications answered, the risks, and what could not be
 * verified. Raw symbol lists (the blast radius, the covering tests) are counted
 * and left on the impact analysis page, and every list is capped, so the
 * document stays a readable length however large the run.
 *
 * Read side only: persisted rows, no model call. Every string from a person, a
 * document or a model is kept on its own line or quote, with raw HTML shown as
 * text (`neutralizeHtml`), because the PDF path renders this markdown as HTML.
 */
import {
  IMPACT_TIER_LABEL,
  impactCountLabel,
  impactDatabaseNotCheckedLabel,
  impactMatchCaveat,
  impactReachLabel,
  impactRunHeadline,
  impactRepoCount,
  impactSymbolRole,
  impactSymbolTier,
  impactTableTier,
  type DdlRiskClass,
  type ImpactAnalysisDetail,
  type ImpactItemView,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { getStructuredRequirements } from "../analysis/analysis-service.js";
import { changeRequestRef, loadChangeRequestSource } from "../analysis/change-request-source.js";
import {
  clarificationBlockEntries,
  stripClarificationBlock,
} from "../analysis/clarification-enrichment.js";
import { seesRunAsWhole, type SourceReader } from "../analysis/source-redaction.js";
import type { ClarificationState, StructuredRequirements } from "../analysis/types/requirements.js";
import { neutralizeHtml, requirementBodyMarkdown } from "../docs-gen/requirements-scope.js";
import { pairedInRun } from "../analysis/promotion-pairing.js";

// ── Input ───────────────────────────────────────────────────────────────────

/** A paragraph of the source document a requirement rests on. */
export interface HandoffSourcePassage {
  filename?: string;
  headingPath: string[];
  quote: string;
}

/** A question asked during clarification, and the answer recorded for it. */
export interface HandoffClarification {
  /** What the question is about: a requirement's title. */
  subject: string;
  question: string;
  answer: string;
}

/** One requirement of the change request, as the hand-off states it. */
export interface HandoffRequirement {
  title: string;
  /** The stored body, its generated clarifications block still in it. */
  body: string;
  approved: boolean;
  /** `implemented` | `partial` | `gap-confirmed` | `could-not-verify`, or null. */
  verdict: string | null;
  passages: HandoffSourcePassage[];
}

/** The change request an impact run was started from, as its reader may see it. */
export interface HandoffChangeRequest {
  title: string;
  requirements: HandoffRequirement[];
  /** #2447 — requirements left out because they rest on a source the reader cannot see. */
  restrictedLeftOut: number;
  /** The reader cannot see the run as a whole, so no source passage is shown. */
  passagesWithheld: boolean;
}

export interface HandoffInput {
  detail: ImpactAnalysisDetail;
  projectNames: Record<string, string>;
  changeRequest: HandoffChangeRequest | null;
  /** Answers given in the impact run's own clarification dialog (#2270). */
  impactClarifications: HandoffClarification[];
  /**
   * When the change request was read (ISO). It is read live, while the impact
   * run is stored, so the document says the two halves may differ in time.
   */
  readAt?: string;
}

/** The two documents the hand-off is exported as. */
export type HandoffFormat = "docx" | "pdf";

// ── Limits: what keeps the document a readable length ─────────────────────────

/** Characters of a requirement body, a summary or an answer shown. */
export const HANDOFF_MAX_TEXT = 1200;
/** Characters of one quoted source passage. */
export const HANDOFF_MAX_QUOTE = 600;
/** Source passages quoted per requirement. */
export const HANDOFF_MAX_PASSAGES = 2;
/** Files to edit listed per requirement change. */
export const HANDOFF_MAX_FILES = 10;
/** Tables named per requirement change. */
export const HANDOFF_MAX_TABLES = 10;
/** Entries in each of the Risks and Open items lists. */
export const HANDOFF_MAX_LIST = 25;

// ── Text helpers ────────────────────────────────────────────────────────────

/** Cut `text` to `max` characters, saying so. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}… (shortened)` : text;
}

/**
 * `text` with a code fence it leaves open closed by a matching fence: the same
 * character and at least the opener's length (CommonMark), so a clip cannot
 * leave a fence open to swallow every section after it.
 */
export function closeOpenFence(text: string): string {
  let open: { char: string; len: number } | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const run = m[1] ?? "";
    const rest = m[2] ?? "";
    if (!open) {
      // A backtick fence's info string cannot hold a backtick: such a line opens nothing.
      if (run[0] === "`" && rest.includes("`")) continue;
      open = { char: run.charAt(0), len: run.length };
    } else if (run[0] === open.char && run.length >= open.len && rest.trim() === "") {
      open = null;
    }
  }
  return open ? `${text}\n${open.char.repeat(open.len)}` : text;
}

/**
 * The text helpers of one format. The PDF is rendered from HTML, so raw HTML in
 * a person's, a document's or a model's text is shown as text there
 * (`neutralizeHtml`). Word gets the text as written: its builder puts each run
 * into the XML as text, escaped by the library, so `&lt;` would print as it stands.
 */
function textHelpers(format: HandoffFormat) {
  const asText = format === "pdf" ? neutralizeHtml : (md: string) => md;

  /** One line of text: whitespace collapsed (it cannot open a heading or list), HTML shown as text. */
  function inline(value: string, max = HANDOFF_MAX_TEXT): string {
    return asText(clip(value.replace(/\s+/g, " ").trim(), max));
  }

  /**
   * Multi-line text (a requirement body, a summary) as markdown: clipped, its
   * headings nested below the document's own (H4 and down) and raw HTML shown
   * as text (`requirementBodyMarkdown`), and a code fence the clip left open
   * closed, so it cannot swallow the sections after it.
   */
  function block(value: string, max = HANDOFF_MAX_TEXT): string {
    return closeOpenFence(requirementBodyMarkdown(clip(value, max), asText));
  }

  /** A quoted passage, on one line, so nothing in it can restructure the document. */
  function quote(value: string, max = HANDOFF_MAX_QUOTE): string {
    return `> ${inline(value, max)}`;
  }

  return { inline, block, quote };
}

type TextHelpers = ReturnType<typeof textHelpers>;

/** A path or symbol as inline code: no backtick or line break can leave the span. */
function code(value: string): string {
  return `\`${value.replace(/[`\r\n]+/g, " ").trim()}\``;
}

/**
 * A symbol's name without the file path it repeats (`a.go::T::f` in `a.go` is
 * `T::f`); empty for a symbol that is the whole file.
 */
function symbolName(filePath: string, qualifiedName: string): string {
  if (qualifiedName === filePath) return "";
  const prefix = `${filePath}::`;
  return qualifiedName.startsWith(prefix) ? qualifiedName.slice(prefix.length) : qualifiedName;
}

/** At most `max` entries, and a line counting the rest. */
function capped(lines: string[], max: number, rest: (n: number) => string): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `- *${rest(lines.length - max)}*`];
}

const VERDICT_LABEL: Record<string, string> = {
  implemented: "Covered by the code",
  partial: "Partly covered by the code",
  "gap-confirmed": "Nothing in the code covers it",
  "could-not-verify": "Could not verify",
};

const NOT_CHECKED_REASON: Record<string, string> = {
  restricted: "no access",
  deleted: "project deleted",
  "no-index": "no code index",
  timeout: "timed out",
  budget: "cost limit reached",
};

const RISK_WORDS: Record<DdlRiskClass, string> = {
  breaking: "Breaking schema change",
  expanding: "Expanding schema change",
  neutral: "Neutral schema change",
};

/** The heading of one requirement change: its own title, else a numbered one. */
function itemLabel(item: ImpactItemView, index: number, total: number): string {
  return (
    item.requirementTitle?.trim() || item.requirementId || `Requirement change ${index} of ${total}`
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

function summarySection(input: HandoffInput, t: TextHelpers): string[] {
  const { inline, block } = t;
  const { detail, changeRequest } = input;
  const lines = ["## Summary"];
  const summary = detail.summary?.trim();
  lines.push(
    summary ? block(summary, HANDOFF_MAX_TEXT * 2) : "*No summary was written for this run.*",
  );
  // #2593 — the requirements and files to edit lead, counted as the page and
  // the markdown export count them; the symbol count is the reach to review.
  const headline = impactRunHeadline(detail.items);
  const facts = [
    `${impactCountLabel(detail.projectIds.length, "project")} checked`,
    `${impactCountLabel(headline.requirementCount, "requirement")} with code impact`,
    `${impactCountLabel(headline.editFileCount, "file")} to edit`,
    impactReachLabel(detail.totalImpactedSymbols),
  ];
  if (changeRequest) {
    const approved = changeRequest.requirements.filter((r) => r.approved).length;
    facts.unshift(
      `${changeRequest.requirements.length} requirement(s) in the change request, ${approved} approved`,
    );
  }
  lines.push(facts.map((f) => `- ${f}`).join("\n"));
  if (detail.status === "failed" && detail.errorMessage) {
    lines.push(`**This run failed:** ${inline(detail.errorMessage)}`);
  }
  return lines;
}

/** The quote, then where it is: the document and the section it sits under. */
function passageLines(p: HandoffSourcePassage, t: TextHelpers): string[] {
  const { inline, quote } = t;
  const where = [p.filename, p.headingPath.at(-1)].filter((s): s is string => Boolean(s?.trim()));
  return [
    quote(p.quote),
    `*Source passage${where.length > 0 ? `: ${inline(where.join(", "), 200)}` : ""}*`,
  ];
}

function requirementsSection(input: HandoffInput, t: TextHelpers): string[] {
  const { inline, block, quote } = t;
  const { changeRequest, detail } = input;
  if (!changeRequest) {
    // A run started from pasted text or a document: state what was analysed.
    const text = detail.sourceText?.trim();
    if (!text) return [];
    return ["## Requirement analysed", quote(text, HANDOFF_MAX_QUOTE * 3)];
  }
  const lines = ["## Requirements"];
  if (changeRequest.requirements.length === 0) {
    lines.push("*No draft or approved requirement is in this change request.*");
  }
  changeRequest.requirements.forEach((r, i) => {
    lines.push(`### ${i + 1}. ${inline(r.title, 200)}`);
    const status = [r.approved ? "Approved" : "Not yet approved"];
    if (r.verdict) status.push(VERDICT_LABEL[r.verdict] ?? inline(r.verdict, 60));
    lines.push(`*${status.join(" · ")}*`);
    const body = block(stripClarificationBlock(r.body));
    if (body.trim()) lines.push(body);
    if (!changeRequest.passagesWithheld) {
      if (r.passages.length === 0) lines.push("*No source passage was recorded.*");
      for (const p of r.passages.slice(0, HANDOFF_MAX_PASSAGES)) lines.push(...passageLines(p, t));
    }
  });
  if (changeRequest.passagesWithheld) {
    lines.push(
      "*Source passages are not shown: this change request rests on a source you cannot see.*",
    );
  }
  return lines;
}

function affectedCodeSection(input: HandoffInput, t: TextHelpers): string[] {
  const { inline, block } = t;
  const { detail, projectNames } = input;
  const lines = ["## Affected files and code citations"];
  if (detail.items.length === 0) {
    lines.push("*No code impact was detected for this change request.*");
    return lines;
  }
  const multiProject = detail.projectIds.length > 1;
  // #2593 — the projects whose database the run did not read, and why.
  const notChecked = new Map(
    (detail.projectOutcomes ?? [])
      .filter((o) => o.databaseConnected === false)
      .map((o) => [o.projectId, o.databaseNotCheckedReason] as const),
  );
  detail.items.forEach((item, i) => {
    const project = multiProject
      ? ` (${inline(projectNames[item.projectId] ?? item.projectId, 120)})`
      : "";
    lines.push(`### ${inline(itemLabel(item, i + 1, detail.items.length), 200)}${project}`);
    lines.push(
      `*${inline(item.changeType, 40)} · severity ${inline(item.severity, 20)} · ` +
        `${item.affectedFileCount} file(s), ${item.affectedSymbolCount} symbol(s)*`,
    );
    // #2593 — the low-confidence caveat in the page's and the export's words.
    const caveat = impactMatchCaveat(item);
    if (caveat) lines.push(`> **${caveat}**`);
    if (item.summary?.trim()) lines.push(block(item.summary));

    const edits = item.affectedSymbols.filter((s) => impactSymbolRole(s) === "edit-candidate");
    if (edits.length > 0) {
      // #1965 — a repository is named only when the change spans more than one.
      const withRepo = impactRepoCount(item.affectedSymbols) > 1;
      const bullets = edits.map((s) => {
        const loc =
          s.startLine != null
            ? `${s.filePath}:${s.startLine}${s.endLine != null ? `-${s.endLine}` : ""}`
            : s.filePath;
        const repo = withRepo && s.repo ? ` in ${inline(s.repo.name, 120)}` : "";
        const symbol = symbolName(s.filePath, s.qualifiedName);
        return `- ${code(loc)}${repo}${symbol ? ` · ${code(symbol)}` : ""} · ${
          IMPACT_TIER_LABEL[impactSymbolTier(s)]
        }`;
      });
      lines.push(
        "**Files to edit**",
        capped(
          bullets,
          HANDOFF_MAX_FILES,
          (n) => `…and ${n} more on the impact analysis page.`,
        ).join("\n"),
      );
    }

    const tables = [...new Set(item.affectedTables.map((t) => t.tableName))];
    if (tables.length > 0) {
      const shown = tables.slice(0, HANDOFF_MAX_TABLES).map(code).join(", ");
      const more =
        tables.length > HANDOFF_MAX_TABLES ? ` and ${tables.length - HANDOFF_MAX_TABLES} more` : "";
      lines.push(`**Tables:** ${shown}${more}`);
    } else if (notChecked.has(item.projectId) && item.affectedTablesSecondary.length === 0) {
      // #2593 — "no tables" is not "no database change" when the database was never read.
      lines.push(`*${impactDatabaseNotCheckedLabel(notChecked.get(item.projectId))}.*`);
    }

    const radius = item.affectedSymbols.length - edits.length;
    const listedElsewhere = [
      radius > 0 ? `${radius} further symbol(s) in the blast radius` : null,
      item.affectedTests.length > 0 ? `${item.affectedTests.length} covering test(s)` : null,
    ].filter((s): s is string => s !== null);
    if (listedElsewhere.length > 0) {
      lines.push(`*${listedElsewhere.join(" and ")}: listed on the impact analysis page.*`);
    }
  });
  return lines;
}

function clarificationsSection(input: HandoffInput, t: TextHelpers): string[] {
  const { inline } = t;
  const fromRequirements: HandoffClarification[] = (
    input.changeRequest?.requirements ?? []
  ).flatMap((r) =>
    clarificationBlockEntries(r.body).map((e) => ({
      subject: r.title,
      question: e.question,
      answer: e.answer,
    })),
  );
  const all = [...fromRequirements, ...input.impactClarifications];
  const lines = ["## Clarifications answered"];
  if (all.length === 0) {
    lines.push("*No clarifying question has been answered.*");
    return lines;
  }
  const entries = all.map(
    (c) => `- **${inline(c.question, 400)}** (${inline(c.subject, 120)})\n  - ${inline(c.answer)}`,
  );
  lines.push(capped(entries, HANDOFF_MAX_LIST, (n) => `…and ${n} more answered.`).join("\n"));
  return lines;
}

function risksSection(input: HandoffInput, t: TextHelpers): string[] {
  const { inline } = t;
  const { detail } = input;
  const risks: string[] = [];
  detail.items.forEach((item, i) => {
    const label = inline(itemLabel(item, i + 1, detail.items.length), 200);
    if (item.severity === "critical" || item.severity === "high") {
      risks.push(`- **${label}**: severity ${item.severity}.`);
    }
    for (const t of [...item.affectedTables, ...item.affectedTablesSecondary]) {
      if (t.riskClass !== "breaking") continue;
      const name = t.columnName ? `${t.tableName}.${t.columnName}` : t.tableName;
      risks.push(`- ${RISK_WORDS.breaking}: ${code(name)} (${label}).`);
    }
    for (const gap of item.writePathGaps) {
      const untested = gap.writingSymbols.map(code).join(", ");
      risks.push(
        `- No test covers the write path to ${code(gap.tableName)}` +
          `${untested ? `, written by ${untested}` : ""} (${label}).`,
      );
    }
  });
  const lines = ["## Risks"];
  if (risks.length === 0) {
    lines.push(
      "*No high-severity change, breaking schema change or untested write path was found.*",
    );
    return lines;
  }
  lines.push(
    capped(risks, HANDOFF_MAX_LIST, (n) => `…and ${n} more on the impact analysis page.`).join(
      "\n",
    ),
  );
  return lines;
}

function openItemsSection(input: HandoffInput, t: TextHelpers): string[] {
  const { inline } = t;
  const { detail, changeRequest, projectNames } = input;
  const open: string[] = [];
  for (const r of changeRequest?.requirements ?? []) {
    if (r.verdict === "could-not-verify") {
      open.push(
        `- Requirement **${inline(r.title, 200)}**: the code could neither confirm nor rule it out.`,
      );
    }
  }
  if (changeRequest && changeRequest.restrictedLeftOut > 0) {
    const n = changeRequest.restrictedLeftOut;
    open.push(
      `- ${n === 1 ? "1 requirement is" : `${n} requirements are`} left out: ` +
        "they rest on a source you cannot see.",
    );
  }
  for (const o of detail.projectOutcomes) {
    if (o.outcome !== "not-checked" && o.outcome !== "error") continue;
    const name = inline(projectNames[o.projectId] ?? o.projectId, 120);
    const why =
      o.outcome === "error"
        ? "the check failed"
        : `not checked${o.reason && NOT_CHECKED_REASON[o.reason] ? ` (${NOT_CHECKED_REASON[o.reason]})` : ""}`;
    open.push(`- Project **${name}**: ${why}.`);
  }
  detail.items.forEach((item, i) => {
    const label = inline(itemLabel(item, i + 1, detail.items.length), 200);
    for (const t of item.affectedTables) {
      if (impactTableTier(t) !== "needs-review") continue;
      const name = t.columnName ? `${t.tableName}.${t.columnName}` : t.tableName;
      open.push(`- ${code(name)} is not in the live schema (${label}).`);
    }
    for (const p of item.uncheckedColumnProposals ?? []) {
      open.push(
        `- Proposed column ${code(`${p.tableName}.${p.columnName}`)} was not checked: ` +
          `${inline(p.reason, 300)} (${label}).`,
      );
    }
    const unresolved = item.affectedSymbols.filter(
      (s) => impactSymbolTier(s) === "needs-review",
    ).length;
    if (unresolved > 0) {
      open.push(
        `- ${unresolved} affected symbol(s) could not be matched to the code index (${label}).`,
      );
    }
  });
  const lines = ["## Open items: could not verify"];
  if (open.length === 0) {
    lines.push("*Nothing is left unverified.*");
    return lines;
  }
  lines.push(
    capped(open, HANDOFF_MAX_LIST, (n) => `…and ${n} more on the impact analysis page.`).join("\n"),
  );
  return lines;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** The document's title: the change request's name, else the run's. */
export function handoffTitle(input: Pick<HandoffInput, "detail" | "changeRequest">): string {
  const name = input.changeRequest?.title.trim();
  return name ? `${name} - impact hand-off` : `Impact analysis ${input.detail.id} - hand-off`;
}

/**
 * The hand-off document as markdown, for `exportDocument(…, "docx" | "pdf")`.
 * Deterministic: the same rows (and `readAt`) give the same document.
 *
 * Word already writes the title on its cover page, above a table of contents,
 * so the document's own H1 is written for the PDF only.
 */
export function serializeHandoffMarkdown(input: HandoffInput, format: HandoffFormat): string {
  const { detail, changeRequest, readAt } = input;
  const t = textHelpers(format);
  const date = (detail.completedAt ?? detail.startedAt).slice(0, 10);
  const asOf =
    changeRequest && readAt
      ? [
          `*As of: the change request is shown as it reads on ${readAt.slice(0, 10)}; ` +
            `the impact analysis is the run of ${date}. A requirement added, edited or ` +
            "re-checked since that run may differ from what the run analysed.*",
        ]
      : [];
  const blocks = [
    ...(format === "pdf" ? [`# ${t.inline(handoffTitle(input), 240)}`] : []),
    `*Change request and impact analysis · run ${t.inline(detail.status, 20)} · ${date}*`,
    ...asOf,
    ...summarySection(input, t),
    ...requirementsSection(input, t),
    ...affectedCodeSection(input, t),
    ...clarificationsSection(input, t),
    ...risksSection(input, t),
    ...openItemsSection(input, t),
  ];
  return blocks.join("\n\n") + "\n";
}

/**
 * The answered questions of a clarification dialog, each labelled with the
 * requirement it is about (its title, else its id).
 */
export function answeredClarifications(
  state: ClarificationState | null | undefined,
  requirements: StructuredRequirements | null | undefined,
): HandoffClarification[] {
  if (!state) return [];
  const titleById = new Map((requirements?.requirements ?? []).map((r) => [r.id, r.title]));
  const out: HandoffClarification[] = [];
  for (const round of state.rounds) {
    const recorded = new Map(round.answers.map((a) => [a.questionId, a.answer]));
    for (const q of round.questions) {
      const answer = (q.answer ?? recorded.get(q.id) ?? "").trim();
      if (!answer) continue;
      out.push({
        subject: titleById.get(q.requirementId) ?? q.requirementId,
        question: q.question,
        answer,
      });
    }
  }
  return out;
}

/**
 * The change request impact run `detail` was started from, as `reader` may see
 * it, or null when there is none or it is gone. Read only within the run's
 * projects, which the caller has already been allowed to read; requirements
 * resting on a source the reader cannot see are left out and counted (#2447),
 * and source passages are shown only to a reader who can see the run whole.
 */
export async function loadHandoffChangeRequest(
  detail: ImpactAnalysisDetail,
  reader: SourceReader,
): Promise<HandoffChangeRequest | null> {
  const ref = await changeRequestRef(detail.sourceAnalysisId, detail.projectIds, reader);
  if (!ref) return null;
  const source = await loadChangeRequestSource(
    ref.id,
    async (pid) => detail.projectIds.includes(pid),
    reader,
  );
  const ids = source.requirements.map((r) => r.id);
  const rows =
    ids.length > 0
      ? await prisma.requirement.findMany({
          // Scoped on the run and its project as well as the ids (OWASP A01).
          where: { id: { in: ids }, analysisId: source.id, projectId: source.projectId },
          select: {
            id: true,
            verdict: true,
            promotedStructuredId: true,
            promotedStructuredRunId: true,
          },
        })
      : [];
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const whole = await seesRunAsWhole(reader, source.id);
  const structured = whole ? await getStructuredRequirements(source.id) : null;
  const structuredById = new Map((structured?.requirements ?? []).map((s) => [s.id, s]));

  return {
    title: source.title,
    restrictedLeftOut: source.restrictedLeftOut,
    passagesWithheld: !whole,
    requirements: source.requirements.map((r) => {
      const row = rowById.get(r.id);
      // #1202 — the pairing promotion recorded, and only within the same
      // extraction run: every run numbers its list from REQ-001.
      const paired =
        row && pairedInRun(row, structured?.runId)
          ? structuredById.get(row.promotedStructuredId ?? "")
          : undefined;
      const passages: HandoffSourcePassage[] =
        paired?.sources && paired.sources.length > 0
          ? paired.sources.map((s) => ({
              ...(s.filename ? { filename: s.filename } : {}),
              headingPath: s.headingPath,
              quote: s.quote,
            }))
          : paired?.rawSource?.trim()
            ? [{ headingPath: [], quote: paired.rawSource }]
            : [];
      return {
        title: r.title,
        body: r.body,
        approved: r.approved,
        verdict: row?.verdict ?? null,
        passages,
      };
    }),
  };
}
