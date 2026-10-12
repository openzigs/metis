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
 * THE RULE HERE decides by what a writer DOES and where the column sits. A
 * request bounded by an age or a date ("older than X") names a value. A writer
 * that filters the table it writes on a time column already takes such a value
 * as an argument (STRUCTURAL evidence, from the lineage). A column proposed on a
 * table that writer does NOT write may then be nothing but a copy of that bound:
 *
 *   - `core`     — appended to the affected tables. Always when a structural
 *                  writer writes the column's own table (the operation records
 *                  on its own table: `entries.read_at`), when the request asks to
 *                  RECORD it, or when the column cannot hold the bound at all (a
 *                  timestamp or a flag is not an age: `feeds.last_pruned_at`);
 *   - `optional` — "Optional: settings persistence". The request asks for the
 *                  value to be configurable, or the proposer itself called the
 *                  column a user preference. Shown, labelled, and never part of
 *                  the affected tables, so never part of "migration needed";
 *   - `rejected` — the column could hold the bound, sits on a table that write
 *                  path does not write, and nothing asks to record or configure
 *                  it. Returned with the writer and what was checked (#1051).
 *
 * WHAT THE GATE DOES NOT KNOW is whether that writer performs the REST of the
 * request, so it never rules a column out on that ground: a writer has a say
 * over a column only on the conditions above, and the reason says which checks
 * were made.
 *
 * THE PROPOSER'S STRUCTURED ANSWER IS AN INPUT, NOT AN AUTHORITY. A covering
 * writer it declares can move a proposal OUT of `core` and never in: it may rule
 * a column out (as a writer the lineage did not catch filtering on a time), but
 * the tables it writes shield nothing. Only lineage-derived writers do that, so
 * a declared writer on the proposal's own table changes nothing (the repro in
 * the PR #1090 review). For every answer A, `core(A)` is a subset of `core(A
 * without its declarations)`.
 *
 * FAIL-OPEN, AND SAID SO. With no lineage writer at all (none named, or
 * describing them threw) there is nothing to check against: the column passes to
 * `core` as before, and is ALSO returned under `unchecked` with the reason, so
 * the API, the page and the export can say the gate did not vet it.
 *
 * Pure — no I/O. Every pattern applied to request text is linear: the text is
 * accepted up to 500,000 characters (`createImpactAnalysisSchema`).
 */
import type { RequestGateText } from "./change-request.js";
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

/** A proposal with the gate's ruling on it. */
export interface GatedColumnProposal {
  row: AffectedTableInput;
  /** The write path the ruling rests on; null when it rests on none. */
  writer: CoveringWriterRef | null;
  reason: string;
}

export interface GatedProposals {
  core: AffectedTableInput[];
  optional: GatedColumnProposal[];
  rejected: GatedColumnProposal[];
  /**
   * The `core` rows the gate could NOT check, each with why. Every row here is
   * also in {@link core} — this marks columns, it never adds one.
   */
  unchecked: GatedColumnProposal[];
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

const TIME_UNIT = "seconds?|minutes?|hours?|days?|weeks?|months?|years?";

/**
 * Phrases that bound an operation by AGE or by a point in time: "older than X",
 * "older than 30 days", "before a given date", "in the last 7 days". The value in
 * such a phrase is an argument of the operation.
 *
 * Every repetition is bounded. The fifth pattern used to open with `\b\S+\s+`,
 * which restarts a greedy scan at every word boundary of a whitespace-free
 * token: 14 s on 160 KB (PR #1090 review). The prefix decided nothing — "90 days
 * old" matches without it.
 */
const TIME_BOUND_PATTERNS: readonly RegExp[] = [
  /\b(older|newer|earlier|later)\s{1,8}than\b/i,
  new RegExp(
    `\\b(more|less|longer|shorter)\\s{1,8}than\\s{1,8}(?:\\S{1,40}\\s{1,8}){0,2}?(${TIME_UNIT})\\b`,
    "i",
  ),
  /\b(before|after|since|until)\s{1,8}(?:an?\s{1,8}|the\s{1,8})?(?:given\s{1,8}|certain\s{1,8}|specific\s{1,8}|chosen\s{1,8})?(date|time|timestamp|day)\b/i,
  new RegExp(`\\b(last|past|within|every)\\s{1,8}(?:\\S{1,40}\\s{1,8})?(${TIME_UNIT})\\b`, "i"),
  new RegExp(`\\b(${TIME_UNIT})\\s{1,8}(old|ago)\\b`, "i"),
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
  /\b(settings?|preferences?|configur\w{0,12}|defaults?|remember\w{0,6}|customi[sz]\w{0,8}|per[- ]user)\b/i;

export function requestAsksToConfigure(requirementText: string): boolean {
  return SETTINGS_CUE.test(requirementText);
}

/**
 * Verbs that ask for NEW DATA to be kept: "record when it was pruned", "store
 * the reason", "track who did it", "must keep the last cleanup time", "save the
 * snooze date". `save` and `keep` are #1045's: the first cut of this gate
 * dropped them and they are back (PR #1090 panel). The nouns that share a
 * spelling are left out where they can be told apart: "lose track of", "keep
 * track of".
 */
const RECORD_CUE =
  /\b(record(?:s|ed|ing)?|stor(?:e|es|ed|ing)|sav(?:e|es|ed|ing)|keep(?:s|ing)?(?!\s{1,4}track\b)|kept|track(?:s|ed|ing)?(?!\s{1,4}of\b)|persist(?:s|ed|ing)?|audit(?:s|ed|ing)?)\b/i;

/** Column-name words that say nothing about WHAT is recorded. */
const GENERIC_COLUMN_WORDS: ReadonlySet<string> = new Set([
  "last",
  "time",
  "date",
  "day",
  "days",
  "count",
  "number",
  "total",
  "flag",
  "value",
  "the",
  "has",
  "was",
]);

/** `entries` → `entry`, `pruned` → `prun`, `snooze` → `snooz`: enough to compare. */
function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  const cut = w.replace(/(?:ing|ed|es|s|e)$/, "");
  return cut.length >= 3 ? cut : w;
}

function bareTable(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

/** The words a statement must share with a proposal to be ABOUT it. */
function proposalWords(row: AffectedTableInput): Set<string> {
  const words = new Set<string>([stem(bareTable(row.tableName))]);
  for (const part of (row.columnName ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 3 && !GENERIC_COLUMN_WORDS.has(part)) words.add(stem(part));
  }
  return words;
}

/**
 * True when one of `statements` asks to record something AND is about this
 * proposal: it holds a record verb and names the proposal's table or a word of
 * its column ("record on the FEED when it was last PRUNED" for
 * `feeds.last_pruned_at`). The statements are the request's primary statement
 * and its imperative sub-aspects only ({@link RequestGateText.statements}); a
 * verb in a context section is never read.
 */
export function requestAsksToRecord(
  statements: readonly string[],
  row: AffectedTableInput,
): boolean {
  const about = proposalWords(row);
  return statements.some((statement) => {
    if (!RECORD_CUE.test(statement)) return false;
    return (statement.toLowerCase().match(/[a-z0-9]+/g) ?? []).some((w) => about.has(stem(w)));
  });
}

// ── What a writer does ───────────────────────────────────────────────────────

/**
 * A column that holds a point in time, by the conventions column names follow.
 * Read on the snake_case form, so `publishedAt` (Prisma, TypeORM, Sequelize) is
 * `published_at`. A bare `_on` is a time only after a participle (`created_on`):
 * `turned_on` and `is_on` are flags.
 */
const TIME_COLUMN =
  /(^|_)(at|date|time|timestamp|until|since)$|(^|_)(created|updated|published|changed|modified|deleted|expired|started|ended|completed|closed|posted|refreshed|checked)_on$|^(created|updated|published|changed|modified|deleted|expires?|expired)(_|$)/;

/** `publishedAt` → `published_at`; `PUBLISHED_AT` → `published_at`. */
function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** True when a column name reads as a point in time. */
export function isTimeColumnName(name: string): boolean {
  return TIME_COLUMN.test(snakeCase(name));
}

/** A parameter typed as a time or a duration (`before time.Time`, `cutoff: Date`). */
const TIME_PARAMETER =
  /\b(time\.Time|time\.Duration|Date|DateTime|LocalDate\w{0,12}|OffsetDateTime|ZonedDateTime|Instant|Timestamp|Duration|datetime|timedelta)\b/;

function columnName(qualified: string): string {
  return qualified.slice(qualified.lastIndexOf(".") + 1);
}

/** The time-valued columns this writer filters its own table on. */
export function timePredicates(writer: DataPathWriterProfile): string[] {
  return writer.predicateColumns.filter((c) => isTimeColumnName(columnName(c)));
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

function timeParameter(writer: DataPathWriterProfile): string | undefined {
  return writer.parameters.find((p) => TIME_PARAMETER.test(p));
}

/**
 * What is known about how this writer takes the bound: its time filter and,
 * when the symbol text is stored, the argument. A writer with no time filter on
 * record is in the set only because the proposer named it, and the text says so.
 */
function coverage(writer: DataPathWriterProfile): string {
  const predicates = timePredicates(writer);
  if (predicates.length === 0) {
    return "was named by the proposer as already performing this request (the lineage records no time filter for it)";
  }
  const parameter = timeParameter(writer);
  const filters = `already filters ${predicates.join(", ")}`;
  return parameter ? `${filters} by its argument (${parameter})` : `${filters} by an argument`;
}

function writesTable(writer: DataPathWriterProfile, table: string): boolean {
  return writer.writeTables.some((t) => bareTable(t) === table);
}

/** A writer that may rule a proposal out. */
interface Ruler {
  writer: DataPathWriterProfile;
  /** Lineage-derived (true), or only declared by the proposer (false). */
  structural: boolean;
}

/**
 * The writer a ruling cites: the one with the most evidence, not the first in
 * list order. Lineage evidence before a declaration, a typed time argument
 * before none, then the lineage's own ranking of the writer for this request,
 * then the name (so the choice is stable).
 */
function bestRuler(rulers: readonly Ruler[]): DataPathWriterProfile {
  return [...rulers].sort(
    (a, b) =>
      Number(b.structural) - Number(a.structural) ||
      Number(timeParameter(b.writer) !== undefined) -
        Number(timeParameter(a.writer) !== undefined) ||
      b.writer.confidence - a.writer.confidence ||
      a.writer.qualifiedName.localeCompare(b.writer.qualifiedName),
  )[0]!.writer;
}

/**
 * True when a column of this type could hold the request's bound — an age, a
 * count of days, a list of options. A timestamp, a date or a flag cannot hold an
 * age, and a date column on another table ("snoozed until a chosen date") is as
 * likely the new state the request is about as a copy of an argument, so those
 * are never ruled out on type. An untyped proposal could be anything.
 */
export function canHoldBound(columnType: string | null): boolean {
  return !/^(timestamp|date|bool)/i.test((columnType ?? "").trim());
}

/** Why a column passed with nothing to check it against. */
export const NO_WRITERS_REASON =
  "Not checked: the SQL lineage named no write path for this request, so there was nothing to compare this column with. Review it as an unverified proposal.";

export interface GateColumnProposalsInput {
  /** What the request asks ({@link RequestGateText}); never its context sections. */
  request: RequestGateText;
  proposals: readonly ProposedColumn[];
  /** Writer ids the proposer listed as covering the request. */
  coveringWriterIds: readonly string[];
  /** Every writer the lineage named for this request, profiled. */
  writers: readonly DataPathWriterProfile[];
  /**
   * Set when {@link writers} is empty because describing them FAILED, not
   * because the lineage named none. Shown as the reason on `unchecked` rows.
   */
  writersUnavailableReason?: string | null;
}

/**
 * Sort each proposal into `core`, `optional` or `rejected`. See the module
 * header for the rule; in order, for one proposal on table T:
 *
 *   1. the request is bounded by an age or a date, no STRUCTURAL writer writes T,
 *      and a writer that takes such a bound exists (structural, or declared by
 *      the proposer and not itself writing T) →
 *        `optional` when the proposer called it a user preference;
 *        else, when the request asks to record it, on to 2;
 *        `optional` when the request asks to configure the value;
 *        `rejected` when the column could hold the bound;
 *        else on to 2 — that writer has no say over it;
 *   2. the proposer named a listed writer as covering THIS column → `rejected`;
 *   3. the proposer called it a user preference → `optional`;
 *   4. otherwise → `core`, and `unchecked` too when there was no writer at all.
 *
 * "No structural writer writes T" is the conservative reading on purpose: one
 * covering writer on an unrelated table must not cost a table its genuinely new
 * column.
 */
export function gateColumnProposals(input: GateColumnProposalsInput): GatedProposals {
  const timeBound = requestHasTimeBound(input.request.ask);
  const asksToConfigure = requestAsksToConfigure(input.request.ask);
  const writerById = new Map(input.writers.map((w) => [w.id, w]));
  const declaredIds = new Set(input.coveringWriterIds);

  const structural = timeBound ? input.writers.filter((w) => timePredicates(w).length > 0) : [];
  const structuralIds = new Set(structural.map((w) => w.id));
  // Declared-only writers. They can rule a column out; their tables shield none.
  const declared = timeBound
    ? input.writers.filter((w) => declaredIds.has(w.id) && !structuralIds.has(w.id))
    : [];
  const shielded = new Set(structural.flatMap((w) => w.writeTables.map(bareTable)));
  const out: GatedProposals = { core: [], optional: [], rejected: [], unchecked: [] };

  for (const proposal of input.proposals) {
    const table = bareTable(proposal.row.tableName);
    const preference = proposal.justification === "user-preference";

    // 1 — a column the bounded operation does not write.
    const rulers: Ruler[] = shielded.has(table)
      ? []
      : [
          ...structural.map((writer) => ({ writer, structural: true })),
          ...declared
            .filter((writer) => !writesTable(writer, table))
            .map((writer) => ({ writer, structural: false })),
        ];
    if (rulers.length > 0) {
      const writer = bestRuler(rulers);
      const asksToRecord = requestAsksToRecord(input.request.statements, proposal.row);
      if (preference || (!asksToRecord && asksToConfigure)) {
        const why = preference
          ? "the proposer classed this column as a user preference"
          : "the request asks for the value to be configurable";
        out.optional.push({
          row: proposal.row,
          writer: writerRef(writer),
          reason: `Optional: settings persistence. ${cite(writer)} ${coverage(writer)}, and ${why}, so this column would only remember a preferred value. It is not part of the migration this change needs.`,
        });
        continue;
      }
      if (!asksToRecord && canHoldBound(proposal.row.columnType)) {
        out.rejected.push({
          row: proposal.row,
          writer: writerRef(writer),
          reason: `An existing write path may cover this: the request is bounded by an age or a date, and ${cite(writer)} ${coverage(writer)}. This column could hold that bound, it is on a table that write path does not write, and the request does not ask to record or configure it. Checked: the request's wording, the write path's filter, and this column's table and type — not whether that write path performs the rest of the request.`,
        });
        continue;
      }
    }

    // 2 — the proposer contradicted itself.
    const selfCovered = proposal.coveredByWriterId
      ? writerById.get(proposal.coveredByWriterId)
      : undefined;
    if (selfCovered) {
      out.rejected.push({
        row: proposal.row,
        writer: writerRef(selfCovered),
        reason: `An existing write path covers this, by the proposer's own account: it named ${cite(selfCovered)} as already providing the value. Checked: the proposer's answer only.`,
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
    // 4b — fail-open, and said so: nothing existed to check this column against.
    if (input.writers.length === 0) {
      out.unchecked.push({
        row: proposal.row,
        writer: null,
        reason: input.writersUnavailableReason ?? NO_WRITERS_REASON,
      });
    }
  }
  return out;
}
