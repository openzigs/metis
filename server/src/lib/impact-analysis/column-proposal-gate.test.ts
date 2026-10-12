/**
 * #791 — the deterministic gate on proposed columns.
 *
 * The requirement is the VERBATIM run-7 #4478 issue (`__fixtures__/`), not a
 * condensed one: #1045's fixture was condensed, passed, and regressed 3 runs in
 * 3 in production. The proposals are the four columns the model actually
 * returned across runs 3 to 7. The writer is Miniflux v2.3.3's
 * `MarkAllAsReadBeforeDate`, profiled as the run-7 lineage records it.
 *
 * A verbatim fixture is not enough on its own, and neither is a probe of the one
 * field the last review named (PR #1090, reviews 1 and 2): the model's structured
 * answer broke the first cut, and its table, its column name and its type broke
 * the second, each while every existing test stayed green. The invariant — in a
 * covered request the model cannot produce a core column by any answer — is
 * therefore asserted over a product of every field the model chooses.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  changeFromRequest,
  parseChangeRequest,
  requestGateText,
  type RequestGateText,
} from "./change-request.js";
import {
  canHoldBound,
  coveringWriters,
  gateColumnProposals,
  isTimeColumnName,
  NO_TIME_BOUND_REASON,
  NO_WRITERS_REASON,
  noTimeFilterReason,
  normalizeProposerOutput,
  requestAsksToConfigure,
  requestHasTimeBound,
  timePredicates,
  type ColumnJustification,
  type ProposedColumn,
} from "./column-proposal-gate.js";
import type { DataPathWriterProfile } from "./data-path-writers.js";
import type { AffectedTableInput } from "./schema-impact.js";

const here = dirname(fileURLToPath(import.meta.url));
const ISSUE_4478 = readFileSync(join(here, "__fixtures__", "miniflux-4478.md"), "utf8");

/** Exactly what the engine hands the gate for a pasted issue. */
function issue(text: string): RequestGateText {
  return requestGateText(changeFromRequest(parseChangeRequest(text)!));
}
/** A one-requirement change, as the splitter produces it. */
function plain(text: string): RequestGateText {
  return requestGateText({ title: text, body: "" });
}
const REQUEST_4478 = issue(ISSUE_4478);

const ENTRY = "internal/storage/entry.go";

function writer(name: string, over: Partial<DataPathWriterProfile> = {}): DataPathWriterProfile {
  return {
    id: name,
    qualifiedName: `${ENTRY}::${name}`,
    filePath: ENTRY,
    startLine: 523,
    endLine: 533,
    confidence: 0.8,
    columns: ["entries.changed_at", "entries.status"],
    namesRequirementColumn: false,
    writeTables: ["entries"],
    predicateColumns: [],
    readColumns: [],
    signature: null,
    parameters: [],
    sql: null,
    ...over,
  };
}

const MARK_BEFORE_DATE = writer("MarkAllAsReadBeforeDate", {
  predicateColumns: ["entries.published_at", "entries.status", "entries.user_id"],
  signature: "func (s *Storage) MarkAllAsReadBeforeDate(userID int64, before time.Time) error",
  parameters: ["userID int64", "before time.Time"],
  sql: "UPDATE entries SET status=$1, changed_at=now() WHERE user_id=$2 AND status=$3 AND published_at < $4",
});
/** A status writer with no time predicate: `WHERE user_id=$2 AND id=ANY($3)`. */
const SET_STATUS = writer("SetEntriesStatus", {
  startLine: 412,
  predicateColumns: ["entries.id", "entries.user_id"],
  parameters: ["userID int64", "entryIDs []int64", "status string"],
});
/** A writer on `users` with no time predicate: the table the #4478 columns land on. */
const UPDATE_USER = writer("UpdateUser", {
  filePath: "internal/storage/user.go",
  qualifiedName: "internal/storage/user.go::UpdateUser",
  startLine: 180,
  columns: ["users.theme"],
  writeTables: ["users"],
  predicateColumns: ["users.id"],
  parameters: ["user *model.User"],
});

function proposal(
  tableName: string,
  columnName: string,
  columnType: string | null,
  justification: ColumnJustification | null = "operation-needs-new-data",
  coveredByWriterId: string | null = null,
): ProposedColumn {
  const row: AffectedTableInput = {
    objectKind: "column",
    tableName,
    columnName,
    columnType,
    changeKind: "add-column",
    suggestedDdl: `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType ?? "<type>"};`,
    source: "sqlglot",
    reconciliation: null,
    confidence: 0.5,
  };
  return { row, justification, coveredByWriterId, rationale: "" };
}

const gate = (
  request: RequestGateText | string,
  proposals: ProposedColumn[],
  writers: DataPathWriterProfile[] = [MARK_BEFORE_DATE, SET_STATUS],
  coveringWriterIds: string[] = [],
) =>
  gateColumnProposals({
    request: typeof request === "string" ? plain(request) : request,
    proposals,
    coveringWriterIds,
    writers,
  });

const names = (rows: { row: AffectedTableInput }[]) => rows.map((r) => r.row.columnName);

describe("what the verbatim #4478 request asks for (#791)", () => {
  it("is bounded by an age, and asks for the value to be configurable", () => {
    expect(requestHasTimeBound(REQUEST_4478.ask)).toBe(true);
    expect(requestAsksToConfigure(REQUEST_4478.ask)).toBe(true);
  });

  it("is read without its context sections", () => {
    // "What problem does this feature solve?" and "Alternatives Considered".
    expect(REQUEST_4478.ask).toContain("Times could be configured in settings.");
    expect(REQUEST_4478.ask).not.toContain("Right now you can either");
    expect(REQUEST_4478.ask).not.toContain("miniflux-sanity");
  });

  it("is covered: MarkAllAsReadBeforeDate filters entries.published_at", () => {
    expect(coveringWriters(REQUEST_4478, [MARK_BEFORE_DATE, SET_STATUS]).map((w) => w.id)).toEqual([
      "MarkAllAsReadBeforeDate",
    ]);
    // Not covered by a writer with no time filter, nor when the request has no bound.
    expect(coveringWriters(REQUEST_4478, [SET_STATUS, UPDATE_USER])).toEqual([]);
    expect(coveringWriters(plain("Add a dark theme."), [MARK_BEFORE_DATE])).toEqual([]);
  });
});

describe("gateColumnProposals — the verbatim #4478 request, the columns runs 3 to 7 proposed (#791)", () => {
  // Three runs, each with what the proposer returned that time (run 7: UI, re-run,
  // fresh POST), plus the run 3/4/6 name. Justified as the model justified them:
  // as data the operation needs.
  const RUNS: ProposedColumn[][] = [
    [proposal("users", "mark_read_time_options", "TEXT")],
    [proposal("users", "mark_read_delay", "INTEGER")],
    [
      proposal("users", "mark_read_times", "TEXT"),
      proposal("users", "mark_read_older_than_days", "INTEGER"),
    ],
  ];

  it("proposes no core users column in any of the three runs", () => {
    for (const proposals of RUNS) {
      expect(gate(REQUEST_4478, proposals).core).toEqual([]);
    }
  });

  it("routes every one of them to Optional: settings persistence, citing the writer", () => {
    for (const proposals of RUNS) {
      const result = gate(REQUEST_4478, proposals);
      expect(names(result.optional)).toEqual(proposals.map((p) => p.row.columnName));
      expect(result.rejected).toEqual([]);
      expect(result.unchecked).toEqual([]);
      for (const optional of result.optional) {
        expect(optional.writer).toEqual({
          qualifiedName: `${ENTRY}::MarkAllAsReadBeforeDate`,
          filePath: ENTRY,
          startLine: 523,
          endLine: 533,
        });
        expect(optional.reason).toMatch(/^Optional: settings persistence\./);
        expect(optional.reason).toContain(
          "MarkAllAsReadBeforeDate (internal/storage/entry.go:523)",
        );
        expect(optional.reason).toContain("already filters entries.published_at");
        expect(optional.reason).toContain("(before time.Time)");
        expect(optional.reason).toContain("the request asks for the value to be configurable");
        expect(optional.reason).toContain("not part of the migration");
      }
    }
  });

  it("holds when the stored symbol text is missing: the predicate alone covers it", () => {
    const untexted = {
      ...MARK_BEFORE_DATE,
      signature: null,
      parameters: [],
      sql: null,
    };
    const result = gate(
      REQUEST_4478,
      [proposal("users", "mark_read_delay", "INTEGER")],
      [untexted],
    );
    expect(result.core).toEqual([]);
    expect(result.optional[0]!.reason).toContain(
      "already filters entries.published_at by an argument",
    );
  });
});

/**
 * THE INVARIANT, swept. In a covered request the model cannot produce a core
 * column by any answer.
 *
 * Two reviews found a way from the model's answer, or from one ordinary sentence
 * in the request, to a core `users` column — each time through the field or the
 * wording the previous fix had not looked at. So this is a product over every
 * field the model chooses and every request variant the reviews used, not a
 * list of the cases that were reported.
 */
describe("gateColumnProposals — a covered request has no core column, whatever the model answers (#791, PR #1090 review 2)", () => {
  /** `sentence` appended to the body of the section under `heading`. */
  const inSection = (heading: string, sentence: string): string => {
    const marker = `### ${heading}\n\n`;
    const at = ISSUE_4478.indexOf(marker);
    if (at === -1) throw new Error(`no section "${heading}" in the fixture`);
    const bodyEnd = ISSUE_4478.indexOf("\n\n", at + marker.length);
    return `${ISSUE_4478.slice(0, bodyEnd)} ${sentence}${ISSUE_4478.slice(bodyEnd)}`;
  };
  const SECTIONS = [
    "Feature Summary",
    "What problem does this feature solve?",
    "Proposed Solution",
    "Alternatives Considered",
  ];
  /** Every sentence a review used to flip a column to core, cycle 1 and cycle 2. */
  const SENTENCES = [
    "I want to keep my read list tidy.",
    "This would save me from having to mark things as read by hand.",
    "It would save users a lot of clicks.",
    "This would save time when marking as read.",
    "The dropdown should keep the mark as read button usable.",
    "I lose track of what I have read.",
    "The tool keeps everything stored locally.",
    "It should also store the read delay for every user.",
    "It must record on the user when entries were last marked as read.",
    "Track and persist the mark read delay on users.",
  ];
  const REQUESTS: Array<readonly [label: string, request: RequestGateText]> = [
    ["verbatim #4478", REQUEST_4478],
    ["the title alone", plain("Mark all as read older than X")],
    [
      "#4478 minus the settings sentence",
      issue(ISSUE_4478.replace(" Times could be configured in settings.", "")),
    ],
    ...SENTENCES.flatMap((sentence) =>
      SECTIONS.map(
        (section) => [`"${sentence}" in ${section}`, issue(inSection(section, sentence))] as const,
      ),
    ),
    // …and each sentence as the whole of a one-requirement change.
    ...SENTENCES.map(
      (sentence) =>
        [
          `"${sentence}" after the title`,
          plain(`Mark all as read older than X. ${sentence}`),
        ] as const,
    ),
  ];

  // Everything the model chooses.
  const TABLES = ["users", "entries", "feeds", "user_entry_state", "public.users", "user_settings"];
  const TYPES = ["INTEGER", "TEXT", "TIMESTAMP", "DATE", "BOOLEAN", null, "", "TIMESTAMPTZ"];
  const COLUMN_NAMES = [
    "mark_read_delay",
    "mark_read_older_than_days",
    "mark_read_before",
    "auto_mark_read",
    // names made of words the request variants use
    "read_list_tidy",
    "saved_clicks",
    "settings",
    "users",
    "last_marked_read_at",
    // names that read as recorded state
    "last_cleanup_at",
    "snoozed_until",
    "read_at",
    "zzz_qqq",
  ];
  const JUSTIFICATIONS = [null, "operation-needs-new-data", "user-preference"] as const;
  /** The covering writer, a `users` writer, one the lineage never named, none. */
  const DECLARED = [null, "MarkAllAsReadBeforeDate", "UpdateUser", "no-such-writer"];
  const DECLARED_LISTS: string[][] = [
    [],
    ["MarkAllAsReadBeforeDate"],
    ["UpdateUser"],
    ["no-such-writer"],
    ["UpdateUser", "UpdateUser", "MarkAllAsReadBeforeDate", "no-such-writer"],
  ];
  const UNTEXTED = {
    ...MARK_BEFORE_DATE,
    signature: null,
    parameters: [],
    sql: null,
  };
  /** Writer sets that all hold a time-filtering writer: the request stays covered. */
  const COVERED_WRITER_SETS: DataPathWriterProfile[][] = [
    [MARK_BEFORE_DATE],
    [MARK_BEFORE_DATE, SET_STATUS],
    [SET_STATUS, UPDATE_USER, MARK_BEFORE_DATE],
    [UNTEXTED, UPDATE_USER],
  ];

  const ANSWERS: ProposedColumn[] = TABLES.flatMap((table) =>
    TYPES.flatMap((type) =>
      COLUMN_NAMES.flatMap((name) =>
        JUSTIFICATIONS.flatMap((justification) =>
          DECLARED.map((coveredBy) => proposal(table, name, type, justification, coveredBy)),
        ),
      ),
    ),
  );

  it("sweeps a real product of the model's fields, not a handful", () => {
    expect(REQUESTS.length).toBe(3 + SENTENCES.length * SECTIONS.length + SENTENCES.length);
    expect(ANSWERS.length).toBe(
      TABLES.length * TYPES.length * COLUMN_NAMES.length * JUSTIFICATIONS.length * DECLARED.length,
    );
    expect(ANSWERS.length).toBeGreaterThan(5000);
    // Every variant really differs from the fixture, and is still one issue.
    expect(new Set(REQUESTS.map(([, r]) => r.ask)).size).toBeGreaterThan(SENTENCES.length * 2);
  });

  it("core is empty in every combination, and nothing is passed unchecked", () => {
    const failures: string[] = [];
    let combinations = 0;
    for (const [label, request] of REQUESTS) {
      for (const writers of COVERED_WRITER_SETS) {
        for (const coveringWriterIds of DECLARED_LISTS) {
          const result = gateColumnProposals({
            request,
            proposals: ANSWERS,
            coveringWriterIds,
            writers,
          });
          combinations += ANSWERS.length;
          if (
            result.core.length > 0 ||
            result.unchecked.length > 0 ||
            result.optional.length + result.rejected.length !== ANSWERS.length
          ) {
            const first = result.core[0];
            failures.push(
              `${label} | writers ${writers.map((w) => w.id).join(",")} | declared [${coveringWriterIds.join(",")}]: ` +
                `${result.core.length} core, ${result.unchecked.length} unchecked` +
                (first
                  ? ` — first ${first.tableName}.${first.columnName} ${first.columnType ?? "<untyped>"}`
                  : ""),
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
    expect(combinations).toBeGreaterThan(1_000_000);
  });

  it("each proposal alone gets the ruling it gets in a batch, and one that cites the lineage writer", () => {
    // The batch above could hide a ruling that depends on a neighbour.
    for (const [, request] of REQUESTS.slice(0, 3)) {
      const batch = gate(request, ANSWERS, [MARK_BEFORE_DATE, SET_STATUS, UPDATE_USER]);
      const rejectedRows = new Set(batch.rejected.map((r) => r.row));
      for (const answer of ANSWERS.filter((_, i) => i % 37 === 0)) {
        const alone = gate(
          request,
          [answer],
          [MARK_BEFORE_DATE, SET_STATUS, UPDATE_USER],
          ["UpdateUser"],
        );
        expect(alone.core).toEqual([]);
        const ruled = [...alone.optional, ...alone.rejected];
        expect(ruled).toHaveLength(1);
        expect(alone.rejected.length === 1).toBe(rejectedRows.has(answer.row));
        expect(ruled[0]!.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
      }
    }
  });

  it("the sweep is not vacuous: the same answers ARE core once no writer filters on a time", () => {
    const result = gate(REQUEST_4478, ANSWERS, [SET_STATUS, UPDATE_USER]);
    expect(result.core).toHaveLength(ANSWERS.length);
    expect(result.unchecked).toHaveLength(ANSWERS.length);
    expect(result.optional).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("the review-2 repros, one by one", () => {
    const P = (table: string, name: string, type: string | null) => [proposal(table, name, type)];
    // N2 — one ordinary sentence with `save` or `keep`.
    for (const sentence of SENTENCES.slice(0, 5)) {
      for (const section of ["Feature Summary", "Proposed Solution"]) {
        const result = gate(
          issue(inSection(section, sentence)),
          P("users", "mark_read_delay", "INTEGER"),
        );
        expect(result.core, `${sentence} / ${section}`).toEqual([]);
      }
    }
    // N3 — without the settings sentence, the model's type decided.
    const noSettings = issue(ISSUE_4478.replace(" Times could be configured in settings.", ""));
    for (const [name, type] of [
      ["mark_read_before", "TIMESTAMP"],
      ["mark_read_before", "DATE"],
      ["auto_mark_read", "BOOLEAN"],
    ] as const) {
      expect(gate(noSettings, P("users", name, type)).core, `${name} ${type}`).toEqual([]);
      expect(
        gate("Mark all as read older than X", P("users", name, type)).core,
        `${name} ${type}, title alone`,
      ).toEqual([]);
    }
    // N4 — a copy of the bound on the covering writer's own table.
    expect(gate(REQUEST_4478, P("entries", "mark_read_older_than_days", "INTEGER")).core).toEqual(
      [],
    );
  });
});

describe("gateColumnProposals — optional or rejected, in a covered request (#791)", () => {
  const REQUEST = "Mark every entry older than 30 days as read.";

  it("rejects a column that restates the bound, with the writer and what was checked", () => {
    const result = gate(REQUEST, [proposal("users", "mark_read_older_than_days", "INTEGER")]);
    expect(result.core).toEqual([]);
    expect(result.optional).toEqual([]);
    expect(names(result.rejected)).toEqual(["mark_read_older_than_days"]);
    const [rejected] = result.rejected;
    expect(rejected!.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
    expect(rejected!.reason).toMatch(/^An existing write path may cover this/);
    expect(rejected!.reason).toContain("MarkAllAsReadBeforeDate (internal/storage/entry.go:523)");
    expect(rejected!.reason).toContain("already filters entries.published_at");
    expect(rejected!.reason).toContain("that write path's time filter");
    expect(rejected!.reason).toContain("not whether that write path performs the rest");
  });

  it("rejects an untyped column too: it could hold anything", () => {
    expect(names(gate(REQUEST, [proposal("users", "x", null)]).rejected)).toEqual(["x"]);
  });

  it("makes it optional when the proposer itself calls it a user preference", () => {
    const result = gate(REQUEST, [proposal("users", "default_days", "INTEGER", "user-preference")]);
    expect(result.rejected).toEqual([]);
    expect(names(result.optional)).toEqual(["default_days"]);
    expect(result.optional[0]!.reason).toContain("classed this column as a user preference");
  });

  it("makes it optional when the request asks for the value to be configurable", () => {
    const result = gate(`${REQUEST} The number of days should be a per-user setting.`, [
      proposal("users", "mark_read_days", "INTEGER"),
    ]);
    expect(names(result.optional)).toEqual(["mark_read_days"]);
    expect(result.optional[0]!.reason).toContain("asks for the value to be configurable");
  });

  it.each(["TIMESTAMP", "DATE", "BOOLEAN"])(
    "THE ACCEPTED COST — a genuinely new %s column is optional, not core, and says how to get it",
    (type) => {
      const result = gate(
        "Delete entries older than 30 days and record on the feed when it was last cleaned.",
        [proposal("feeds", "last_cleanup_at", type)],
      );
      expect(result.core).toEqual([]);
      expect(result.rejected).toEqual([]);
      expect(names(result.optional)).toEqual(["last_cleanup_at"]);
      const reason = result.optional[0]!.reason;
      expect(reason).toMatch(/^Optional: settings persistence\./);
      expect(reason).toContain("never added to the migration");
      expect(reason).toContain("write its ALTER TABLE statement in the request");
      // It must not claim a preference nobody stated.
      expect(reason).not.toContain("user preference");
      expect(reason).not.toContain("configurable");
    },
  );

  it("the record verbs decide nothing: with or without one, the same ruling", () => {
    for (const verb of ["save", "keep", "record", "store", "track", "persist", "audit"]) {
      const result = gate(
        `Delete entries older than 30 days and ${verb} the feed's cleanup date.`,
        [
          proposal("feeds", "cleanup_days", "INTEGER"),
          proposal("feeds", "last_cleanup_at", "TIMESTAMP"),
        ],
      );
      expect(result.core, verb).toEqual([]);
      expect(names(result.rejected), verb).toEqual(["cleanup_days"]);
      expect(names(result.optional), verb).toEqual(["last_cleanup_at"]);
    }
  });

  it("a column on the covering writer's own table is ruled like any other (#4336's read_at shape)", () => {
    const result = gate(REQUEST, [
      proposal("entries", "read_at", "TIMESTAMP"),
      proposal("entries", "mark_read_older_than_days", "INTEGER"),
    ]);
    expect(result.core).toEqual([]);
    expect(names(result.optional)).toEqual(["read_at"]);
    expect(names(result.rejected)).toEqual(["mark_read_older_than_days"]);
  });

  it("no ruling claims a table relation or a filter that was not checked", () => {
    const result = gate(REQUEST, [
      proposal("entries", "x_days", "INTEGER"),
      proposal("users", "y_days", "INTEGER", "user-preference"),
    ]);
    for (const ruled of [...result.rejected, ...result.optional]) {
      expect(ruled.reason).not.toContain("does not write");
      expect(ruled.reason).not.toContain("named by the proposer");
      expect(ruled.reason).not.toContain("the write path's filter");
    }
  });

  it("cites the writer with the evidence, not the first in list order", () => {
    const untyped = writer("AaaPurge", {
      predicateColumns: ["entries.created_at"],
      confidence: 0.9,
    });
    const result = gate(
      REQUEST,
      [proposal("users", "d", "INTEGER")],
      [untyped, SET_STATUS, MARK_BEFORE_DATE],
    );
    // A typed time argument outranks a higher lineage score and an earlier name.
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
  });

  it("between two writers with the same evidence, cites the one the lineage ranks higher", () => {
    const low = writer("AaaLow", {
      predicateColumns: ["entries.created_at"],
      confidence: 0.5,
    });
    const high = writer("ZzzHigh", {
      predicateColumns: ["entries.created_at"],
      confidence: 0.7,
    });
    const result = gate(REQUEST, [proposal("users", "d", "INTEGER")], [low, high]);
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::ZzzHigh`);
  });

  it("matches a camelCase predicate: a users column is not core on a Prisma project", () => {
    const prismaWriter = writer("markReadBefore", {
      writeTables: ["Entry"],
      predicateColumns: ["Entry.publishedAt"],
    });
    const result = gate(
      REQUEST_4478,
      [proposal("User", "markReadDelay", "INTEGER")],
      [prismaWriter],
    );
    expect(result.core).toEqual([]);
    expect(names(result.optional)).toEqual(["markReadDelay"]);
  });

  it("returns four empty lists for no proposals", () => {
    expect(gate(REQUEST_4478, [])).toEqual({
      core: [],
      optional: [],
      rejected: [],
      unchecked: [],
    });
  });
});

describe("gateColumnProposals — an uncovered request: core, and marked unchecked with a true reason (#791, PR #1090 review 2)", () => {
  const P = [
    proposal("users", "mark_read_delay", "INTEGER"),
    proposal("users", "theme", "TEXT", "user-preference"),
    proposal("feeds", "last_cleanup_at", "TIMESTAMP", null, "MarkAllAsReadBeforeDate"),
  ];
  const expectAllCoreUnchecked = (result: ReturnType<typeof gate>, reason: string) => {
    expect(result.core).toEqual(P.map((p) => p.row));
    expect(result.optional).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.unchecked).toEqual(P.map((p) => ({ row: p.row, writer: null, reason })));
  };

  it("the lineage named no writer at all", () => {
    expectAllCoreUnchecked(gate(REQUEST_4478, P, []), NO_WRITERS_REASON);
    expect(NO_WRITERS_REASON).toMatch(/^Not checked: the SQL lineage named no write path/);
  });

  it("the writers could not be looked up: the caller's reason is carried", () => {
    const result = gateColumnProposals({
      request: REQUEST_4478,
      proposals: P,
      writers: [],
      writersUnavailableReason: "Not checked: looking up the existing write paths failed.",
    });
    expectAllCoreUnchecked(result, "Not checked: looking up the existing write paths failed.");
  });

  it("writers are named and NONE filters on a time column (the review's [SetEntriesStatus, UpdateUser])", () => {
    const result = gate(REQUEST_4478, P, [SET_STATUS, UPDATE_USER]);
    expectAllCoreUnchecked(result, noTimeFilterReason(2));
    expect(noTimeFilterReason(2)).toBe(
      "Not checked: the request is bounded by an age or a date, but none of the 2 write paths the SQL lineage named for this request filters on a time column, so there was no existing operation to compare this column with. Review it as an unverified proposal.",
    );
    expect(noTimeFilterReason(1)).toContain("the one write path the SQL lineage named");
  });

  it("the request is not bounded by an age or a date (#4511)", () => {
    const result = gate("Store and return the last time a feed was successfully refreshed.", P, [
      MARK_BEFORE_DATE,
      SET_STATUS,
    ]);
    expectAllCoreUnchecked(result, NO_TIME_BOUND_REASON);
  });

  it("no reason claims a filter, a writer or a comparison that was not made", () => {
    for (const reason of [NO_WRITERS_REASON, NO_TIME_BOUND_REASON, noTimeFilterReason(3)]) {
      expect(reason).toMatch(/^Not checked: /);
      expect(reason).not.toContain("the write path's filter");
      expect(reason).not.toContain("Checked:");
      expect(reason).toContain("Review it as an unverified proposal.");
    }
  });

  it("nothing the proposer declares rules a column out here: the gate does not rule", () => {
    // A self-declared cover, a preference label and a declared list change nothing.
    const result = gate(
      "Add a dark theme.",
      P,
      [MARK_BEFORE_DATE, UPDATE_USER],
      ["MarkAllAsReadBeforeDate", "UpdateUser"],
    );
    expectAllCoreUnchecked(result, NO_TIME_BOUND_REASON);
  });
});
describe("requestHasTimeBound / timePredicates / canHoldBound (#791)", () => {
  it("recognises an age or a point in time as the bound of an operation", () => {
    for (const text of [
      "Mark all as read older than X",
      "delete sessions more than 30 days old",
      "delete sessions more than about 30 days",
      "archive entries before a given date",
      "show feeds refreshed in the last 7 days",
      "purge rows 90 days old",
      "purge what was read 2 weeks ago",
    ]) {
      expect(requestHasTimeBound(text), text).toBe(true);
    }
  });

  it("does not read ordinary wording as a time bound", () => {
    for (const text of [
      "Store and return the last time a feed was successfully refreshed",
      "Add a read_at timestamp to entries",
      "The feed shows 0 entries after marking the last page as read",
      "days of the old design",
    ]) {
      expect(requestHasTimeBound(text), text).toBe(false);
    }
  });

  it("reads a time predicate from the column's name, not from any column it filters on", () => {
    expect(timePredicates(MARK_BEFORE_DATE)).toEqual(["entries.published_at"]);
    expect(timePredicates(SET_STATUS)).toEqual([]);
    expect(
      timePredicates(
        writer("W", { predicateColumns: ["t.created_at", "t.expires", "t.category"] }),
      ),
    ).toEqual(["t.created_at", "t.expires"]);
  });

  it("recognises camelCase time columns (Prisma, TypeORM, Sequelize)", () => {
    for (const name of [
      "publishedAt",
      "createdAt",
      "expiresAt",
      "lastSeenDate",
      "createdOn",
      "CREATED_AT",
    ]) {
      expect(isTimeColumnName(name), name).toBe(true);
    }
    expect(
      timePredicates(writer("W", { predicateColumns: ["Entry.publishedAt", "Entry.userId"] })),
    ).toEqual(["Entry.publishedAt"]);
  });

  it("does not read a flag ending in `on` as a time", () => {
    for (const name of ["turned_on", "is_on", "turnedOn", "isOn", "status", "format", "category"]) {
      expect(isTimeColumnName(name), name).toBe(false);
    }
  });

  it("a timestamp, a date or a flag cannot hold an age; anything else, or no type, could", () => {
    expect(
      ["TIMESTAMP", "DATE", "BOOLEAN", " timestamp ", "TIMESTAMPTZ"].map(canHoldBound),
    ).toEqual([false, false, false, false, false]);
    expect(
      ["INTEGER", "BIGINT", "DECIMAL(10,2)", "TEXT", "VARCHAR(255)", null, ""].map(canHoldBound),
    ).toEqual([true, true, true, true, true, true, true]);
  });
});

describe("the gate end to end on 200 KB of request text (#791)", () => {
  // Pattern by pattern, every regex in this module is timed by
  // `request-regex-fuzz.test.ts`. This is the whole call, on the reviewer's input.
  it("rules in well under a second on a 200 KB dotted token", () => {
    const text = "a.".repeat(100_000);
    const start = performance.now();
    const result = gate(requestGateText({ title: "Mark all as read older than X", body: text }), [
      proposal("users", "mark_read_delay", "INTEGER"),
    ]);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.core).toEqual([]);
  });
});

describe("normalizeProposerOutput (#791)", () => {
  it("reads bare rows as unjustified proposals with no declared covering writer", () => {
    const { row } = proposal("users", "x", "TEXT");
    expect(normalizeProposerOutput([row])).toEqual({
      proposals: [{ row, justification: null, coveredByWriterId: null, rationale: "" }],
      coveringWriterIds: [],
    });
  });

  it("passes a structured answer through unchanged", () => {
    const structured = { proposals: [proposal("users", "x", "TEXT")], coveringWriterIds: ["W"] };
    expect(normalizeProposerOutput(structured)).toBe(structured);
  });
});
