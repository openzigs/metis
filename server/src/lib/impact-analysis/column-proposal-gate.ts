/**
 * #791 — the deterministic gate between the additive-column proposer and the
 * impact result.
 *
 * THE DEFECT. Miniflux #4478 asks to "mark all as read older than X". The code
 * that does it exists: `MarkAllAsReadBeforeDate(userID, before time.Time)`. The
 * proposer nevertheless kept answering with a new column on `users` to hold X —
 * `mark_read_older_than_days` (runs 3, 4, 6), then `mark_read_time_options`,
 * `mark_read_delay` and `mark_read_times` (run 7, 3 runs in 3). A prompt rule did
 * not hold (#1019), #1045's structural check decided coverage by NAME, and the
 * first two cuts of this gate decided by cue words in the request and by fields
 * the model chose (its table, its column name, its type, the writers it
 * declared). Each of those was one sentence or one answer away from a core
 * `users` column (PR #1090, reviews 1 and 2).
 *
 * THE RULE is monotone, and what makes a request covered is nothing the
 * proposer controls.
 *
 * A request is COVERED when it is bounded by an age or a date ("older than X")
 * AND at least one STRUCTURAL lineage writer filters the table it writes on a
 * time column. That writer already takes such a bound as an argument.
 *
 * INVARIANT. In a covered request NO FIELD A MODEL CHOSE can make a column core.
 * Whatever table, column name, type, justification or covering writer the
 * proposer returns, and whatever else the request says, each proposal is one of:
 *
 *   - `rejected` — it restates the bound: a column that could hold an age or a
 *                  count, which the proposer did not call a preference, in a
 *                  request that does not ask for the value to be configurable.
 *                  Returned with the covering writer and what was checked (#1051);
 *   - `optional` — everything else. "Optional: settings persistence", citing the
 *                  covering writer. Shown, labelled, and never part of the
 *                  affected tables, so never part of "migration needed".
 *
 * The settings cue, the proposer's justification and the column type choose
 * between those two and nothing else.
 *
 * WHERE CORE COMES FROM INSTEAD: what the USER wrote. `crossToSchema` reads the
 * ask before the proposer runs (`detectAdditiveColumnIntent`, `schema-impact.ts`)
 * and marks a table `add-column` on any of three forms: an
 * `ALTER TABLE … ADD COLUMN` statement, "add a <name> field|column|flag to
 * <table>", or "add <name> to <table>". It reads them in the primary request
 * AND in its sub-sections — and a heading the parser does not know is a
 * sub-section, so DDL pasted under "Workaround" counts as asked for. None of
 * that passes through this gate, and none of it is a model's answer.
 *
 * WHAT "COVERED" RESTS ON, AND ITS ONE LIMIT. This function decides it from the
 * request text and the writers it is handed. The engine hands it the writers of
 * EVERY table the schema crossing reached, looked up before the #936 relevance
 * filter (a model) sorts those tables into primary and secondary: the first
 * wiring scoped the lookup to the primary set, so one filter answer demoting
 * `entries` left #4478 uncovered and its `users` column core (PR #1090 review
 * 3). The #1029 recovery judge cannot reach the gate at all: it runs only when
 * no primary table is left, and then the proposer is not called. The limit:
 * which tables the crossing reaches follows from the SEEDS. By default those are
 * a search result; with `IMPACT_LLM_SEEDING` or `IMPACT_LLM_ENTITY_SEEDS` on, a
 * model ranks or adds them, and a seeding that never reaches the covering
 * writer's table leaves the request uncovered.
 * `impact-analysis-engine-791-llm-deps.test.ts` pins both halves at the engine
 * level.
 *
 * THE ACCEPTED COST. A genuinely new column in a covered request
 * (`feeds.last_cleanup_at` in "delete entries older than 30 days and record when
 * each feed was last cleaned") is shown as optional, not core. Optional columns
 * do not enter the affected tables, so they promote no edit candidate either.
 * The gate cannot tell that column from a copy of the bound without reading
 * intent out of prose, and reading intent out of prose is what failed twice.
 *
 * IN AN UNCOVERED REQUEST THE GATE DOES NOT RULE. A proposal is `core`, as it
 * was before this gate existed, and is ALSO returned under `unchecked` with the
 * reason nothing could be checked: describing the write paths failed, the
 * lineage named none, the request has no age or date bound, or none of the
 * named write paths filters on a time column. The API, the page and the export
 * say so.
 *
 * ONE DEMOTION SURVIVES THERE (owner decision, PR #1090 review 3). A column the
 * proposer ITSELF labels `user-preference` is `optional` in an uncovered request
 * too, with no writer cited and the same reason nothing was checked. Uncovered
 * is the common case (an ORM project whose writes the lineage cannot read, a
 * pre-#807 graph, a failed lookup), and "an optional, labelled settings column
 * is acceptable; a core `users` column is not" has to hold there as well. It is
 * a demotion and nothing else: the label can take a column OUT of core and
 * never put one in, so across both branches no label, declaration or type the
 * model returns ever increases `core`. `coveredByWriterId` and the declared
 * writer list are still not read.
 *
 * Pure — no I/O. Every pattern applied to request text is linear: the text is
 * accepted up to 500,000 characters (`createImpactAnalysisSchema`), and
 * `request-regex-fuzz.test.ts` times every pattern in this file.
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
   * also in {@link core} — this marks columns, it never adds one. (A column the
   * proposer labelled a preference is not here: it is in {@link optional}, and
   * its reason carries the same "not checked" sentence.)
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
 * in settings", "remember the chosen days per user", "a default". In a covered
 * request this only chooses between `optional` and `rejected` for a column that
 * could hold the bound; it can never produce `core`. "Option" is deliberately
 * absent: "gives people the option to" asks for a feature, not for a setting.
 */
const SETTINGS_CUE =
  /\b(settings?|preferences?|configur\w{0,12}|defaults?|remember\w{0,6}|customi[sz]\w{0,8}|per[- ]user)\b/i;

export function requestAsksToConfigure(requirementText: string): boolean {
  return SETTINGS_CUE.test(requirementText);
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

/** `MarkAllAsReadBeforeDate` out of `internal/storage/entry.go::Storage::MarkAllAsReadBeforeDate`. */
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
 * How this writer takes the bound: its time filter and, when the symbol text is
 * stored, the argument. Only ever called for a writer with a time filter.
 */
function coverage(writer: DataPathWriterProfile): string {
  const parameter = timeParameter(writer);
  const filters = `already filters ${timePredicates(writer).join(", ")}`;
  return parameter ? `${filters} by its argument (${parameter})` : `${filters} by an argument`;
}

/**
 * The covering writer a ruling cites: the one with the most evidence, not the
 * first in list order. A typed time argument before none, then the lineage's own
 * ranking of the writer for this request, then the name (so the choice is
 * stable).
 */
function bestCoveringWriter(covering: readonly DataPathWriterProfile[]): DataPathWriterProfile {
  return [...covering].sort(
    (a, b) =>
      Number(timeParameter(b) !== undefined) - Number(timeParameter(a) !== undefined) ||
      b.confidence - a.confidence ||
      a.qualifiedName.localeCompare(b.qualifiedName),
  )[0]!;
}

/**
 * True when a column of this type could hold an age, a count of days or a list
 * of options — the shapes a copy of the bound takes. Decides `rejected` versus
 * `optional` in a covered request and nothing else: the type is the model's
 * choice, so it must never decide `core`. An untyped proposal could be anything.
 */
export function canHoldBound(columnType: string | null): boolean {
  return !/^(timestamp|date|bool)/i.test((columnType ?? "").trim());
}

/**
 * Why a column passed with nothing to check it against. "On the tables this
 * analysis reached": the lookup is asked about those tables and no others, so
 * it must not claim more (it once read "for this request" while the table that
 * had the write path had not been asked about — PR #1090 review 3).
 */
export const NO_WRITERS_REASON =
  "Not checked: the SQL lineage named no write path on the tables this analysis reached for the request, so there was nothing to compare this column with. Review it as an unverified proposal.";

/**
 * The ruling on a column the proposer labelled a preference in a request the
 * gate could not check: optional, and `notChecked` says why nothing was checked.
 */
export function uncheckedPreferenceReason(notChecked: string): string {
  return `Optional: settings persistence. The proposer classed this column as a user preference, so it would only remember a preferred value and is not part of the migration this change needs. ${notChecked}`;
}

/** Why a column passed in a request the gate has no rule for. */
export const NO_TIME_BOUND_REASON =
  "Not checked: the request is not bounded by an age or a date, and that is the only kind of request this check rules on. Review it as an unverified proposal.";

/** Why a column passed when the lineage named write paths and none could cover the bound. */
export function noTimeFilterReason(writerCount: number): string {
  const paths =
    writerCount === 1
      ? "the one write path the SQL lineage named for this request does not filter"
      : `none of the ${writerCount} write paths the SQL lineage named for this request filters`;
  return `Not checked: the request is bounded by an age or a date, but ${paths} on a time column, so there was no existing operation to compare this column with. Review it as an unverified proposal.`;
}

export interface GateColumnProposalsInput {
  /** What the request asks ({@link RequestGateText}); never its context sections. */
  request: RequestGateText;
  /**
   * The proposer's columns. Of each, the gate reads `row.columnType` and
   * `justification`: in a covered request only to choose between `optional` and
   * `rejected`, in an uncovered one only to demote a `user-preference` column
   * from `core` to `optional`. Neither can add to `core`.
   * `coveredByWriterId` and the proposer's list of covering writers are NOT
   * read: nothing the model declares changes whether a request is covered.
   */
  proposals: readonly ProposedColumn[];
  /**
   * Writer ids the proposer listed as covering the request. Accepted so the
   * model's whole answer passes through here (and through the sweep in
   * `column-proposal-gate.test.ts`), and deliberately never read.
   */
  coveringWriterIds?: readonly string[];
  /**
   * Every writer the lineage named on the tables the crossing reached, profiled.
   * The caller must NOT narrow this by anything a model chose (the engine looks
   * it up before the #936 relevance filter is applied).
   */
  writers: readonly DataPathWriterProfile[];
  /**
   * Set when {@link writers} is empty because describing them FAILED, not
   * because the lineage named none. Shown as the reason on `unchecked` rows.
   */
  writersUnavailableReason?: string | null;
}

/**
 * The lineage writers that make a request covered: empty unless the request is
 * bounded by an age or a date, then every writer that filters on a time column.
 */
export function coveringWriters(
  request: RequestGateText,
  writers: readonly DataPathWriterProfile[],
): DataPathWriterProfile[] {
  if (!requestHasTimeBound(request.ask)) return [];
  return writers.filter((w) => timePredicates(w).length > 0);
}

/**
 * Sort each proposal. See the module header for the rule and its invariant.
 *
 *   covered request   → `rejected` when the column restates the bound, else
 *                       `optional`. Never `core`.
 *   uncovered request → `optional` when the proposer labelled the column a
 *                       preference; else `core`, and `unchecked` with the reason.
 */
export function gateColumnProposals(input: GateColumnProposalsInput): GatedProposals {
  const out: GatedProposals = { core: [], optional: [], rejected: [], unchecked: [] };
  const covering = coveringWriters(input.request, input.writers);

  if (covering.length === 0) {
    const reason =
      input.writersUnavailableReason ??
      (input.writers.length === 0
        ? NO_WRITERS_REASON
        : requestHasTimeBound(input.request.ask)
          ? noTimeFilterReason(input.writers.length)
          : NO_TIME_BOUND_REASON);
    for (const proposal of input.proposals) {
      // Demotion only, and only on the proposer's own label: see the header.
      if (proposal.justification === "user-preference") {
        out.optional.push({
          row: proposal.row,
          writer: null,
          reason: uncheckedPreferenceReason(reason),
        });
        continue;
      }
      out.core.push(proposal.row);
      out.unchecked.push({ row: proposal.row, writer: null, reason });
    }
    return out;
  }

  const writer = bestCoveringWriter(covering);
  const covers = `${cite(writer)} ${coverage(writer)}`;
  const asksToConfigure = requestAsksToConfigure(input.request.ask);
  for (const proposal of input.proposals) {
    const preference = proposal.justification === "user-preference";
    if (!preference && !asksToConfigure && canHoldBound(proposal.row.columnType)) {
      out.rejected.push({
        row: proposal.row,
        writer: writerRef(writer),
        reason: `An existing write path may cover this: the request is bounded by an age or a date, and ${covers}. This column could hold that bound, and the request does not ask for the value to be configurable. Checked: the request's wording, that write path's time filter, and this column's type — not whether that write path performs the rest of the request.`,
      });
      continue;
    }
    const why = preference
      ? "the proposer classed this column as a user preference, so it would only remember a preferred value"
      : asksToConfigure
        ? "the request asks for the value to be configurable, so this column would only remember a preferred value"
        : "a column the model proposes is never added to the migration of a request an existing write path may already cover";
    out.optional.push({
      row: proposal.row,
      writer: writerRef(writer),
      reason: `Optional: settings persistence. ${covers}, and ${why}. It is not part of the migration this change needs; if the change does need this column, write its ALTER TABLE statement in the request.`,
    });
  }
  return out;
}
