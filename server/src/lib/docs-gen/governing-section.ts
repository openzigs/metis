/**
 * #1877 (epic #1866) — the governing-rules section of a requirements BRD
 * (`requirements-scope.ts`, #991): for the analysis runs the document's
 * requirements came from, the cited governing findings METIS stored (#1874),
 * each with its status, the rule's control id, the clause excerpt verified
 * against the cited revision, the revision label, and the analyst's decision.
 * A rejected finding is listed and marked rejected, never dropped.
 *
 * BUILT FROM THE STORED ROWS, NOT BY ASKING A MODEL AGAIN. The findings are
 * read with `listGoverningFindings`, the read the analysis route
 * (`GET …/analyses/:id/governing-findings`) serves, so the BRD and the
 * analysis view show the same statuses for the same analysis.
 *
 * WORDING. An LLM rule check is not an audit (#1875): every stored text the
 * section shows (the model's reasoning and question, the analyst's note, the
 * requirement and document titles, the clause excerpt) passes through
 * `neutraliseComplianceClaims`, each document's summary is
 * `governingSummarySentence`, and the assembled section is neutralised once
 * more as a backstop. An excerpt whose wording was changed says so, since it
 * is then no longer the clause verbatim.
 *
 * FINDINGS ARE PER ANALYSED REQUIREMENT. A finding is recorded against a
 * requirement as the run analysed it (`REQ-001`, the code agent's id), before
 * synthesis wrote the stored requirements the document lists, and the two are
 * not joined by id. (`promotedStructuredId`, #1202, is no join either: it is the
 * structured extractor's id, which renumbers from a model's re-read.) A document
 * that covers every live requirement of a run lists every finding of the run.
 * One that covers only some (#2042: a selection, a review, approved only) lists
 * the findings on the analysed requirements its own requirements draw their
 * evidence from — each stored requirement's `finding:<id>` labels name the
 * analysis findings it was written from, and each of those records the analysed
 * requirement it was produced for — and says how many it left out.
 *
 * SUMMARY. One `governingSummarySentence` per cited revision, counted as the
 * analysis view counts it (`governingSummarySentences` in the UI's findings
 * panel, #1876): N the distinct rules with a finding, M the revision's rule
 * count from `governingFindingRevisions` (the route's), gaps the Gap
 * findings, and the distinct rules still waiting on BA input.
 *
 * TENANCY. The runs, their live requirements and the evidence findings are read
 * with the project id as well as their ids, so another project's run or
 * finding is never read, and an evidence finding counts only for the run its
 * requirement came from. Governing findings, decider names and rule counts are
 * then read through the findings store, by the run's id and the revisions its
 * own rows cite, exactly as the analysis route reads them.
 */
import {
  GOVERNING_PREVIEW,
  GOVERNING_PREVIEW_LABEL,
  GOVERNING_PREVIEW_NOTE,
  governingStaleNote,
  governingSummarySentence,
  neutraliseComplianceClaims,
  type GoverningFinding,
  type GoverningFindingDecision,
  type GoverningFindingStatus,
} from "@metis/shared";
import { parseRequirementLabels } from "../analysis/requirement-labels.js";
import { formatStartedAt } from "../analysis/run-start-label.js";
import { readGoverningApplicability } from "../governing/applicability-store.js";
import {
  governingFindingRevisions,
  listGoverningFindings,
  type GoverningFindingRevision,
} from "../governing/findings-store.js";
import {
  evidenceRequirementId,
  recheckedRequirementTitles,
  storedRequirementStates,
  withGoverningStaleness,
} from "../governing/requirement-staleness.js";
import { prisma } from "../prisma.js";
import { cell } from "./markdown-cell.js";

/** The section's H2 heading. */
export const GOVERNING_SECTION_HEADING = "## Governing rules";

/** One analysis run's findings, as the section renders them. */
export interface GoverningSectionRun {
  analysisId: string;
  startedAt: Date | null;
  /** In `listGoverningFindings` order: requirement, then control id. */
  findings: readonly GoverningFinding[];
  /** The analysed requirement's text, by its id in the run (`REQ-001`). */
  requirementText: ReadonlyMap<string, string>;
  /**
   * #2222 — the title of each stored requirement re-checked on its own wording,
   * by the id its findings are keyed by.
   */
  requirementTitles?: ReadonlyMap<string, string>;
  /** Each cited revision with its rule count (`governingFindingRevisions`). */
  revisions: readonly GoverningFindingRevision[];
  /**
   * #2042 — how many of the run's findings are not listed: they are on analysed
   * requirements none of the document's requirements draws evidence from. 0
   * when the document covers every live requirement of the run.
   */
  omitted: number;
}

/** What the section needs of each requirement in the document. */
export interface GoverningScopeRequirement {
  id: string;
  analysisId: string;
  /** The stored `labels` JSON; its `finding:<id>` entries are the requirement's evidence. */
  labels: string;
}

/** The runs with at least one finding, oldest first. */
export interface GoverningSection {
  runs: readonly GoverningSectionRun[];
}

/** The status labels the analysis view uses (#1874). */
export const GOVERNING_STATUS_LABELS: Readonly<Record<GoverningFindingStatus, string>> = {
  compliant: "Compliant",
  gap: "Gap",
  "needs-ba-input": "Needs BA input",
};

const DECISION_LABELS: Readonly<Record<GoverningFindingDecision, string>> = {
  accepted: "Accepted",
  rejected: "Rejected",
};

function decisionLabel(f: GoverningFinding): string {
  return f.decision ? DECISION_LABELS[f.decision] : "Not decided";
}

/** Stored text, claims neutralised, as one Markdown-safe line. */
function text(value: string): string {
  return cell(neutraliseComplianceClaims(value));
}

/**
 * #2042 — per run, the analysed requirement ids the document covers, or `"all"`
 * when it holds every live requirement of the run. A run covered in part maps
 * to the analysed ids its requirements' evidence findings were produced for.
 */
async function coveredAnalysedRequirements(
  projectId: string,
  runIds: readonly string[],
  requirements: readonly GoverningScopeRequirement[],
): Promise<Map<string, Set<string> | "all">> {
  const inDocument = new Set(requirements.map((r) => r.id));
  const live = await prisma.requirement.findMany({
    where: { projectId, analysisId: { in: [...runIds] }, deletedAt: null },
    select: { id: true, analysisId: true },
  });
  const partial = new Set(live.filter((r) => !inDocument.has(r.id)).map((r) => r.analysisId));
  const covered = new Map<string, Set<string> | "all">(
    runIds.map((id) => [id, partial.has(id) ? new Set<string>() : "all"]),
  );
  const evidence = new Map<string, string[]>();
  for (const r of requirements) {
    if (!partial.has(r.analysisId)) continue;
    // #2222 — a requirement re-checked on its own wording has findings under its own id.
    const own = covered.get(r.analysisId);
    if (own instanceof Set) own.add(r.id);
    for (const label of parseRequirementLabels(r.labels)) {
      if (!label.startsWith("finding:")) continue;
      const list = evidence.get(r.analysisId) ?? [];
      list.push(label.slice("finding:".length));
      evidence.set(r.analysisId, list);
    }
  }
  const findingIds = [...new Set([...evidence.values()].flat())];
  if (findingIds.length === 0) return covered;
  const rows = await prisma.finding.findMany({
    where: {
      id: { in: findingIds },
      agentResult: { analysisId: { in: [...partial] }, analysis: { projectId } },
    },
    select: { id: true, evidence: true, agentResult: { select: { analysisId: true } } },
  });
  const byId = new Map(rows.map((f) => [f.id, f]));
  for (const [runId, ids] of evidence) {
    const set = covered.get(runId);
    if (set === "all" || !set) continue;
    for (const id of ids) {
      const f = byId.get(id);
      // A finding of another run is not this requirement's evidence.
      if (f?.agentResult?.analysisId !== runId) continue;
      const analysed = evidenceRequirementId(f.evidence);
      if (analysed) set.add(analysed);
    }
  }
  return covered;
}

/**
 * The governing findings of the analysis runs `requirements` came from, read
 * within `projectId` and scoped to the requirements (see FINDINGS ARE PER
 * ANALYSED REQUIREMENT). Null when no run has a finding to list — no governing
 * document, none applied, or none on a covered requirement — so the document
 * is then exactly as it was without this section. The caller checks the
 * feature flag.
 */
export async function loadGoverningSection(
  projectId: string,
  requirements: readonly GoverningScopeRequirement[],
): Promise<GoverningSection | null> {
  if (requirements.length === 0) return null;
  const analyses = await prisma.analysis.findMany({
    where: { id: { in: [...new Set(requirements.map((r) => r.analysisId))] }, projectId },
    select: { id: true, startedAt: true },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
  });
  if (analyses.length === 0) return null;
  const covered = await coveredAnalysedRequirements(
    projectId,
    analyses.map((a) => a.id),
    requirements,
  );
  const runs = await Promise.all(
    analyses.map(async (a): Promise<GoverningSectionRun | null> => {
      const stored = await listGoverningFindings(a.id);
      const scope = covered.get(a.id) ?? "all";
      const inScope = (f: GoverningFinding) => scope === "all" || scope.has(f.requirementId);
      if (!stored.some(inScope)) return null;
      const [applicability, states] = await Promise.all([
        readGoverningApplicability(a.id),
        storedRequirementStates(a.id, projectId),
      ]);
      // #2222 — a finding that judged an earlier wording says so, as the analysis view does.
      // #2281 — and a deleted requirement's re-check is no finding of the run's, listed or not.
      const all = withGoverningStaleness(stored, states, applicability);
      const findings = all.filter(inScope);
      if (findings.length === 0) return null;
      const revisions = await governingFindingRevisions(findings);
      return {
        analysisId: a.id,
        startedAt: a.startedAt,
        findings,
        requirementText: new Map(
          (applicability?.requirements ?? []).map((r) => [r.requirementId, r.text] as const),
        ),
        requirementTitles: new Map(Object.entries(recheckedRequirementTitles(findings, states))),
        revisions,
        omitted: all.length - findings.length,
      };
    }),
  );
  const listed = runs.filter((r): r is GoverningSectionRun => r !== null);
  return listed.length > 0 ? { runs: listed } : null;
}

/** A document title or revision label as one Markdown-safe line; empty stays empty. */
function line(value: string): string {
  return value.trim() ? cell(value) : "";
}

/** One sentence per document revision the run's findings cite, in first-cited order. */
function summaryLines(run: GoverningSectionRun): string[] {
  const byRevision = new Map<string, GoverningFinding[]>();
  for (const f of run.findings) {
    const list = byRevision.get(f.revisionId) ?? [];
    list.push(f);
    byRevision.set(f.revisionId, list);
  }
  return [...byRevision.entries()].map(([revisionId, findings]) => {
    const revision = run.revisions.find((r) => r.revisionId === revisionId);
    const applicable = new Set(findings.map((f) => f.ruleId)).size;
    const waiting = findings.filter((f) => f.status === "needs-ba-input").map((f) => f.ruleId);
    return `- ${governingSummarySentence({
      applicable,
      // Never below N, as in the analysis view: a revision missing from
      // `revisions` counts only its cited rules.
      total: Math.max(applicable, revision?.rules ?? 0),
      gaps: findings.filter((f) => f.status === "gap").length,
      needsInput: new Set(waiting).size,
      documentTitle: line(revision?.documentTitle ?? findings[0]!.documentTitle),
      revisionLabel: line(revision?.revisionLabel ?? findings[0]!.revisionLabel),
    })}`;
  });
}

function documentName(f: GoverningFinding): string {
  return text([f.documentTitle, f.revisionLabel].filter((s) => s.trim()).join(" "));
}

/** #2222 — a re-checked requirement by its title; an analysed one by its id in the run. */
function requirementName(run: GoverningSectionRun, requirementId: string): string {
  return cell(run.requirementTitles?.get(requirementId) ?? requirementId);
}

/** #2222 — the status cell, marked when the finding judged an earlier wording. */
function statusLabel(f: GoverningFinding): string {
  const label = GOVERNING_STATUS_LABELS[f.status];
  return f.stale?.length ? `${label} (stale)` : label;
}

function findingTable(run: GoverningSectionRun): string[] {
  return [
    "| Requirement | Control id | Status | Decision | Governing document |",
    "|---|---|---|---|---|",
    ...run.findings.map(
      (f) =>
        `| ${requirementName(run, f.requirementId)} | ${cell(f.controlId)} | ${statusLabel(f)} | ${decisionLabel(f)} | ${documentName(f)} |`,
    ),
  ];
}

/** The clause the finding cites, or why there is none. */
function excerptLines(f: GoverningFinding): string[] {
  if (f.citationDropped) {
    return [
      "_The cited clause could not be found in this revision's text, so the citation was dropped and the finding waits on BA input._",
    ];
  }
  if (!f.clauseExcerpt?.trim()) return ["_No clause excerpt was recorded for this finding._"];
  const neutral = neutraliseComplianceClaims(f.clauseExcerpt);
  const out = [`> “${cell(neutral)}”`];
  if (neutral !== f.clauseExcerpt) {
    out.push(
      "",
      "_Compliance wording in this excerpt was neutralised; the clause as written is in METIS under the governing document._",
    );
  }
  return out;
}

function findingEntry(f: GoverningFinding): string[] {
  // Who and when, as the analysis view says it (#1876).
  const decided = f.decision
    ? ` by ${f.decidedByName?.trim() ? text(f.decidedByName) : "a former user"}${
        f.decidedAt ? ` on ${f.decidedAt.slice(0, 10)}` : ""
      }`
    : "";
  const clause = f.clauseRef.trim() ? `, clause ${text(f.clauseRef)}` : "";
  const revision = f.revisionLabel.trim() ? `, revision ${text(f.revisionLabel)}` : "";
  const out: string[] = [
    `**${cell(f.controlId)} — ${GOVERNING_STATUS_LABELS[f.status]}.** Decision: **${decisionLabel(f)}**${decided}. Rule of ${text(f.documentTitle)}${revision}${clause}.`,
    "",
    ...excerptLines(f),
    "",
    `- **Reasoning:** ${text(f.reasoning)}`,
  ];
  const stale = governingStaleNote(f.stale ?? []);
  if (stale) out.push(`- **${text(stale)}**`);
  if (f.modelStatus && f.modelStatus !== f.status && !f.citationDropped) {
    out.push(
      `- **Status set by METIS:** the model gave ${GOVERNING_STATUS_LABELS[f.modelStatus]} without evidence it could cite, so the finding is recorded as ${GOVERNING_STATUS_LABELS[f.status]}.`,
    );
  }
  if (f.businessQuestion?.trim()) {
    out.push(`- **Question for the business:** ${text(f.businessQuestion)}`);
  }
  if (f.decisionNote?.trim()) out.push(`- **Analyst's note:** ${text(f.decisionNote)}`);
  return out;
}

/** #2042 — the run's findings this document leaves out, counted. */
function omittedLine(run: GoverningSectionRun): string[] {
  if (run.omitted === 0) return [];
  const total = run.findings.length + run.omitted;
  const one = run.omitted === 1;
  return [
    "",
    `_${run.omitted} of the run's ${total} governing findings ${one ? "is" : "are"} on requirements as analysed that no requirement in this document draws its evidence from, so ${one ? "it is" : "they are"} not listed or counted here._`,
  ];
}

/**
 * The wording the findings under a heading judged. #2281 — a re-checked
 * requirement's wording was checked on its own (`recheck.ts`), not analysed,
 * and opens with its title, which the heading already gives.
 */
function judgedWordingLines(run: GoverningSectionRun, requirementId: string): string[] {
  const judged = run.requirementText.get(requirementId)?.trim();
  if (!judged) return [];
  const title = run.requirementTitles?.get(requirementId)?.trim();
  if (title === undefined) return ["", `_As analysed:_ ${text(judged)}`];
  const rest = judged.startsWith(title) ? judged.slice(title.length).trim() : judged;
  return rest ? ["", `_As re-checked:_ ${text(rest)}`] : [];
}

function runLines(run: GoverningSectionRun, requirementLevel: string): string[] {
  const out: string[] = [...summaryLines(run), ...omittedLine(run), "", ...findingTable(run)];
  let current: string | null = null;
  for (const f of run.findings) {
    if (f.requirementId !== current) {
      current = f.requirementId;
      out.push("", `${requirementLevel} ${requirementName(run, f.requirementId)}`);
      out.push(...judgedWordingLines(run, f.requirementId));
    }
    out.push("", ...findingEntry(f));
  }
  return out;
}

function leadIn(section: GoverningSection): string {
  const runs = section.runs.length;
  const source =
    runs === 1
      ? "the analysis run these requirements came from"
      : `the ${runs} analysis runs these requirements came from`;
  // #2042 — say which findings are listed, as `omittedLine` counts them.
  const recorded = section.runs.some((r) => r.omitted > 0)
    ? `Findings are recorded against each requirement as the run analysed it. This document covers only some of ${runs === 1 ? "the run's" : "a run's"} requirements, so only the findings on the requirements as analysed that its own requirements draw their evidence from are listed.`
    : "Findings are recorded against each requirement as the run analysed it, so every finding of the run is listed.";
  return `> **Checked against the workspace's governing documents.** Each finding below is copied from the governing findings METIS stored for ${source}, as the analysis view shows them: its status, the rule's control id, the clause METIS verified against the cited revision, and the analyst's decision. No model was asked again to write this section. ${recorded} A rejected finding is listed and marked **Rejected**, not left out. Not an audit opinion.`;
}

/**
 * #2109 — the Preview mark the UI shows on its governing surfaces, as a quoted
 * line under the heading; none when `GOVERNING_PREVIEW` is off.
 */
export function governingPreviewLines(): string[] {
  return GOVERNING_PREVIEW
    ? [`> **${GOVERNING_PREVIEW_LABEL}:** ${GOVERNING_PREVIEW_NOTE}`, ""]
    : [];
}

/** The section as Markdown lines, starting with its heading. */
export function renderGoverningSection(section: GoverningSection): string[] {
  const multiple = section.runs.length > 1;
  const out: string[] = [
    GOVERNING_SECTION_HEADING,
    "",
    ...governingPreviewLines(),
    leadIn(section),
  ];
  for (const run of section.runs) {
    if (multiple) {
      const when = formatStartedAt(run.startedAt);
      out.push("", `### Analysis run ${when ? `started ${when}` : "(start time not recorded)"}`);
    }
    out.push("", ...runLines(run, multiple ? "####" : "###"));
  }
  // Backstop: each stored text above was neutralised; this catches a claim the
  // composition itself could form. Line by line, so a rewrite never joins two.
  return out.map(neutraliseComplianceClaims);
}

/**
 * What the section depends on, for the document's source fingerprint: a
 * finding re-produced or decided, a decider renamed, a revision's rule count,
 * the analysed requirement text, and which findings the document's scope
 * leaves out (#2042) each change it.
 */
export function governingSectionFacts(section: GoverningSection): string {
  return JSON.stringify(
    section.runs.map((run) => [
      run.analysisId,
      run.omitted,
      run.findings.map((f) => [
        f.id,
        f.status,
        f.revisionId,
        f.clauseExcerpt,
        f.decision,
        f.decisionNote,
        f.decidedByName,
        f.decidedAt,
        f.updatedAt,
        run.requirementText.get(f.requirementId) ?? null,
        // #2222 — an edit of a requirement makes its findings stale, and the section says so.
        f.stale ?? [],
      ]),
      run.revisions.map((r) => [r.revisionId, r.rules, r.documentTitle, r.revisionLabel]),
    ]),
  );
}
