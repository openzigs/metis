/**
 * #791 — the deterministic gate on proposed columns.
 *
 * The requirement is the VERBATIM run-7 #4478 issue (`__fixtures__/`), not a
 * condensed one: #1045's fixture was condensed, passed, and regressed 3 runs in
 * 3 in production. The proposals are the four columns the model actually
 * returned across runs 3 to 7. The writer is Miniflux v2.3.3's
 * `MarkAllAsReadBeforeDate`, profiled as the run-7 lineage records it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changeFromRequest, parseChangeRequest } from "./change-request.js";
import {
  gateColumnProposals,
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
const change = changeFromRequest(parseChangeRequest(ISSUE_4478)!);
/** Exactly the text the engine hands every stage for this issue. */
const REQUIREMENT_4478 = `${change.title}\n${change.body}`;

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
  requirementText: string,
  proposals: ProposedColumn[],
  writers: DataPathWriterProfile[] = [MARK_BEFORE_DATE, SET_STATUS],
  coveringWriterIds: string[] = [],
) => gateColumnProposals({ requirementText, proposals, coveringWriterIds, writers });

const names = (rows: { row: AffectedTableInput }[]) => rows.map((r) => r.row.columnName);

describe("what the verbatim #4478 request asks for (#791)", () => {
  it("is bounded by an age", () => {
    expect(requestHasTimeBound(REQUIREMENT_4478)).toBe(true);
  });

  it("asks to configure the value, and does not ask to record anything", () => {
    expect(requestAsksToConfigure(REQUIREMENT_4478)).toBe(true);
    expect(requestAsksToRecord(REQUIREMENT_4478)).toBe(false);
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
      expect(gate(REQUIREMENT_4478, proposals).core).toEqual([]);
    }
  });

  it("routes every one of them to Optional: settings persistence, citing the writer", () => {
    for (const proposals of RUNS) {
      const result = gate(REQUIREMENT_4478, proposals);
      expect(names(result.optional)).toEqual(proposals.map((p) => p.row.columnName));
      expect(result.rejected).toEqual([]);
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
        expect(optional.reason).toContain("not part of the migration");
      }
    }
  });

  it("does not depend on what the column is called — the #1045 defect", () => {
    // A name that shares no word with the writer or the request.
    const result = gate(REQUIREMENT_4478, [proposal("users", "zzz_qqq", "INTEGER")]);
    expect(result.core).toEqual([]);
    expect(names(result.optional)).toEqual(["zzz_qqq"]);
  });

  it("does not depend on the proposer's own label either", () => {
    for (const justification of [null, "operation-needs-new-data", "user-preference"] as const) {
      const result = gate(REQUIREMENT_4478, [
        proposal("users", "mark_read_delay", "INTEGER", justification),
      ]);
      expect(result.core).toEqual([]);
      expect(names(result.optional)).toEqual(["mark_read_delay"]);
    }
  });

  it("holds when the stored symbol text is missing: the predicate alone covers it", () => {
    const untexted = { ...MARK_BEFORE_DATE, signature: null, parameters: [], sql: null };
    const result = gate(
      REQUIREMENT_4478,
      [proposal("users", "mark_read_delay", "INTEGER")],
      [untexted],
    );
    expect(result.core).toEqual([]);
    expect(result.optional[0]!.reason).toContain(
      "already filters entries.published_at by an argument",
    );
  });
});

describe("gateColumnProposals — rejected, when nothing asks to store the value (#791)", () => {
  // The same request without its "configured in settings" sentence.
  const BARE =
    "Mark all as read older than X. This gives people the option to just let things that are older than X days be marked as read.";

  it("rejects the column with the covering writer and the reason", () => {
    const result = gate(BARE, [proposal("users", "mark_read_delay", "INTEGER")]);
    expect(result.core).toEqual([]);
    expect(result.optional).toEqual([]);
    expect(names(result.rejected)).toEqual(["mark_read_delay"]);
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::MarkAllAsReadBeforeDate`);
    expect(result.rejected[0]!.reason).toMatch(/^An existing write path covers this:/);
    expect(result.rejected[0]!.reason).toContain("an argument of that call, not data to store");
  });

  it("still makes it optional when the proposer itself calls it a user preference", () => {
    const result = gate(BARE, [proposal("users", "mark_read_delay", "INTEGER", "user-preference")]);
    expect(names(result.optional)).toEqual(["mark_read_delay"]);
    expect(result.rejected).toEqual([]);
  });
});

describe("gateColumnProposals — what stays a core migration (#791)", () => {
  it("keeps a column on the table the covering writer writes (#4336 read_at)", () => {
    // Time-bounded wording AND a time-predicate writer, and still core: the
    // operation records this on its own table.
    const text = "Set read_at when an entry is marked read, including entries older than 30 days.";
    const result = gate(text, [proposal("entries", "read_at", "TIMESTAMP")]);
    expect(result.core.map((r) => r.columnName)).toEqual(["read_at"]);
    expect(result.optional).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("keeps a column on another table when the request asks to RECORD something", () => {
    const text =
      "Delete entries older than 30 days, and record on the feed when it was last pruned.";
    const result = gate(text, [proposal("feeds", "last_pruned_at", "TIMESTAMP")]);
    expect(result.core.map((r) => r.columnName)).toEqual(["last_pruned_at"]);
  });

  it("keeps everything when the request is not bounded by a time (#4511)", () => {
    const text =
      "Store and return the last time a feed was successfully refreshed. Add a Last Successful Refresh parameter to the Feed API.";
    expect(requestHasTimeBound(text)).toBe(false);
    const result = gate(text, [proposal("feeds", "last_successful_refresh_at", "TIMESTAMP")]);
    expect(result.core.map((r) => r.columnName)).toEqual(["last_successful_refresh_at"]);
  });

  it("keeps everything when no writer filters on a time column", () => {
    const result = gate(
      REQUIREMENT_4478,
      [proposal("users", "mark_read_delay", "INTEGER")],
      [SET_STATUS],
    );
    expect(result.core.map((r) => r.columnName)).toEqual(["mark_read_delay"]);
  });

  it("keeps everything when the lineage named no writer at all", () => {
    const result = gate(REQUIREMENT_4478, [proposal("users", "mark_read_delay", "INTEGER")], []);
    expect(result.core.map((r) => r.columnName)).toEqual(["mark_read_delay"]);
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
    expect(result.core.map((r) => r.columnName)).toEqual(["archived_reason"]);
  });

  it("matches a schema-qualified table to the writer's table", () => {
    const result = gate("Mark entries older than 30 days as read.", [
      proposal("public.entries", "read_at", "TIMESTAMP"),
    ]);
    expect(result.core.map((r) => r.columnName)).toEqual(["read_at"]);
  });
});

describe("gateColumnProposals — the proposer's structured answer (#791)", () => {
  const NO_TIME = "Let a user star every entry of a feed at once.";

  it("rejects a column the proposer says a listed writer already covers", () => {
    const result = gate(NO_TIME, [
      proposal("entries", "starred_all", "BOOLEAN", "operation-needs-new-data", "SetEntriesStatus"),
    ]);
    expect(result.core).toEqual([]);
    expect(names(result.rejected)).toEqual(["starred_all"]);
    expect(result.rejected[0]!.writer?.qualifiedName).toBe(`${ENTRY}::SetEntriesStatus`);
    expect(result.rejected[0]!.reason).toContain("the proposer itself named SetEntriesStatus");
  });

  it("ignores a coveredBy that names no listed writer — it cannot invent one", () => {
    const result = gate(NO_TIME, [
      proposal("entries", "starred_all", "BOOLEAN", "operation-needs-new-data", "Nope"),
    ]);
    expect(result.core.map((r) => r.columnName)).toEqual(["starred_all"]);
  });

  it("a writer the proposer lists as covering counts, time bound or not", () => {
    const result = gateColumnProposals({
      requirementText: NO_TIME,
      proposals: [proposal("users", "star_all_default", "BOOLEAN")],
      coveringWriterIds: ["SetEntriesStatus"],
      writers: [SET_STATUS],
    });
    expect(result.core).toEqual([]);
    expect(names(result.rejected)).toEqual(["star_all_default"]);
    expect(result.rejected[0]!.reason).toContain("already performs the requested operation");
  });

  it("a covering id that names no listed writer changes nothing", () => {
    const result = gateColumnProposals({
      requirementText: NO_TIME,
      proposals: [proposal("users", "star_all_default", "BOOLEAN")],
      coveringWriterIds: ["Invented"],
      writers: [SET_STATUS],
    });
    expect(result.core.map((r) => r.columnName)).toEqual(["star_all_default"]);
  });

  it("routes a user preference with no covering writer to optional, without a writer", () => {
    const result = gate(NO_TIME, [proposal("users", "theme_accent", "TEXT", "user-preference")]);
    expect(names(result.optional)).toEqual(["theme_accent"]);
    expect(result.optional[0]!.writer).toBeNull();
    expect(result.optional[0]!.reason).toMatch(/^Optional: settings persistence\./);
  });

  it("returns three empty lists for no proposals", () => {
    expect(gate(REQUIREMENT_4478, [])).toEqual({ core: [], optional: [], rejected: [] });
  });
});

describe("requestHasTimeBound / timePredicates (#791)", () => {
  it("recognises an age or a point in time as the bound of an operation", () => {
    for (const text of [
      "Mark all as read older than X",
      "delete sessions more than 30 days old",
      "archive entries before a given date",
      "show feeds refreshed in the last 7 days",
      "purge rows 90 days old",
    ]) {
      expect(requestHasTimeBound(text), text).toBe(true);
    }
  });

  it("does not read ordinary wording as a time bound", () => {
    for (const text of [
      "Store and return the last time a feed was successfully refreshed",
      "Add a read_at timestamp to entries",
      "The feed shows 0 entries after marking the last page as read",
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
