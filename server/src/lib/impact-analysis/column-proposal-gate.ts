/**
 * #791 — the deterministic gate between the additive-column proposer and the
 * impact result.
 *
 * THE DEFECT. Miniflux #4478 asks to "mark all as read older than X". The code
 * that does it exists: `MarkAllAsReadBeforeDate(userID, before time.Time)`. The
 * proposer nevertheless kept answering with a new column on `users` to hold X —
 * `mark_read_older_than_days` (runs 3, 4, 6), then `mark_read_time_options`,
 * `mark_read_delay` and `mark_read_times` (run 7, 3 runs in 3). A prompt rule did
 * not hold (#1019), and neither did #1045's structural check, because it decided
 * coverage by NAME: the proposed column had to restate the writer's name, and
 * "delay" does not restate "before date".
 *
 * THE RULE HERE decides coverage by what the writer DOES. A writer covers a
 * request when the request asks for an operation bounded by a value (an age, a
 * cutoff) and the writer already filters its own table on a column of that kind,
 * taking the value as an argument. A column proposed on a table NO covering
 * writer writes is not something that operation records, so it needs a reason of
 * its own to be a migration:
 *
 *   - `core`     — appended to the affected tables, as before. Outside a
 *                  covering writer's tables, only when the request asks to
 *                  RECORD something ("…and record on the feed when it was last
 *                  pruned");
 *   - `optional` — "Optional: settings persistence". The request asks to
 *                  configure or remember the value, or the proposer itself called
 *                  the column a user preference. Shown, labelled, and never part
 *                  of the affected tables, so never part of "migration needed";
 *   - `rejected` — an existing write path already takes the value as a
 *                  parameter and nothing asks to store it. Returned with that
 *                  writer and the reason (#1051).
 *
 * The proposer's structured answer is an INPUT to this gate, not its authority:
 * a covering writer it declares can only move a proposal OUT of `core`, and the
 * lineage-derived covering writers apply whatever it answered.
 *
 * Pure — no I/O.
 */
import type { DataPathWriterProfile } from "./data-path-writers.js";
import type { AffectedTableInput } from "./schema-impact.js";

/** Why the proposer says a new column is needed. */
export const COLUMN_JUSTIFICATIONS = ["operation-needs-new-data", "user-preference"] as const;
export type ColumnJustification = (typeof COLUMN_JUSTIFICATIONS)[number];

/** One proposed `add-column` row with the proposer's own account of it. */
export interface ProposedColumn {
  row: AffectedTableInput;
  /** Null when the proposer gave none: read as `operation-needs-new-data`. */
  justification: ColumnJustification | null;
  /** The id of a listed writer the proposer says already covers this column. */
  coveredByWriterId: string | null;
  rationale: string;
}

/** What a proposer returns: bare rows (unjustified), or the structured answer. */
export type ProposerOutput =
  AffectedTableInput[] | { proposals: ProposedColumn[]; coveringWriterIds: string[] };

/** The existing write path a gated proposal is set against, with its location. */
export interface CoveringWriterRef {
  qualifiedName: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

/** A proposal the gate kept out of the affected tables. */
export interface GatedColumnProposal {
  row: AffectedTableInput;
  /** The covering write path; null for a preference no existing writer relates to. */
  writer: CoveringWriterRef | null;
  reason: string;
}

export interface GatedProposals {
  core: AffectedTableInput[];
  optional: GatedColumnProposal[];
  rejected: GatedColumnProposal[];
}

export function normalizeProposerOutput(output: ProposerOutput): {
  proposals: ProposedColumn[];
  coveringWriterIds: string[];
} {
  if (!Array.isArray(output)) return output;
  return {
    proposals: output.map((row) => ({
      row,
      justification: null,
      coveredByWriterId: null,
      rationale: "",
    })),
    coveringWriterIds: [],
  };
}

// ── What the request asks for ────────────────────────────────────────────────

/**
 * Phrases that bound an operation by AGE or by a point in time: "older than X",
 * "older than 30 days", "before a given date", "in the last 7 days". The value in
 * such a phrase is an argument of the operation.
 */
const TIME_BOUND_PATTERNS: readonly RegExp[] = [
  /\b(older|newer|earlier|later)\s+than\b/i,
  /\b(more|less|longer|shorter)\s+than\s+(?:\S+\s+){0,2}?(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i,
  /\b(before|after|since|until)\s+(?:an?\s+|the\s+)?(?:given\s+|certain\s+|specific\s+|chosen\s+)?(date|time|timestamp|day)\b/i,
  /\b(last|past|within|every)\s+(?:\S+\s+)?(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i,
  /\b\S+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+(old|ago)\b/i,
];

/** True when the request bounds its operation by an age or a point in time. */
export function requestHasTimeBound(requirementText: string): boolean {
  return TIME_BOUND_PATTERNS.some((p) => p.test(requirementText));
}

/**
 * Words that ask for a value to be CONFIGURED or KEPT: "Times could be configured
 * in settings", "remember the chosen days per user", "a default". With a covering
 * writer in hand, this is what separates an optional settings column from a
 * column nothing asks for. "Option" is deliberately absent: "gives people the
 * option to" asks for a feature, not for a setting.
 */
const SETTINGS_CUE =
  /\b(settings?|preferences?|configur\w*|defaults?|remember\w*|customi[sz]\w*|per[- ]user)\b/i;

export function requestAsksToConfigure(requirementText: string): boolean {
  return SETTINGS_CUE.test(requirementText);
}

/**
 * Words that ask for NEW DATA to be kept as a result of the operation: "record
 * when it was pruned", "store the reason", "track who did it". #1045's
 * persistence-verb guard, which was right and never ran because its covered
 * check did not fire.
 */
const RECORD_CUE =
  /\b(record(s|ed|ing)?|stor(e|es|ed|ing)|track(s|ed|ing)?|persist(s|ed|ing)?|audit(s|ed|ing)?)\b/i;

export function requestAsksToRecord(requirementText: string): boolean {
  return RECORD_CUE.test(requirementText);
}

// ── What a writer does ───────────────────────────────────────────────────────

/** A column that holds a point in time, by the conventions column names follow. */
const TIME_COLUMN =
  /(^|_)(at|on|date|time|timestamp|until|since)$|^(created|updated|published|changed|modified|deleted|expires?|expired)(_|$)/i;

/** A parameter typed as a time or a duration (`before time.Time`, `cutoff: Date`). */
const TIME_PARAMETER =
  /\b(time\.Time|time\.Duration|Date|DateTime|LocalDate\w*|OffsetDateTime|ZonedDateTime|Instant|Timestamp|Duration|datetime|timedelta)\b/;

function columnName(qualified: string): string {
  return qualified.slice(qualified.lastIndexOf(".") + 1);
}

/** The time-valued columns this writer filters its own table on. */
export function timePredicates(writer: DataPathWriterProfile): string[] {
  return writer.predicateColumns.filter((c) => TIME_COLUMN.test(columnName(c)));
}

/** `MarkAllAsReadBeforeDate` out of `internal/storage/entry.go::MarkAllAsReadBeforeDate`. */
function shortName(qualifiedName: string): string {
  const afterFile = qualifiedName.split("::").pop() ?? qualifiedName;
  return afterFile.slice(afterFile.lastIndexOf(".") + 1);
}

function writerRef(writer: DataPathWriterProfile): CoveringWriterRef {
  return {
    qualifiedName: writer.qualifiedName,
    filePath: writer.filePath,
    startLine: writer.startLine,
    endLine: writer.endLine,
  };
}

/** `MarkAllAsReadBeforeDate (internal/storage/entry.go:523)`. */
function cite(writer: DataPathWriterProfile): string {
  return `${shortName(writer.qualifiedName)} (${writer.filePath}:${writer.startLine})`;
}

/** How this writer takes the value: its predicate and, when known, the argument. */
function coverage(writer: DataPathWriterProfile): string {
  const predicates = timePredicates(writer);
  const parameter = writer.parameters.find((p) => TIME_PARAMETER.test(p));
  if (predicates.length === 0) return "already performs the requested operation";
  const filters = `already filters ${predicates.join(", ")}`;
  return parameter ? `${filters} by its argument (${parameter})` : `${filters} by an argument`;
}

interface Covering {
  writer: DataPathWriterProfile;
  /** Lineage-derived (true), or only declared by the proposer (false). */
  structural: boolean;
}

/**
 * The writers that already perform the requested operation.
 *
 * STRUCTURAL: the request is bounded by a time or an age, and the writer filters
 * the table it writes on a time-valued column. That holds whatever the model
 * answered. DECLARED: the proposer listed the writer as covering; it can only
 * add to the set.
 */
function coveringWriters(
  requirementText: string,
  writers: readonly DataPathWriterProfile[],
  declaredIds: readonly string[],
): Covering[] {
  const timeBound = requestHasTimeBound(requirementText);
  const declared = new Set(declaredIds);
  const out: Covering[] = [];
  for (const writer of writers) {
    const structural = timeBound && timePredicates(writer).length > 0;
    if (structural || declared.has(writer.id)) out.push({ writer, structural });
  }
  // Structural evidence first: it is the one cited.
  return out.sort((a, b) => Number(b.structural) - Number(a.structural));
}

function bareTable(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

export interface GateColumnProposalsInput {
  requirementText: string;
  proposals: readonly ProposedColumn[];
  /** Writer ids the proposer listed as covering the request. */
  coveringWriterIds: readonly string[];
  /** Every writer the lineage named for this request, profiled. */
  writers: readonly DataPathWriterProfile[];
}

/**
 * Sort each proposal into `core`, `optional` or `rejected`. See the module
 * header for the rule; in order, for one proposal on table T:
 *
 *   1. covering writers exist and none of them writes T →
 *        `optional` when the proposer called it a user preference;
 *        `core` when the request asks to record something;
 *        `optional` when the request asks to configure the value;
 *        else `rejected`;
 *   2. the proposer named a listed writer as covering THIS column → `rejected`;
 *   3. the proposer called it a user preference → `optional`;
 *   4. otherwise → `core`.
 *
 * "None of them writes T" is the conservative reading on purpose: one covering
 * writer on an unrelated table must not cost a table its genuinely new column.
 */
export function gateColumnProposals(input: GateColumnProposalsInput): GatedProposals {
  const covering = coveringWriters(input.requirementText, input.writers, input.coveringWriterIds);
  const writerById = new Map(input.writers.map((w) => [w.id, w]));
  const asksToConfigure = requestAsksToConfigure(input.requirementText);
  const asksToRecord = requestAsksToRecord(input.requirementText);
  const coveredTables = new Set(covering.flatMap((c) => c.writer.writeTables.map(bareTable)));
  const out: GatedProposals = { core: [], optional: [], rejected: [] };

  for (const proposal of input.proposals) {
    const table = bareTable(proposal.row.tableName);
    const preference = proposal.justification === "user-preference";

    // 1 — a column the existing operation does not write.
    if (covering.length > 0 && !coveredTables.has(table)) {
      const { writer } = covering[0]!;
      if (!preference && asksToRecord) {
        out.core.push(proposal.row);
      } else if (preference || asksToConfigure) {
        out.optional.push({
          row: proposal.row,
          writer: writerRef(writer),
          reason: `Optional: settings persistence. ${cite(writer)} ${coverage(writer)}, so this column would only remember a preferred value. It is not part of the migration this change needs.`,
        });
      } else {
        out.rejected.push({
          row: proposal.row,
          writer: writerRef(writer),
          reason: `An existing write path covers this: ${cite(writer)} ${coverage(writer)}. The value is an argument of that call, not data to store.`,
        });
      }
      continue;
    }

    // 2 — the proposer contradicted itself.
    const selfCovered = proposal.coveredByWriterId
      ? writerById.get(proposal.coveredByWriterId)
      : undefined;
    if (selfCovered) {
      out.rejected.push({
        row: proposal.row,
        writer: writerRef(selfCovered),
        reason: `An existing write path covers this: the proposer itself named ${cite(selfCovered)} as already providing it.`,
      });
      continue;
    }

    // 3 — a preference with no existing operation behind it.
    if (preference) {
      out.optional.push({
        row: proposal.row,
        writer: null,
        reason:
          "Optional: settings persistence. The proposer classed this column as a user preference rather than data the change needs. It is not part of the migration this change needs.",
      });
      continue;
    }

    out.core.push(proposal.row);
  }
  return out;
}
