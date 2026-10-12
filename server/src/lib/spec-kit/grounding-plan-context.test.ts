/**
 * #1060 — "not in the retrieved context" is checked against what was retrieved,
 * and the list is recorded beside the plan.
 *
 * In #706 run 7 three plans said `internal/storage`,
 * `internal/database/migrations.go` and `entry_query_builder.go` were not in
 * the retrieved context. Nothing recorded what the plans had been given, so the
 * sentence could be neither confirmed nor refuted.
 *
 * The check's result is shown to the user as a finding, so it is tested mostly
 * for what it must NOT report: every false-positive shape the #1094 review and
 * its adversarial panel reproduced is a case here.
 */
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
  METIS_INTERNAL_FEATURE_ARTIFACTS,
  PLAN_CONTEXT_ARTIFACT,
  describeContextDropped,
  describeFalseNotRetrievedClaims,
  findFalseNotRetrievedClaims,
  renderPlanContext,
} from "./grounding.js";

const FILES = [
  "internal/storage/entry.go",
  "internal/storage/entry_query_builder.go",
  "internal/database/migrations.go",
  "internal/model/model.go",
  "client/model.go",
];

const check = (...lines: string[]) => findFalseNotRetrievedClaims(lines.join("\n"), FILES);

describe("findFalseNotRetrievedClaims — what it reports", () => {
  it("a listed file the phrase is about", () => {
    expect(
      check("# Plan", "- `internal/database/migrations.go` is not in the retrieved context."),
    ).toEqual(["internal/database/migrations.go"]);
    expect(check("`client/model.go` — NOT in the retrieved context")).toEqual(["client/model.go"]);
    expect(check("`client/model.go` is also **not in the retrieved context**.")).toEqual([
      "client/model.go",
    ]);
    expect(
      check("`client/model.go`, which is not in the retrieved context, has to change."),
    ).toEqual(["client/model.go"]);
  });

  it("the path with its line span, symbol suffix or `./` stripped", () => {
    expect(
      check(
        "`./internal/storage/entry.go:506-520` — not in the retrieved context.",
        "`client/model.go::Entry` — not in the retrieved context.",
      ),
    ).toEqual(["internal/storage/entry.go", "client/model.go"]);
  });

  it("every path of a list the phrase is about", () => {
    expect(
      check(
        "`internal/storage/entry.go`, `ui/app.js` and `client/model.go` are not in the retrieved context.",
      ),
    ).toEqual(["client/model.go", "internal/storage/entry.go"]);
    // A `;` inside a code span is not a clause boundary: the list is still one list.
    expect(
      check(
        "`internal/storage/entry.go`, `a;b.go` and `ui/app.js` are not in the retrieved context.",
      ),
    ).toEqual(["internal/storage/entry.go"]);
  });

  it("a path a colon or a dash introduces after the phrase", () => {
    expect(
      check("Not in the retrieved context: `client/model.go`, `internal/storage/entry.go`."),
    ).toEqual(["client/model.go", "internal/storage/entry.go"]);
    expect(check("**Not in the retrieved context** — `client/model.go`")).toEqual([
      "client/model.go",
    ]);
  });

  it("a path given in parentheses for the thing the sentence names", () => {
    expect(
      check(
        "The migrations file (`internal/database/migrations.go`) is not in the retrieved context.",
      ),
    ).toEqual(["internal/database/migrations.go"]);
    // The parenthesised symbol belongs to the path before it: the path is the subject too.
    expect(
      check("`internal/storage/entry.go` (`SetEntriesStatus`) is not in the retrieved context."),
    ).toEqual(["internal/storage/entry.go"]);
  });

  it("the claim in its own table cell", () => {
    expect(
      check(
        "| Migration | New | `internal/database/migrations.go` is not in the retrieved context |",
      ),
    ).toEqual(["internal/database/migrations.go"]);
  });

  it("a path once, however often the plan repeats the claim", () => {
    const line = "`client/model.go` is not in the retrieved context.";
    expect(check(line, line)).toEqual(["client/model.go"]);
  });

  it("two claims on one line, each about its own path", () => {
    expect(
      check(
        "`client/model.go` is not in the retrieved context; `internal/storage/entry.go` is not in the retrieved context.",
      ),
    ).toEqual(["client/model.go", "internal/storage/entry.go"]);
  });
});

describe("findFalseNotRetrievedClaims — what it must not report (#1094 review M3, panel over-blocking)", () => {
  // Each plan line below is CORRECT: the file it calls not retrieved is not in FILES.
  const correct: Record<string, string> = {
    "a retrieved file and an unretrieved one in one line":
      "- `internal/storage/entry.go` is in the retrieved context; `internal/cli/daemon.go` is not in the retrieved context.",
    "the panel's line: one file described, another not retrieved":
      "`client/model.go` holds Feed; `client/client.go` is not in the retrieved context",
    "the same without a semicolon":
      "`client/model.go` holds Feed and `client/client.go` is not in the retrieved context.",
    "a table row with a retrieved file in another cell":
      "| `internal/storage/entry.go` | Changed | writers updated | `ui/static/app.js` not in the retrieved context |",
    "a table row whose claim cell names no file":
      "| `internal/storage/entry.go` | Changed | the template is not in the retrieved context |",
    "an ancestor directory of every listed file":
      "The `internal` test fixtures are not in the retrieved context.",
    "a directory, where a new file is meant":
      "A new file under `internal/storage` is needed; the batch helper is not in the retrieved context.",
    "a directory that holds listed files": "`internal/storage` is not in the retrieved context.",
    "a directory with a trailing slash": "`internal/database/` — not in the retrieved context.",
    "a bare file name that another directory's file carries":
      "`model.go` of the `api` package is not in the retrieved context.",
    "a bare file name only one listed file carries":
      "`entry_query_builder.go` is not in the retrieved context.",
    "a retrieved file named earlier in a sentence about something else":
      "A helper beside `internal/storage/entry.go` is needed, and the batch code is not in the retrieved context.",
    "a retrieved file in an aside":
      "`internal/cli/daemon.go` (unlike `internal/storage/entry.go`) is not in the retrieved context.",
    "a retrieved file after the phrase, not introduced by it":
      "The batch helper is not in the retrieved context (`internal/storage/entry.go` is).",
    "a retrieved file in the next sentence":
      "The template is not in the retrieved context. `internal/storage/entry.go` is the only writer.",
    "a retrieved file in the sentence before":
      "`internal/storage/entry.go` is the only writer. The template is not in the retrieved context.",
    "a list broken by a description":
      "`internal/storage/entry.go` writes the row, `ui/a.js` and `ui/b.js` are not in the retrieved context.",
    "a path that only ends like a listed one":
      "`storage/entry.go` is not in the retrieved context.",
    "a path that only starts like a listed one":
      "`client/model.go.bak` is not in the retrieved context.",
    "a pipe inside a code span is not a cell boundary":
      "`grep a | b` shows `ui/app.js` is not in the retrieved context.",
    "a retrieved file joined to the subject by a dash, which is not a list":
      "`internal/storage/entry.go` — `ui/app.js` is not in the retrieved context.",
    "a retrieved file joined to the subject by a colon":
      "`internal/storage/entry.go`: `ui/app.js` is not in the retrieved context.",
  };
  for (const [shape, line] of Object.entries(correct)) {
    it(shape, () => {
      expect(check(line)).toEqual([]);
    });
  }

  it("a path on another line than the phrase", () => {
    expect(
      check(
        "Extends `internal/storage/entry.go` (`SetEntriesStatus`).",
        "Existing capability: none found in the retrieved context",
        "- `internal/database/migrations.go`",
        "  This file is not in the retrieved context.",
      ),
    ).toEqual([]);
  });

  it("anything when no file list was recorded", () => {
    expect(
      findFalseNotRetrievedClaims("`client/model.go` is not in the retrieved context.", []),
    ).toEqual([]);
  });

  it("an over-long line or an over-long span, which it skips rather than scans", () => {
    const long = `${"x".repeat(2100)} \`client/model.go\` is not in the retrieved context.`;
    expect(check(long)).toEqual([]);
    const span = `\`${"a/".repeat(200)}model.go\` is not in the retrieved context.`;
    expect(check(span)).toEqual([]);
  });
});

describe("findFalseNotRetrievedClaims — its limits", () => {
  it("still flags a sentence that denies the claim: the note is worded to stay true of it", () => {
    // Telling a denial from a claim needs reading English. The note says the file
    // is in the list and the phrase is next to it, which is true here as well.
    expect(
      check("It would be wrong to say `client/model.go` is not in the retrieved context."),
    ).toEqual(["client/model.go"]);
  });

  it("does not reach across a table cell, a semicolon or a sentence end for the subject", () => {
    // Each of these plausibly IS about the listed file, and is not reported: a
    // path in another cell or clause may as well belong to another statement
    // (the review's table row), and the check cannot tell which. Missed on
    // purpose; `plan-context.md` is how a reader checks them.
    expect(check("| `internal/storage/entry.go` | not in the retrieved context |")).toEqual([]);
    expect(check("`internal/storage/entry.go`; not in the retrieved context")).toEqual([]);
    expect(check("See `internal/storage/entry.go`. Not in the retrieved context.")).toEqual([]);
  });

  it("looks back over a few asides for the subject, not over any number", () => {
    const aside = (names: string[]) =>
      `\`internal/storage/entry.go\` (see ${names.map((n) => `also \`${n}\``).join(", ")}) is not in the retrieved context.`;
    expect(check(aside(["a", "b", "c"]))).toEqual(["internal/storage/entry.go"]);
    // Five asides between the path and the phrase: past the look-back, so not found.
    expect(check(aside(["a", "b", "c", "d", "e"]))).toEqual([]);
  });

  it("stops at 50 paths", () => {
    const files = Array.from({ length: 60 }, (_, i) => `pkg/f${i}.go`);
    const plan = files.map((f) => `\`${f}\` is not in the retrieved context.`).join("\n");
    expect(findFalseNotRetrievedClaims(plan, files)).toHaveLength(50);
  });

  it("is linear in the plan text, whatever it is made of", () => {
    for (const unit of [
      "`a` not in the retrieved context ",
      "`",
      "not in the retrieved context\n",
      "`a/b.go:1-2` ",
      "`a::b` not in the retrieved context\n",
      "/",
      // The shapes the subject search could be slow on: nested asides, long
      // lists, clause boundaries, unbalanced parentheses.
      "(w `a` ",
      "(w `a` (w `a` )) not in the retrieved context ",
      "`a`, `b` and ",
      "`a`, `b` and `c` are not in the retrieved context; ",
      "not in the retrieved context: `a`, ",
      ") `a` ) not in the retrieved context | ",
      "(((",
      ". ; | ",
      "`client/model.go` is not in the retrieved context. ",
    ]) {
      expectLinearTime(`findFalseNotRetrievedClaims on ${JSON.stringify(unit)}`, (size) => {
        const text = unit.repeat(Math.ceil(size / unit.length));
        return () => findFalseNotRetrievedClaims(text, FILES);
      });
      // The same shape broken into lines the check does read (under 2,000 characters).
      expectLinearTime(
        `findFalseNotRetrievedClaims on lines of ${JSON.stringify(unit)}`,
        (size) => {
          const line = unit.repeat(Math.max(1, Math.floor(1900 / unit.length)));
          const text = `${line}\n`.repeat(Math.ceil(size / (line.length + 1)));
          return () => findFalseNotRetrievedClaims(text, FILES);
        },
      );
    }
  });
});

describe("describeFalseNotRetrievedClaims / describeContextDropped", () => {
  it("say nothing when there is nothing to say", () => {
    expect(describeFalseNotRetrievedClaims([])).toBe("");
    expect(describeFalseNotRetrievedClaims([], "plan-context.md")).toBe("");
    expect(describeContextDropped([])).toBe("");
  });

  it("state the check result, pointing at the record that proves it", () => {
    expect(describeFalseNotRetrievedClaims(["client/model.go"], "plan-context.md")).toBe(
      ' Check before implementing: `client/model.go` is in the list of files this plan was given (see `plan-context.md`), and the plan has "not in the retrieved context" next to it.',
    );
    expect(describeFalseNotRetrievedClaims(["a/b.go", "c/d.go"], "plan-context.md")).toBe(
      ' Check before implementing: `a/b.go`, `c/d.go` are in the list of files this plan was given (see `plan-context.md`), and the plan has "not in the retrieved context" next to each.',
    );
    // The project-level `/plan` has no such record to point at.
    expect(describeFalseNotRetrievedClaims(["client/model.go"])).toBe(
      ' Check before implementing: `client/model.go` is in the list of files this plan was given, and the plan has "not in the retrieved context" next to it.',
    );
  });

  it("does not say what the plan meant", () => {
    const note = describeFalseNotRetrievedClaims(["client/model.go"], "plan-context.md");
    expect(note).not.toMatch(/\bcalls\b|but it was|wrong|false/i);
  });

  it("list what was left out, or count it and point at the artifact that lists it", () => {
    const dropped = ["Writers of `feeds`: 2 more", "Excerpts not shown: A"];
    expect(describeContextDropped(dropped)).toBe(
      " Left out of the plan's context (token budget, list cap or time limit): Writers of `feeds`: 2 more; Excerpts not shown: A.",
    );
    expect(describeContextDropped(dropped, "plan-context.md")).toBe(
      " Left out of the plan's context (token budget, list cap or time limit): 2 items, listed in `plan-context.md`.",
    );
    expect(describeContextDropped(dropped.slice(0, 1), "plan-context.md")).toBe(
      " Left out of the plan's context (token budget, list cap or time limit): 1 item, listed in `plan-context.md`.",
    );
    expect(describeContextDropped([], "plan-context.md")).toBe("");
  });
});

describe("renderPlanContext", () => {
  it("records the files given and what was left out, and says it is not the change list", () => {
    const text = renderPlanContext({
      usedChunks: 9,
      usedSymbols: 31,
      files: ["internal/storage/feed.go", "client/model.go"],
      dropped: ["Readers of `feeds`: 6 more readers not listed (in internal/storage/icon.go)"],
    });
    expect(PLAN_CONTEXT_ARTIFACT).toBe("plan-context.md");
    expect(text).toContain("# Plan context");
    expect(text).toContain("when it wrote the current `plan.md`");
    expect(text).toContain("NOT the list of files to change");
    expect(text).toContain("- Grounding: grounded on 9 retrieved chunks and 31 code symbols");
    expect(text).toContain("- Files named in the context: 2");
    expect(text).toContain("- `internal/storage/feed.go`\n- `client/model.go`");
    expect(text).toContain(
      "## Left out (token budget, list cap or time limit)\n\n- Readers of `feeds`: 6 more readers not listed",
    );
  });

  it("names the plan.md version it describes, so a record left from an earlier plan says so", () => {
    const text = renderPlanContext(
      { usedChunks: 1, usedSymbols: 1, files: ["a/b.go"], dropped: [] },
      { planVersion: 3 },
    );
    expect(text).toContain("What `/speckit.plan` was given when it wrote `plan.md` v3.");
    expect(text).toContain("If `plan.md` is at another version, this record was not rewritten");
    expect(text).not.toContain("the current `plan.md`");
  });

  it("says so when nothing was retrieved or nothing was left out", () => {
    const text = renderPlanContext({ usedChunks: 0, usedSymbols: 0, files: [], dropped: [] });
    expect(text).toContain("- Grounding: ungrounded (no project knowledge retrieved)");
    expect(text).toContain("## Files in the retrieved context\n\nNone.");
    expect(text).toContain("## Left out (token budget, list cap or time limit)\n\nNothing.");
  });

  it("is a METIS record, not a Spec Kit artifact", () => {
    expect([...METIS_INTERNAL_FEATURE_ARTIFACTS]).toEqual(["plan-context.md"]);
  });
});
