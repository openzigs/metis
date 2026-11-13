/**
 * #2326 — `pnpm eval:ba-qa --index-fault failed|partial`: ask the question set
 * over a project whose last indexing run is recorded as failed or partial, and
 * count how often the answer says the index may be incomplete instead of
 * asserting that the project lacks something.
 *
 * The fault is written to each product's repository connection
 * (`sourceIngestState`, the record chat reads) for the run and restored
 * afterwards; the indexed content itself is left as it is, so the questions
 * stay answerable and the arms differ only in what the model is told.
 */
import type { SourceIngestState } from "../../connectors/source-ingest-state.js";

export const INDEX_FAULTS = ["failed", "partial"] as const;
export type IndexFault = (typeof INDEX_FAULTS)[number];

export function parseIndexFault(raw: string): IndexFault {
  const fault = INDEX_FAULTS.find((f) => f === raw);
  if (!fault) throw new Error(`--index-fault takes ${INDEX_FAULTS.join(" or ")}, not ${raw}`);
  return fault;
}

/**
 * The recorded outcome of a last run that failed, or that indexed only 200 of
 * 500 eligible files (300 past the file limit). `now` is the run's finish.
 */
export function indexFaultState(fault: IndexFault, now: Date): SourceIngestState {
  const at = now.toISOString();
  const base: SourceIngestState = {
    version: 1,
    runId: `eval-index-fault-${fault}`,
    status: fault,
    startedAt: at,
    heartbeatAt: at,
    finishedAt: at,
    eligible: 500,
    selected: fault === "partial" ? 200 : 500,
    processed: 200,
    created: 200,
    updated: 0,
    unchanged: 0,
    failed: 0,
    chunkCount: 1600,
    skipped: {
      cap: fault === "partial" ? 300 : 0,
      tooLarge: 0,
      unreadable: 0,
      excludedTests: 0,
      excludedGenerated: 0,
    },
    limits: { maxFiles: 200, maxFileBytes: 1_048_576, includeTests: true },
  };
  return fault === "failed" ? { ...base, error: "embedding request timed out (ETIMEDOUT)" } : base;
}

const PROBLEM = String.raw`(?:fail(?:ed|ure|s)?|partial(?:ly)?|incomplete|in progress|out of date|stale|not (?:yet )?(?:complete|finished|fully)|missing files|did not finish)`;
const INDEX = String.raw`(?:index(?:ed|ing|es)?|re-?index\w*|ingest(?:ed|ion)?)`;
/** An index word and a problem word in one sentence, either way round. */
const MENTIONS = new RegExp(
  String.raw`\b${INDEX}\b[^.!?\n]{0,160}\b${PROBLEM}|\b${PROBLEM}\b[^.!?\n]{0,160}\b${INDEX}\b`,
  "i",
);

/** Whether `answer` says the project's index is failed, partial or incomplete. */
export function mentionsIndexProblem(answer: string): boolean {
  return MENTIONS.test(answer);
}

export interface IndexFaultSummary {
  fault: IndexFault;
  /** Answers that say the index may be incomplete. */
  mentioned: number;
  /** Answers judged as abstaining ("the sources don't show this")… */
  abstained: number;
  /** …of which said nothing about the index: an assertion of absence. */
  abstainedWithoutIndex: number;
  of: number;
}

export function summarizeIndexFault(
  fault: IndexFault,
  sessions: ReadonlyArray<{ response: string; behaviour: string | null }>,
): IndexFaultSummary {
  const mentioned = sessions.filter((s) => mentionsIndexProblem(s.response));
  const abstained = sessions.filter((s) => s.behaviour === "abstain");
  return {
    fault,
    mentioned: mentioned.length,
    abstained: abstained.length,
    abstainedWithoutIndex: abstained.filter((s) => !mentionsIndexProblem(s.response)).length,
    of: sessions.length,
  };
}
