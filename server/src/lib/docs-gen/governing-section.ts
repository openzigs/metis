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
 * TENANCY. The runs are read with the project id as well as their ids, so a
 * run of another project is never read; the rule counts are read within the
 * project's workspace.
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
import { listGoverningFindings, summariseFindings } from "../governing/findings-store.js";
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
  /** How many rules each cited revision holds, for the summary sentence. */
  rulesPerRevision: ReadonlyMap<string, number>;
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

/** How many rules `revisionId` holds: its live rules, and any a finding cites since deleted. */
async function ruleCount(
  workspaceId: string,
  revisionId: string,
  citedRuleIds: readonly string[],
): Promise<number> {
  return prisma.governingRule.count({
    where: {
      revisionId,
      revision: { document: { workspaceId } },
      OR: [{ deletedAt: null }, { id: { in: [...citedRuleIds] } }],
    },
  });
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
  const withFindings: Array<{ id: string; startedAt: Date | null; findings: GoverningFinding[] }> =
    [];
  for (const a of analyses) {
    const findings = await listGoverningFindings(a.id);
    if (findings.length > 0) withFindings.push({ ...a, findings });
  }
  if (withFindings.length === 0) return null;

  const project = await prisma.project.findFirst({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const workspaceId = project?.workspaceId ?? null;
  const runs: GoverningSectionRun[] = [];
  for (const a of withFindings) {
    const applicability = await readGoverningApplicability(a.id);
    const requirementText = new Map(
      (applicability?.requirements ?? []).map((r) => [r.requirementId, r.text] as const),
    );
    const rulesPerRevision = new Map<string, number>();
    for (const revisionId of new Set(a.findings.map((f) => f.revisionId))) {
      const cited = a.findings.filter((f) => f.revisionId === revisionId).map((f) => f.ruleId);
      rulesPerRevision.set(
        revisionId,
        workspaceId ? await ruleCount(workspaceId, revisionId, [...new Set(cited)]) : 0,
      );
    }
    runs.push({
      analysisId: a.id,
      startedAt: a.startedAt,
      findings: a.findings,
      requirementText,
      rulesPerRevision,
    });
  }
  return { runs };
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
    const counts = summariseFindings(findings);
    const applicable = new Set(findings.map((f) => f.ruleId)).size;
    // A revision's rules are only ever hard-deleted with the revision itself,
    // so the count holds every rule a finding cites; the floor keeps the
    // sentence from reading "3 of 2" if one is gone all the same.
    const total = Math.max(run.rulesPerRevision.get(revisionId) ?? 0, applicable);
    const first = findings[0]!;
    return `- ${governingSummarySentence({
      applicable,
      total,
      gaps: counts.gap,
      needsInput: counts.needsBaInput,
      documentTitle: first.documentTitle,
      revisionLabel: first.revisionLabel,
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
  const decided = f.decision && f.decidedAt ? ` on ${f.decidedAt.slice(0, 10)}` : "";
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
