/**
 * #1060 — "not in the retrieved context" is checked against what was retrieved,
 * and the list is recorded beside the plan.
 *
 * In #706 run 7 three plans said `internal/storage`,
 * `internal/database/migrations.go` and `entry_query_builder.go` were not in
 * the retrieved context. Nothing recorded what the plans had been given, so the
 * sentence could be neither confirmed nor refuted.
 */
import { describe, expect, it } from "vitest";
import { expectLinearTime } from "../../../tests/helpers/linear-time.js";
import {
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
  "client/model.go",
];

describe("findFalseNotRetrievedClaims", () => {
  it("flags a file, a directory and a bare file name the context did name", () => {
    const plan = [
      "# Plan",
      "- `internal/database/migrations.go` is not in the retrieved context.",
      "- The storage layer (`internal/storage`) is NOT in the retrieved context, nor is",
      "  `entry_query_builder.go` — not in the retrieved context either.",
    ].join("\n");
    expect(findFalseNotRetrievedClaims(plan, FILES)).toEqual([
      "internal/database/migrations.go",
      "internal/storage",
      "entry_query_builder.go",
    ]);
  });

  it("accepts the claim for a file the context never named", () => {
    const plan = [
      "- `internal/template/templates/views/unread_entries.html` is not in the retrieved context.",
      "- `internal/ui` is not in the retrieved context.",
      "- `handler.go` is not in the retrieved context.",
    ].join("\n");
    expect(findFalseNotRetrievedClaims(plan, FILES)).toEqual([]);
  });

  it("reads a claim line by line: a path on another line is not part of it", () => {
    const plan = [
      "Extends `internal/storage/entry.go` (`SetEntriesStatus`).",
      "Existing capability: none found in the retrieved context",
    ].join("\n");
    expect(findFalseNotRetrievedClaims(plan, FILES)).toEqual([]);
  });

  it("strips a line span, a symbol suffix, `./` and a trailing slash before comparing", () => {
    const plan = [
      "`./internal/storage/entry.go:506-520` — not in the retrieved context.",
      "`client/model.go::Entry` — not in the retrieved context.",
      "`internal/database/` — not in the retrieved context.",
    ].join("\n");
    expect(findFalseNotRetrievedClaims(plan, FILES)).toEqual([
      "internal/storage/entry.go",
      "client/model.go",
      "internal/database",
    ]);
  });

  it("does not match a directory by a partial segment, or a bare name inside a longer one", () => {
    const plan = [
      "`internal/stor` is not in the retrieved context.",
      "`model.go.bak` is not in the retrieved context.",
      "`storage/entry.go` is not in the retrieved context.",
    ].join("\n");
    expect(findFalseNotRetrievedClaims(plan, FILES)).toEqual([]);
  });

  it("checks nothing when no file list was recorded", () => {
    expect(
      findFalseNotRetrievedClaims("`client/model.go` is not in the retrieved context.", []),
    ).toEqual([]);
  });

  it("reports a path once, however often the plan repeats the claim", () => {
    const line = "`client/model.go` is not in the retrieved context.";
    expect(findFalseNotRetrievedClaims(`${line}\n${line}`, FILES)).toEqual(["client/model.go"]);
  });

  it("skips an over-long line and an over-long span rather than scanning them", () => {
    const long = `${"x".repeat(2100)} \`client/model.go\` is not in the retrieved context.`;
    expect(findFalseNotRetrievedClaims(long, FILES)).toEqual([]);
    const span = `\`${"a/".repeat(200)}model.go\` is not in the retrieved context.`;
    expect(findFalseNotRetrievedClaims(span, FILES)).toEqual([]);
  });

  it("stops at 50 claimed paths", () => {
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
    ]) {
      expectLinearTime(`findFalseNotRetrievedClaims on ${JSON.stringify(unit)}`, (size) => {
        const text = unit.repeat(Math.ceil(size / unit.length));
        return () => findFalseNotRetrievedClaims(text, FILES);
      });
    }
  });
});

describe("describeFalseNotRetrievedClaims / describeContextDropped", () => {
  it("say nothing when there is nothing to say", () => {
    expect(describeFalseNotRetrievedClaims([])).toBe("");
    expect(describeContextDropped([])).toBe("");
  });

  it("name the paths, in the singular and the plural", () => {
    expect(describeFalseNotRetrievedClaims(["client/model.go"])).toBe(
      ' The plan calls `client/model.go` "not in the retrieved context", but it was in it — check that statement before implementing.',
    );
    expect(describeFalseNotRetrievedClaims(["a.go", "internal/storage"])).toBe(
      ' The plan calls `a.go`, `internal/storage` "not in the retrieved context", but they were in it — check those statements before implementing.',
    );
  });

  it("list what was left out, or count it and point at the artifact that lists it", () => {
    const dropped = ["Writers of `feeds`: 2 more", "Excerpts not shown: A"];
    expect(describeContextDropped(dropped)).toBe(
      " Left out of the plan's context (token budget or list cap): Writers of `feeds`: 2 more; Excerpts not shown: A.",
    );
    expect(describeContextDropped(dropped, "plan-context.md")).toBe(
      " 2 groups of related code were left out of the plan's context (token budget or list cap) — listed in `plan-context.md`.",
    );
    expect(describeContextDropped(dropped.slice(0, 1), "plan-context.md")).toBe(
      " 1 group of related code was left out of the plan's context (token budget or list cap) — listed in `plan-context.md`.",
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
    expect(text).toContain("NOT the list of files to change");
    expect(text).toContain("- Grounding: grounded on 9 retrieved chunks and 31 code symbols");
    expect(text).toContain("- Files named in the context: 2");
    expect(text).toContain("- `internal/storage/feed.go`\n- `client/model.go`");
    expect(text).toContain("- Readers of `feeds`: 6 more readers not listed");
  });

  it("says so when nothing was retrieved or nothing was left out", () => {
    const text = renderPlanContext({ usedChunks: 0, usedSymbols: 0, files: [], dropped: [] });
    expect(text).toContain("- Grounding: ungrounded (no project knowledge retrieved)");
    expect(text).toContain("## Files in the retrieved context\n\nNone.");
    expect(text).toContain("## Left out (token budget or list cap)\n\nNothing.");
  });
});
