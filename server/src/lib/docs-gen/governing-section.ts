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
 * FINDINGS ARE PER RUN. A finding is recorded against a requirement as the run
 * analysed it (`REQ-001`), before synthesis wrote the stored requirements the
 * document lists, and the two are not joined by id. So the section lists every
 * finding of each run the document's requirements came from, and says so.
 *
 * SUMMARY. One `governingSummarySentence` per cited revision, counted as the
 * analysis view counts it (`governingSummarySentences` in the UI's findings
 * panel, #1876): N the distinct rules with a finding, M the revision's rule
 * count from `governingFindingRevisions` (the route's), gaps the Gap
 * findings, and the distinct rules still waiting on BA input.
 *
 * TENANCY. The runs are read with the project id as well as their ids, so a
 * run of another project is never read. Findings, decider names and rule
 * counts are then read through the findings store, by the run's id and the
 * revisions its own rows cite, exactly as the analysis route reads them.
 */
import {
  governingSummarySentence,
  neutraliseComplianceClaims,
  type GoverningFinding,
  type GoverningFindingDecision,
  type GoverningFindingStatus,
} from "@metis/shared";
import { formatStartedAt } from "../analysis/run-start-label.js";
import { readGoverningApplicability } from "../governing/applicability-store.js";
import {
  governingFindingRevisions,
  listGoverningFindings,
  type GoverningFindingRevision,
} from "../governing/findings-store.js";
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
  /** Each cited revision with its rule count (`governingFindingRevisions`). */
  revisions: readonly GoverningFindingRevision[];
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
 * The governing findings of the analysis runs `analysisIds` names, read within
 * `projectId`. Null when none of them has a finding — no governing document,
 * or none applied — so the document is then exactly as it was without this
 * section. The caller checks the feature flag.
 */
export async function loadGoverningSection(
  projectId: string,
  analysisIds: readonly string[],
): Promise<GoverningSection | null> {
  if (analysisIds.length === 0) return null;
  const analyses = await prisma.analysis.findMany({
    where: { id: { in: [...new Set(analysisIds)] }, projectId },
    select: { id: true, startedAt: true },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }],
  });
  const runs: GoverningSectionRun[] = [];
  for (const a of analyses) {
    const findings = await listGoverningFindings(a.id);
    if (findings.length === 0) continue;
    const applicability = await readGoverningApplicability(a.id);
    runs.push({
      analysisId: a.id,
      startedAt: a.startedAt,
      findings,
      requirementText: new Map(
        (applicability?.requirements ?? []).map((r) => [r.requirementId, r.text] as const),
      ),
      revisions: await governingFindingRevisions(findings),
    });
  }
  return runs.length > 0 ? { runs } : null;
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
      documentTitle: revision?.documentTitle ?? findings[0]!.documentTitle,
      revisionLabel: revision?.revisionLabel ?? findings[0]!.revisionLabel,
    })}`;
  });
}

function documentName(f: GoverningFinding): string {
  return text([f.documentTitle, f.revisionLabel].filter((s) => s.trim()).join(" "));
}

function findingTable(run: GoverningSectionRun): string[] {
  return [
    "| Requirement | Control id | Status | Decision | Governing document |",
    "|---|---|---|---|---|",
    ...run.findings.map(
      (f) =>
        `| ${cell(f.requirementId)} | ${cell(f.controlId)} | ${GOVERNING_STATUS_LABELS[f.status]} | ${decisionLabel(f)} | ${documentName(f)} |`,
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

function runLines(run: GoverningSectionRun, requirementLevel: string): string[] {
  const out: string[] = [...summaryLines(run), "", ...findingTable(run)];
  let current: string | null = null;
  for (const f of run.findings) {
    if (f.requirementId !== current) {
      current = f.requirementId;
      out.push("", `${requirementLevel} ${cell(f.requirementId)}`);
      const analysed = run.requirementText.get(f.requirementId);
      if (analysed?.trim()) out.push("", `_As analysed:_ ${text(analysed)}`);
    }
    out.push("", ...findingEntry(f));
  }
  return out;
}

function leadIn(runs: number): string {
  const source =
    runs === 1
      ? "the analysis run these requirements came from"
      : `the ${runs} analysis runs these requirements came from`;
  return `> **Checked against the workspace's governing documents.** Each finding below is copied from the governing findings METIS stored for ${source}, as the analysis view shows them: its status, the rule's control id, the clause METIS verified against the cited revision, and the analyst's decision. No model was asked again to write this section. Findings are recorded against each requirement as the run analysed it, so every finding of the run is listed. A rejected finding is listed and marked **Rejected**, not left out. Not an audit opinion.`;
}

/** The section as Markdown lines, starting with its heading. */
export function renderGoverningSection(section: GoverningSection): string[] {
  const multiple = section.runs.length > 1;
  const out: string[] = [GOVERNING_SECTION_HEADING, "", leadIn(section.runs.length)];
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
 * What of the findings the section depends on, for the document's source
 * fingerprint: a finding re-produced or decided changes it.
 */
export function governingSectionFacts(section: GoverningSection): string {
  return JSON.stringify(
    section.runs.map((run) => [
      run.analysisId,
      run.findings.map((f) => [
        f.id,
        f.status,
        f.revisionId,
        f.clauseExcerpt,
        f.decision,
        f.decisionNote,
        f.updatedAt,
      ]),
    ]),
  );
}
