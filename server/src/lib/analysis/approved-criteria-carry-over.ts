/**
 * Issue #1389 — a re-synthesis must not change what an analyst approved.
 *
 * A Regenerate (or resume) re-runs synthesis and REPLACES the analysis's
 * requirement set (#57): every row is hard-deleted and re-created from the new
 * synthesis output. On the approval-checkpoint path the title, body and
 * priority come from the approved STRUCTURED requirement, which a regenerate
 * does not change; the acceptance criteria come from the synthesis item, which
 * it does. On analysis `cmviuhc12000icg9kaf5jho38` the model gave "Minimalist,
 * fast, lightweight feed reader" no criteria, and the approved row's two were
 * gone, with no version row to say they had ever existed.
 *
 * The rule: an approved requirement ALWAYS keeps the criteria approved at the
 * checkpoint, and the row's content — so its Approved status — is unchanged.
 * A re-synthesis that gives **none** is the #1389 incident shape: the approved
 * list is kept silently. One whose criteria are **materially** different (as a
 * set, after {@link normalizeCriterion}) becomes a **proposal** the analyst can
 * accept or dismiss; re-synthesis rewords criteria on every run, so anything
 * less would put a notice on most approved requirements after each Regenerate.
 * A dismissal holds for that requirement for the rest of the extraction run.
 *
 * "Approved" is anchored, not inferred: the criteria each structured
 * requirement was promoted with are recorded on the analysis
 * ({@link ApprovedCriteriaRecord}) the first time it is promoted in an
 * extraction run, so any number of regenerates compare against the same list.
 *
 * Pure: no database access. The writer is `replaceRequirementSet`.
 */
import { parseAcceptanceCriteria } from "@metis/shared";

/** Analysis-metadata key of {@link ApprovedCriteriaRecord}. */
export const APPROVED_CRITERIA_KEY = "checkpointApprovedCriteria";
/** Analysis-metadata key of the pending {@link CriteriaProposal}s, by requirement id. */
export const CRITERIA_PROPOSALS_KEY = "criteriaProposals";

/**
 * History reason of the version row that writes the approved criteria back onto
 * a re-created row that has a proposal, so that accepting the proposal leaves a
 * version holding the approved criteria for Restore to return to.
 */
export const KEPT_APPROVED_CRITERIA_REASON =
  "Approved acceptance criteria kept; re-synthesis suggested different ones";

/** History reason of the analyst's version row when they accept a proposal. */
export const ACCEPTED_CRITERIA_PROPOSAL_REASON =
  "Accepted the acceptance criteria re-synthesis suggested";

/**
 * The criteria each structured requirement was approved with, for one
 * extraction run (ids restart at `REQ-001` each run, #909), and the proposals
 * the analyst dismissed, so the same suggestion is not raised again.
 */
export interface ApprovedCriteriaRecord {
  runId: string | null;
  /** Structured id → the criteria it was approved with. */
  approved: Record<string, string[]>;
  /**
   * Structured id → the JSON of the proposal the analyst dismissed. Its
   * presence suppresses every later proposal for that requirement in this run.
   */
  dismissed: Record<string, string>;
}

/** A re-synthesis's different criteria for an approved requirement, awaiting the analyst. */
export interface CriteriaProposal {
  structuredId: string;
  proposed: string[];
  /** ISO time the re-synthesis made it. */
  at: string;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Read the record for `runId` from analysis metadata; empty for another run or a bad shape. */
export function readApprovedCriteriaRecord(
  metadata: Record<string, unknown>,
  runId: string | null,
): ApprovedCriteriaRecord {
  const empty: ApprovedCriteriaRecord = { runId, approved: {}, dismissed: {} };
  const raw = metadata[APPROVED_CRITERIA_KEY];
  if (!raw || typeof raw !== "object") return empty;
  const rec = raw as Record<string, unknown>;
  if ((rec.runId ?? null) !== (runId ?? null)) return empty;
  const approved: Record<string, string[]> = {};
  for (const [k, v] of Object.entries((rec.approved as Record<string, unknown>) ?? {})) {
    if (isStringArray(v)) approved[k] = v;
  }
  const dismissed: Record<string, string> = {};
  for (const [k, v] of Object.entries((rec.dismissed as Record<string, unknown>) ?? {})) {
    if (typeof v === "string") dismissed[k] = v;
  }
  return { runId, approved, dismissed };
}

/** The pending proposals in analysis metadata, by requirement id (bad entries dropped). */
export function readCriteriaProposals(
  metadata: Record<string, unknown>,
): Record<string, CriteriaProposal> {
  const raw = metadata[CRITERIA_PROPOSALS_KEY];
  const out: Record<string, CriteriaProposal> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as Partial<CriteriaProposal> | null;
    if (p && typeof p.structuredId === "string" && isStringArray(p.proposed)) {
      out[id] = {
        structuredId: p.structuredId,
        proposed: p.proposed,
        at: typeof p.at === "string" ? p.at : "",
      };
    }
  }
  return out;
}

/**
 * A criterion as compared across re-syntheses: trailing code citations
 * (`internal/cli/cli.go:65`, `(api.go:43 and 37)`) removed, lower-cased,
 * punctuation dropped, whitespace collapsed. Two runs that cite different line
 * numbers for the same check compare equal.
 */
export function normalizeCriterion(criterion: string): string {
  return criterion
    .replace(/\([^()]*\)/g, (group) => (group.split(/\s+/).some(isCitation) ? " " : group))
    .split(/\s+/)
    .filter((token) => !isCitation(token))
    .join(" ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `path/file.go:12`, `file.go:12-17,` or `(api.go:43` — a file name with an
 * extension, then a line number. String checks, not one backtracking regex.
 */
function isCitation(token: string): boolean {
  const t = token.replace(/^[(`'"[]+/, "").replace(/[)`'"\],.;]+$/, "");
  const colon = t.lastIndexOf(":");
  if (colon <= 0) return false;
  const file = t.slice(0, colon);
  const lines = t.slice(colon + 1);
  const dot = file.lastIndexOf(".");
  return dot > 0 && dot < file.length - 1 && /^\d+(-\d+)?$/.test(lines);
}

/** Whether two criteria lists are the same set once normalised (blanks ignored). */
export function sameCriteria(a: readonly string[], b: readonly string[]): boolean {
  const set = (xs: readonly string[]) =>
    new Set(xs.map(normalizeCriterion).filter((x) => x.length > 0));
  const sa = set(a);
  const sb = set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** How one re-created approved row is written. */
export interface ApprovedCriteriaPlan {
  /** The criteria the row ends with: always the approved ones. */
  criteria: string[];
  /** The re-synthesis's different criteria for the analyst to decide on, or null. */
  proposed: string[] | null;
}

/**
 * Plan one approved row.
 *
 * @param recorded the criteria recorded for it at the checkpoint, if any.
 * @param previousRow the stored `acceptanceCriteria` JSON of the row this one
 *   replaces — the anchor for a set promoted before the record existed.
 * @param fresh the criteria the new synthesis gave it.
 * @param dismissed set when the analyst already dismissed a proposal for it in this run.
 */
export function planApprovedCriteria(input: {
  recorded: readonly string[] | undefined;
  previousRow: string | undefined;
  fresh: readonly string[];
  dismissed: string | undefined;
}): ApprovedCriteriaPlan {
  const fresh = [...input.fresh];
  const approved = input.recorded
    ? [...input.recorded]
    : input.previousRow !== undefined
      ? parseAcceptanceCriteria(input.previousRow)
      : fresh;
  // #1389 — `[]` (the incident shape) and a dismissed requirement raise nothing.
  const raise = fresh.length > 0 && input.dismissed === undefined && !sameCriteria(approved, fresh);
  return { criteria: approved, proposed: raise ? fresh : null };
}
