/**
 * #1070 / #995 — what a planned document records about its plan and its
 * consistency check, for the provenance manifest and the Provenance panel.
 *
 * The analyst reading a business-requirements document needs two answers the
 * document itself does not give: which topics were LEFT OUT before anything
 * was written, and in what order (lowest priority first), and whether the
 * sections contradict each other. Both are computed during generation
 * (`document-plan.ts`, `fact-consistency.ts`); this module turns them into the
 * small, bounded records the manifest stores. Numbers, titles and quoted
 * statements only: no prompt text, no facts.
 *
 * Pure: no I/O and no model calls.
 */
import type { DocumentPlan } from "./document-plan.js";
import { MAX_LISTED_STATEMENTS, type ConsistencyReport } from "./fact-consistency.js";

/** Most dropped topics recorded per section; the rest are counted. */
export const MAX_RECORDED_DROPPED_TOPICS = 200;
/** Most consistency findings recorded; the rest are counted. */
export const MAX_RECORDED_FINDINGS = 50;
/** Longest title or quoted statement recorded. */
export const MAX_RECORDED_TEXT_CHARS = 200;

export interface TopicPlanSectionRecord {
  sectionLabel: string;
  kind: "enumerative" | "single";
  /** Characters the section was planned (the sum of its topics' budgets). */
  budgetChars: number;
  /** Topics planned for it. */
  plannedTopics: number;
  /** Topics the plan left out, highest priority first (so the last listed went first). */
  dropped: string[];
  /** Dropped topics past {@link MAX_RECORDED_DROPPED_TOPICS}, counted only. */
  droppedNotListed: number;
}

export interface TopicPlanRecord {
  version: number;
  /** The document budget the plan shared out (the cap less the footnotes' room). */
  budgetChars: number;
  unallocatedChars: number;
  sections: TopicPlanSectionRecord[];
}

export interface ConsistencyFindingRecord {
  kind: "conflict" | "restated" | "endpoint" | "count" | "size";
  name: string;
  /** For a prose finding, what it is about as written ("API token (characters)"). */
  label?: string;
  /** Distinct sections among the statements. */
  sections: number;
  /** Distinct values (or forms) stated. */
  forms: number;
  statements: Array<{ section: string; value: string }>;
  /** The source's value and line, for a finding checked against the facts sheet. */
  source?: { value: string; location: string };
}

export interface ConsistencyRecord {
  /** Statements read across the document. */
  statements: number;
  /** Of those, the ones that had something to be compared with. */
  compared: number;
  /** Findings in all, listed or not. */
  findingCount: number;
  findings: ConsistencyFindingRecord[];
}

const clip = (text: string): string =>
  text.length > MAX_RECORDED_TEXT_CHARS ? `${text.slice(0, MAX_RECORDED_TEXT_CHARS - 1)}…` : text;

/** The plan as the manifest records it, sections labelled as the document labels them. */
export function topicPlanRecord(
  plan: DocumentPlan,
  labelOf: (sectionId: string) => string,
): TopicPlanRecord {
  return {
    version: plan.version,
    budgetChars: plan.budgetChars,
    unallocatedChars: plan.unallocatedChars,
    sections: plan.sections.map((section) => ({
      sectionLabel: labelOf(section.sectionId),
      kind: section.kind,
      budgetChars: section.budgetChars,
      plannedTopics: section.topics.length,
      dropped: section.dropped.slice(0, MAX_RECORDED_DROPPED_TOPICS).map((t) => clip(t.title)),
      droppedNotListed: Math.max(0, section.dropped.length - MAX_RECORDED_DROPPED_TOPICS),
    })),
  };
}

/** The consistency check as the manifest records it, whether or not it found anything. */
export function consistencyRecord(report: ConsistencyReport): ConsistencyRecord {
  return {
    statements: report.statements,
    compared: report.compared,
    findingCount: report.findings.length,
    findings: report.findings.slice(0, MAX_RECORDED_FINDINGS).map((f) => ({
      kind: f.kind,
      name: clip(f.name),
      ...(f.label ? { label: clip(f.label) } : {}),
      sections: f.sections,
      forms: f.forms,
      statements: f.statements.slice(0, MAX_LISTED_STATEMENTS).map((s) => ({
        section: clip(s.section),
        value: clip(s.value),
      })),
      ...(f.canonical
        ? { source: { value: clip(f.canonical.value), location: clip(f.canonical.source) } }
        : {}),
    })),
  };
}
