/**
 * #791 — the deterministic gate on proposed columns.
 *
 * The requirement is the VERBATIM run-7 #4478 issue (`__fixtures__/`), not a
 * condensed one: #1045's fixture was condensed, passed, and regressed 3 runs in
 * 3 in production. The proposals are the four columns the model actually
 * returned across runs 3 to 7. The writer is Miniflux v2.3.3's
 * `MarkAllAsReadBeforeDate`, profiled as the run-7 lineage records it.
 *
 * A verbatim fixture is not enough on its own (PR #1090 review): the gate is
 * also probed with the model's own structured answer as an adversarial input,
 * and with one incidental cue word added to a context section of the fixture.
 * Both broke the first cut of this gate while every verbatim test stayed green.
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
  gateColumnProposals,
  isTimeColumnName,
  NO_WRITERS_REASON,
  normalizeProposerOutput,
  requestAsksToConfigure,
  requestAsksToRecord,
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
const coreNames = (result: { core: AffectedTableInput[] }) => result.core.map((r) => r.columnName);

describe("what the verbatim #4478 request asks for (#791)", () => {
  it("is bounded by an age", () => {
    expect(requestHasTimeBound(REQUEST_4478.ask)).toBe(true);
  });

  it("asks to configure the value, and does not ask to record anything", () => {
    expect(requestAsksToConfigure(REQUEST_4478.ask)).toBe(true);
    expect(
      requestAsksToRecord(
        REQUEST_4478.statements,
        proposal("users", "mark_read_delay", "INTEGER").row,
      ),
    ).toBe(false);
  });

  it("is read without its context sections", () => {
    // "What problem does this feature solve?" and "Alternatives Considered".
    expect(REQUEST_4478.ask).toContain("Times could be configured in settings.");
    expect(REQUEST_4478.ask).not.toContain("Right now you can either");
    expect(REQUEST_4478.ask).not.toContain("miniflux-sanity");
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

  it("does not depend on what the column is called — the #1045 defect", () => {
    // A name that shares no word with the writer or the request.
    const result = gate(REQUEST_4478, [proposal("users", "zzz_qqq", "INTEGER")]);
    expect(result.core).toEqual([]);
    expect(names(result.optional)).toEqual(["zzz_qqq"]);
  });

  it("holds when the stored symbol text is missing: the predicate alone covers it", () => {
    const untexted = { ...MARK_BEFORE_DATE, signature: null, parameters: [], sql: null };
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

describe("gateColumnProposals — the model's own answer as an adversarial input (#791, PR #1090 review)", () => {
  const WRITERS = [MARK_BEFORE_DATE, SET_STATUS, UPDATE_USER];

  it("a declared writer on the proposal's OWN table does not move it into core (the review repro)", () => {
    // Verbatim #4478, the MarkAllAsReadBeforeDate profile, one extra listed writer
    // that writes `users`. Declaring it used to make `users` a covered table.
    const without = gate(
      REQUEST_4478,
      [proposal("users", "mark_read_delay", "INTEGER", null)],
      WRITERS,
    );
    const withIt = gate(
      REQUEST_4478,
      [proposal("users", "mark_read_delay", "INTEGER", null)],
      WRITERS,
      ["UpdateUser"],
    );
    expect(without.core).toEqual([]);
    expect(withIt.core).toEqual([]);
    expect(names(withIt.optional)).toEqual(["mark_read_delay"]);
    // And the writer it is set against is still the lineage one, not the declared one.
    expect(withIt.optional[0]!.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
  });

  it("no structured answer makes #4478 a core users column: every type, label, coveredBy and declared set", () => {
    const types = [
      "INTEGER",
      "BIGINT",
      "TEXT",
      "VARCHAR(255)",
      "TIMESTAMP",
      "DATE",
      "BOOLEAN",
      null,
    ];
    const labels = [null, "operation-needs-new-data", "user-preference"] as const;
    const coveredBy = [null, "UpdateUser", "MarkAllAsReadBeforeDate", "no-such-writer"];
    const declaredSets = [
      [],
      ["UpdateUser"],
      ["no-such-writer"],
      ["UpdateUser", "UpdateUser", "UpdateUser"],
      ["MarkAllAsReadBeforeDate", "UpdateUser", "SetEntriesStatus", "no-such-writer"],
    ];
    let checked = 0;
    for (const type of types) {
      for (const label of labels) {
        for (const covered of coveredBy) {
          for (const declared of declaredSets) {
            const result = gate(
              REQUEST_4478,
              [proposal("users", "mark_read_delay", type, label, covered)],
              WRITERS,
              declared,
            );
            expect(result.core, JSON.stringify({ type, label, covered, declared })).toEqual([]);
            expect(result.optional.length + result.rejected.length).toBe(1);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(8 * 3 * 4 * 5);
  });

  it("a declaration only ever takes columns OUT of core, whatever it names", () => {
    const requests = [
      REQUEST_4478,
      plain("Mark all as read older than X."),
      plain("Delete entries older than 30 days and show the last cleanup time on each feed."),
      plain("Let a user star every entry of a feed at once."),
    ];
    const proposals = [
      proposal("users", "mark_read_delay", "INTEGER"),
      proposal("users", "theme_accent", "TEXT"),
      proposal("entries", "read_at", "TIMESTAMP"),
      proposal("entries", "read_count", "INTEGER"),
      proposal("feeds", "last_cleanup_at", "TIMESTAMP"),
      proposal("feeds", "retention_days", "INTEGER"),
    ];
    const declaredSets = [
      ["UpdateUser"],
      ["SetEntriesStatus"],
      ["SetEntriesStatus", "UpdateUser"],
      ["MarkAllAsReadBeforeDate"],
      ["UpdateUser", "UpdateUser"],
      ["ghost", "UpdateUser", "SetEntriesStatus", "MarkAllAsReadBeforeDate"],
    ];
    for (const request of requests) {
      for (const writers of [WRITERS, [SET_STATUS, UPDATE_USER]]) {
        const floor = new Set(coreNames(gate(request, proposals, writers, [])));
        for (const declared of declaredSets) {
          for (const column of coreNames(gate(request, proposals, writers, declared))) {
            expect(floor.has(column), `${column} with ${declared.join(",")}`).toBe(true);
          }
        }
      }
    }
  });

  it("a duplicated or unknown declared id is the same as declaring it once, or not at all", () => {
    const bare = plain("Mark all as read older than X.");
    const proposals = [proposal("users", "mark_read_delay", "INTEGER")];
    const writers = [SET_STATUS, UPDATE_USER];
    const once = gate(bare, proposals, writers, ["SetEntriesStatus"]);
    expect(gate(bare, proposals, writers, Array(5).fill("SetEntriesStatus"))).toEqual(once);
    expect(gate(bare, proposals, writers, ["ghost", "", "__proto__"])).toEqual(
      gate(bare, proposals, writers, []),
    );
  });
});

describe("gateColumnProposals — an incidental cue word in a context section (#791, PR #1090 review)", () => {
  const P = [proposal("users", "mark_read_delay", "INTEGER")];
  const inProblem = (sentence: string) =>
    ISSUE_4478.replace("24 hours, 1 week, 1 month", `24 hours, 1 week, 1 month. ${sentence}`);
  const inAlternatives = (sentence: string) =>
    ISSUE_4478.replace("be better in the UI", `be better in the UI. ${sentence}`);
  const inSolution = (sentence: string) =>
    ISSUE_4478.replace("configured in settings.", `configured in settings. ${sentence}`);

  it.each([
    ["the review repro, a noun", inProblem("I lose track of what I have read.")],
    [
      "the review repro, an alternative",
      inAlternatives("The tool keeps everything stored locally."),
    ],
    [
      "a verb about this very column, in the problem",
      inProblem("It should track what each user has read."),
    ],
    [
      "a verb about this very column, in an alternative",
      inAlternatives("That tool stores a read delay for every user."),
    ],
  ])("stays optional with %s", (_label, text) => {
    expect(text).not.toBe(ISSUE_4478);
    const result = gate(issue(text), P);
    expect(result.core).toEqual([]);
    expect(names(result.optional)).toEqual(["mark_read_delay"]);
  });

  it("does read the same sentence when the request itself makes it, as an instruction", () => {
    const result = gate(
      issue(inSolution("It should also store the read delay for every user.")),
      P,
    );
    expect(coreNames(result)).toEqual(["mark_read_delay"]);
  });

  it("does not read a sub-aspect sentence that only describes", () => {
    const result = gate(issue(inSolution("The old tool stores a read delay for every user.")), P);
    expect(result.core).toEqual([]);
  });

  it("needs the statement to be about the proposal, not only to hold a verb", () => {
    const result = gate(issue(inSolution("It should also keep the dropdown small.")), P);
    expect(result.core).toEqual([]);
  });
});

describe("gateColumnProposals — rejected, when nothing asks to store the value (#791)", () => {
  // The same request without its "configured in settings" sentence.
  const BARE =
    "Mark all as read older than X. This gives people the option to just let things that are older than X days be marked as read.";

  it("rejects the column with the writer, and a reason that says what was checked", () => {
    const result = gate(BARE, [proposal("users", "mark_read_delay", "INTEGER")]);
    expect(result.core).toEqual([]);
    expect(result.optional).toEqual([]);
    expect(names(result.rejected)).toEqual(["mark_read_delay"]);
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
    const { reason } = result.rejected[0]!;
    expect(reason).toMatch(/^An existing write path may cover this:/);
    expect(reason).toContain("MarkAllAsReadBeforeDate (internal/storage/entry.go:523)");
    expect(reason).toContain("already filters entries.published_at by its argument");
    expect(reason).toContain("Checked: the request's wording, the write path's filter");
    expect(reason).toContain("not whether that write path performs the rest of the request");
    // The claim the first cut made and could not support.
    expect(reason).not.toContain("an argument of that call");
  });

  it("rejects an untyped column too: it could hold anything", () => {
    const result = gate(BARE, [proposal("users", "mark_read_delay", null)]);
    expect(names(result.rejected)).toEqual(["mark_read_delay"]);
  });

  it("still makes it optional when the proposer itself calls it a user preference", () => {
    const result = gate(BARE, [proposal("users", "mark_read_delay", "INTEGER", "user-preference")]);
    expect(names(result.optional)).toEqual(["mark_read_delay"]);
    expect(result.optional[0]!.reason).toContain(
      "the proposer classed this column as a user preference",
    );
    expect(result.rejected).toEqual([]);
  });
});

describe("gateColumnProposals — a new column on a table the bounded writer does not write (#791, PR #1090 review)", () => {
  it.each([
    // The reviewer's two repros.
    [
      "Delete entries older than 30 days and show the last cleanup time on each feed.",
      proposal("feeds", "last_cleanup_at", "TIMESTAMP"),
    ],
    [
      "A user can snooze an entry until a chosen date, and it comes back unread on that day.",
      proposal("user_entry_state", "snoozed_until", "TIMESTAMP"),
    ],
    // The panel's wordings: none of the five verbs the first cut needed.
    [
      "Delete entries older than 30 days. Each feed should show when it was last pruned.",
      proposal("feeds", "last_pruned_at", "TIMESTAMP"),
    ],
    [
      "Delete entries older than 30 days. A feed must keep the time it was last pruned.",
      proposal("feeds", "last_pruned_at", "TIMESTAMP"),
    ],
    ["Archive entries before a given date.", proposal("feeds", "has_archive", "BOOLEAN")],
  ])("%s → not rejected", (text, p) => {
    expect(requestHasTimeBound(text)).toBe(true);
    const result = gate(text, [p]);
    expect(result.rejected).toEqual([]);
    expect(result.optional).toEqual([]);
    expect(coreNames(result)).toEqual([p.row.columnName]);
  });

  it.each(["save", "keep", "record", "store", "track", "persist", "audit"])(
    "accepts '%s' as a request to record, even for a column that could hold the bound",
    (verb) => {
      const text = `Delete entries older than 30 days, and ${verb} the prune reason on the feed.`;
      const result = gate(text, [proposal("feeds", "prune_reason", "TEXT")]);
      expect(coreNames(result)).toEqual(["prune_reason"]);
      expect(result.rejected).toEqual([]);
    },
  );

  it("without such a verb, that same column is ruled out", () => {
    const result = gate("Delete entries older than 30 days.", [
      proposal("feeds", "prune_reason", "TEXT"),
    ]);
    expect(names(result.rejected)).toEqual(["prune_reason"]);
  });

  it("cites the writer with the evidence, not the first in list order", () => {
    // No stored text and a lower lineage rank, listed FIRST.
    const weak = writer("PurgeOld", {
      startLine: 900,
      confidence: 0.5,
      predicateColumns: ["entries.created_at"],
    });
    for (const writers of [
      [weak, MARK_BEFORE_DATE],
      [MARK_BEFORE_DATE, weak],
    ]) {
      const result = gate(
        "Mark all as read older than X.",
        [proposal("users", "mark_read_delay", "INTEGER")],
        writers,
      );
      expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
      expect(result.rejected[0]!.reason).toContain("MarkAllAsReadBeforeDate");
      expect(result.rejected[0]!.reason).not.toContain("PurgeOld");
    }
  });

  it("between two writers with the same evidence, cites the one the lineage ranks higher", () => {
    const low = writer("Aaa", { confidence: 0.5, predicateColumns: ["entries.created_at"] });
    const high = writer("Zzz", { confidence: 0.9, predicateColumns: ["entries.created_at"] });
    const result = gate(
      "Mark all as read older than X.",
      [proposal("users", "mark_read_delay", "INTEGER")],
      [low, high],
    );
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::Zzz`);
  });
});

describe("gateColumnProposals — what stays a core migration (#791)", () => {
  it("keeps a column on the table the covering writer writes (#4336 read_at)", () => {
    // Time-bounded wording AND a time-predicate writer, and still core: the
    // operation records this on its own table.
    const text = "Set read_at when an entry is marked read, including entries older than 30 days.";
    const result = gate(text, [proposal("entries", "read_at", "TIMESTAMP")]);
    expect(coreNames(result)).toEqual(["read_at"]);
    expect(result.optional).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("keeps a column on the writer's own table even when it could hold the bound", () => {
    const result = gate("Archive entries older than 30 days.", [
      proposal("entries", "archived_reason", "TEXT"),
    ]);
    expect(coreNames(result)).toEqual(["archived_reason"]);
  });

  it("keeps a column on another table when the request asks to RECORD something", () => {
    const text =
      "Delete entries older than 30 days, and record on the feed when it was last pruned.";
    const result = gate(text, [proposal("feeds", "last_pruned", null)]);
    expect(coreNames(result)).toEqual(["last_pruned"]);
  });

  it("keeps everything when the request is not bounded by a time (#4511)", () => {
    const text =
      "Store and return the last time a feed was successfully refreshed. Add a Last Successful Refresh parameter to the Feed API.";
    expect(requestHasTimeBound(text)).toBe(false);
    const result = gate(text, [proposal("feeds", "last_successful_refresh_at", "TIMESTAMP")]);
    expect(coreNames(result)).toEqual(["last_successful_refresh_at"]);
  });

  it("keeps everything when no writer filters on a time column — checked, so not marked", () => {
    const result = gate(
      REQUEST_4478,
      [proposal("users", "mark_read_delay", "INTEGER")],
      [SET_STATUS],
    );
    expect(coreNames(result)).toEqual(["mark_read_delay"]);
    expect(result.unchecked).toEqual([]);
  });

  it("one covering writer on an unrelated table does not cost a table its new column", () => {
    const feedPruner = writer("PruneFeeds", {
      writeTables: ["feeds"],
      predicateColumns: ["feeds.checked_at"],
    });
    // `entries` IS written by a covering writer, so the column is not outside.
    const result = gate(
      "Archive entries older than 30 days.",
      [proposal("entries", "archived_reason", "TEXT")],
      [MARK_BEFORE_DATE, feedPruner],
    );
    expect(coreNames(result)).toEqual(["archived_reason"]);
  });

  it("matches a schema-qualified table to the writer's table", () => {
    const result = gate("Mark entries older than 30 days as read.", [
      proposal("public.entries", "read_count", "INTEGER"),
    ]);
    expect(coreNames(result)).toEqual(["read_count"]);
  });
});

describe("gateColumnProposals — fail-open, and marked (#791, PR #1090 review)", () => {
  const P = [proposal("users", "mark_read_delay", "INTEGER")];

  it("passes a column when the lineage named no writer at all, and marks it unchecked", () => {
    const result = gate(REQUEST_4478, P, []);
    expect(coreNames(result)).toEqual(["mark_read_delay"]);
    expect(result.unchecked).toEqual([{ row: P[0]!.row, writer: null, reason: NO_WRITERS_REASON }]);
    expect(NO_WRITERS_REASON).toMatch(/^Not checked: the SQL lineage named no write path/);
  });

  it("carries the caller's reason when the writers could not be looked up", () => {
    const result = gateColumnProposals({
      request: REQUEST_4478,
      proposals: P,
      coveringWriterIds: [],
      writers: [],
      writersUnavailableReason: "Not checked: the lookup failed.",
    });
    expect(coreNames(result)).toEqual(["mark_read_delay"]);
    expect(result.unchecked.map((u) => u.reason)).toEqual(["Not checked: the lookup failed."]);
  });

  it("does not mark a column it ruled on, with or without writers", () => {
    const preference = [proposal("users", "theme_accent", "TEXT", "user-preference")];
    const none = gate(REQUEST_4478, preference, []);
    expect(none.core).toEqual([]);
    expect(none.unchecked).toEqual([]);
    expect(names(none.optional)).toEqual(["theme_accent"]);
    expect(gate(REQUEST_4478, P).unchecked).toEqual([]);
  });
});

describe("gateColumnProposals — the proposer's structured answer (#791)", () => {
  const NO_TIME = "Let a user star every entry of a feed at once.";
  const BOUNDED = "Mark all as read older than X.";

  it("rejects a column the proposer says a listed writer already covers", () => {
    const result = gate(NO_TIME, [
      proposal("entries", "starred_all", "BOOLEAN", "operation-needs-new-data", "SetEntriesStatus"),
    ]);
    expect(result.core).toEqual([]);
    expect(names(result.rejected)).toEqual(["starred_all"]);
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::SetEntriesStatus`);
    expect(result.rejected[0]!.reason).toContain("by the proposer's own account");
    expect(result.rejected[0]!.reason).toContain(
      "SetEntriesStatus (internal/storage/entry.go:412)",
    );
    expect(result.rejected[0]!.reason).toContain("Checked: the proposer's answer only");
  });

  it("ignores a coveredBy that names no listed writer — it cannot invent one", () => {
    const result = gate(NO_TIME, [
      proposal("entries", "starred_all", "BOOLEAN", "operation-needs-new-data", "Nope"),
    ]);
    expect(coreNames(result)).toEqual(["starred_all"]);
  });

  it("a declared writer rules a column out when the lineage caught no time filter", () => {
    // Bounded request, no time predicate on record anywhere: without the
    // declaration nothing takes the bound, and the column is core.
    const p = [proposal("users", "mark_read_delay", "INTEGER")];
    expect(coreNames(gate(BOUNDED, p, [SET_STATUS]))).toEqual(["mark_read_delay"]);
    const result = gate(BOUNDED, p, [SET_STATUS], ["SetEntriesStatus"]);
    expect(result.core).toEqual([]);
    expect(names(result.rejected)).toEqual(["mark_read_delay"]);
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::SetEntriesStatus`);
    // The reason says the evidence is the proposer's word, not the lineage.
    expect(result.rejected[0]!.reason).toContain(
      "was named by the proposer as already performing this request",
    );
    expect(result.rejected[0]!.reason).toContain("the lineage records no time filter for it");
  });

  it("a declared writer has no say over a column on a table it writes itself", () => {
    const result = gate(
      BOUNDED,
      [proposal("entries", "read_count", "INTEGER")],
      [SET_STATUS],
      ["SetEntriesStatus"],
    );
    expect(coreNames(result)).toEqual(["read_count"]);
  });

  it("a declared writer decides nothing when the request is not bounded", () => {
    // A column that COULD hold a bound, so only the missing bound keeps it core.
    expect(canHoldBound("INTEGER")).toBe(true);
    const result = gate(
      NO_TIME,
      [proposal("users", "star_all_limit", "INTEGER")],
      [SET_STATUS],
      ["SetEntriesStatus"],
    );
    expect(coreNames(result)).toEqual(["star_all_limit"]);
    expect(result.rejected).toEqual([]);
  });

  it("routes a user preference with no covering writer to optional, without a writer", () => {
    const result = gate(NO_TIME, [proposal("users", "theme_accent", "TEXT", "user-preference")]);
    expect(names(result.optional)).toEqual(["theme_accent"]);
    expect(result.optional[0]!.writer).toBeNull();
    expect(result.optional[0]!.reason).toMatch(/^Optional: settings persistence\./);
  });

  it("returns four empty lists for no proposals", () => {
    expect(gate(REQUEST_4478, [])).toEqual({ core: [], optional: [], rejected: [], unchecked: [] });
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

  it("a camelCase predicate covers a request: a users column is not core on such a project", () => {
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

  it("a timestamp, a date or a flag cannot hold an age; anything else, or no type, could", () => {
    expect(
      ["TIMESTAMP", "DATE", "BOOLEAN", " timestamp ", "TIMESTAMPTZ"].map(canHoldBound),
    ).toEqual([false, false, false, false, false]);
    expect(
      ["INTEGER", "BIGINT", "DECIMAL(10,2)", "TEXT", "VARCHAR(255)", null, ""].map(canHoldBound),
    ).toEqual([true, true, true, true, true, true, true]);
  });
});

describe("requestAsksToRecord (#791)", () => {
  const row = proposal("feeds", "last_pruned_at", "TIMESTAMP").row;

  it("needs a record verb and the proposal's table or a word of its column, in one statement", () => {
    expect(requestAsksToRecord(["Record on the feed when it was last pruned."], row)).toBe(true);
    expect(requestAsksToRecord(["Keep the pruning date."], row)).toBe(true);
    expect(requestAsksToRecord(["Record everything."], row)).toBe(false);
    expect(requestAsksToRecord(["Show the feed.", "Record everything."], row)).toBe(false);
    expect(requestAsksToRecord(["Show the feed when it was last pruned."], row)).toBe(false);
  });

  it("does not count the column's generic words as naming it", () => {
    // `last` and `at` say nothing about what is recorded.
    expect(requestAsksToRecord(["Keep the last one at hand."], row)).toBe(false);
  });

  it("does not read the nouns 'track of' and 'keep track' as verbs", () => {
    expect(requestAsksToRecord(["I lose track of my feeds."], row)).toBe(false);
    expect(requestAsksToRecord(["It is hard to keep track of feeds."], row)).toBe(false);
    expect(requestAsksToRecord(["Track when each feed was pruned."], row)).toBe(true);
  });
});

describe("request text is accepted up to 500,000 characters — every pattern stays linear (#791, PR #1090 review)", () => {
  /** Best of three, so one GC pause or a starved CPU does not fail a linear scan. */
  function bestOf3(run: () => unknown): number {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }
  const SIZE = 200_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  // The first is the reviewer's: 14 s at 160 KB on the pattern this replaces.
  const TOKENS: Record<string, string> = {
    "a.a.a. dotted token": fill("a."),
    "a URL": `https://example.org/${fill("ab/c?d=e&")}`,
    "minified JSON": fill('{"a":[1,2],"b":"c"},'),
    "one long word": fill("a"),
    "digits and dots": fill("1."),
    "spaces only": fill(" "),
    "unit words": fill("days "),
    "record verbs": fill("must keep "),
  };

  it.each(Object.keys(TOKENS))("%s, 200 KB: well under 100 ms", (name) => {
    const text = TOKENS[name]!;
    expect(text.length).toBe(name === "a URL" ? SIZE + "https://example.org/".length : SIZE);
    const row = proposal("users", "mark_read_delay", "INTEGER").row;
    expect(bestOf3(() => requestHasTimeBound(text))).toBeLessThan(100);
    expect(bestOf3(() => requestAsksToConfigure(text))).toBeLessThan(100);
    expect(bestOf3(() => requestAsksToRecord([text], row))).toBeLessThan(100);
    expect(
      bestOf3(() =>
        gate(requestGateText({ title: "Mark all as read older than X", body: text }), [
          proposal("users", "mark_read_delay", "INTEGER"),
        ]),
      ),
    ).toBeLessThan(100);
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
