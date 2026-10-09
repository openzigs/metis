/**
 * Epic #396 (MVP-4) — tasks.md parser tests.
 */
import { describe, expect, it } from "vitest";
import { parseTasksMarkdown } from "../src/lib/spec-kit/tasks-parser.js";

describe("parseTasksMarkdown", () => {
  it("parses a markdown table", () => {
    const md = `
| # | Title | Story Points | Dependencies | Notes |
| --- | --- | --- | --- | --- |
| T01 | Build login form | 3 | none | |
| T02 | Wire auth API [P] | 5 | T01 | files: src/api/auth.ts |
`.trim();
    const tasks = parseTasksMarkdown(md);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      id: "T01",
      title: "Build login form",
      parallelizable: false,
      storyPoints: 3,
      dependsOn: [],
    });
    expect(tasks[1]).toMatchObject({
      id: "T02",
      title: "Wire auth API",
      parallelizable: true,
      storyPoints: 5,
      dependsOn: ["T01"],
    });
    expect(tasks[1].files).toContain("src/api/auth.ts");
  });

  it("parses bullet form with depends-on + parallel + files", () => {
    const md = `- [ ] T01 — Build login form (depends-on: none) [P]  files: src/login.tsx`;
    const tasks = parseTasksMarkdown(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: "T01",
      title: "Build login form",
      parallelizable: true,
      dependsOn: [],
    });
    expect(tasks[0]?.files).toContain("src/login.tsx");
  });

  it("attaches user story slug from preceding header", () => {
    const md = `
## Story US42

- [ ] T01 — First (depends-on: none)
`.trim();
    const tasks = parseTasksMarkdown(md);
    expect(tasks[0]?.userStorySlug).toBe("us42");
  });

  it("handles multiple deps", () => {
    const md = `- [ ] T03 — Third (depends-on: T01, T02)`;
    const tasks = parseTasksMarkdown(md);
    expect(tasks[0]?.dependsOn).toEqual(["T01", "T02"]);
  });

  it("ignores non-task lines", () => {
    const md = `# Tasks\n\nSome prose.\n\n- [ ] T01 — Real task (depends-on: none)\n`;
    const tasks = parseTasksMarkdown(md);
    expect(tasks).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseTasksMarkdown("")).toEqual([]);
  });

  it("returns empty array when no rows match", () => {
    expect(parseTasksMarkdown("# Tasks\n\nNo rows here.")).toEqual([]);
  });

  it("normalizes task IDs to uppercase from table cells", () => {
    const md = `| t05 | lower id |`;
    const tasks = parseTasksMarkdown(md);
    expect(tasks[0]?.id).toBe("T05");
  });

  it("skips table separator rows", () => {
    const md = `
| # | Title |
| --- | --- |
| T01 | Foo |
`.trim();
    const tasks = parseTasksMarkdown(md);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Foo");
  });

  it("parses dependencies with comma-and-space format", () => {
    const md = `| T05 | Five | 1 | T01, T02, T03 | |`;
    const tasks = parseTasksMarkdown(md);
    expect(tasks[0]?.dependsOn).toEqual(["T01", "T02", "T03"]);
  });
});

/**
 * #993 — METIS's own `/speckit.tasks` output puts file:line spans in
 * parentheses and ends each line with `(satisfies: …) depends-on: …`. Only the
 * trailing metadata is metadata; the title keeps every other parenthesis.
 */
describe("parseTasksMarkdown — METIS task lines (#993)", () => {
  const METIS_LINE =
    "- [ ] T03 — Change `MarkAllAsReadBeforeDate` in storage/entry.go (storage/entry.go:412-430) with unit tests (satisfies: AC-1, AC-2) depends-on: T01, T02";

  it("keeps a parenthesised file:line span in the title", () => {
    const [task] = parseTasksMarkdown(METIS_LINE);
    expect(task?.title).toBe(
      "Change `MarkAllAsReadBeforeDate` in storage/entry.go (storage/entry.go:412-430) with unit tests",
    );
  });

  it("keeps a parenthesised call in the title", () => {
    const [task] = parseTasksMarkdown(
      "- [ ] T04 — Count unread entries using `COALESCE(count, 0)` (satisfies: AC-3) depends-on: none",
    );
    expect(task?.title).toBe("Count unread entries using `COALESCE(count, 0)`");
    expect(task?.dependsOn).toEqual([]);
  });

  it("reads the bare trailing depends-on and the satisfies group", () => {
    const [task] = parseTasksMarkdown(METIS_LINE);
    expect(task?.dependsOn).toEqual(["T01", "T02"]);
    expect(task?.satisfies).toEqual(["AC-1", "AC-2"]);
    expect(task?.parallelizable).toBe(false);
  });

  it("does not read depends-on from inside the title", () => {
    const [task] = parseTasksMarkdown(
      "- [ ] T05 — Document the depends-on: T09 field (docs/tasks.md:3) (satisfies: AC-4)",
    );
    expect(task?.dependsOn).toEqual([]);
    expect(task?.title).toBe("Document the depends-on: T09 field (docs/tasks.md:3)");
  });

  it("reads [P] only from the trailing metadata", () => {
    const [task] = parseTasksMarkdown("- [ ] T07 — Rename the [P] marker docs (satisfies: AC-1)");
    expect(task?.parallelizable).toBe(false);
    expect(task?.title).toBe("Rename the [P] marker docs");
  });

  it("carries the whole line, without its checkbox, as the task text", () => {
    const [task] = parseTasksMarkdown(METIS_LINE);
    expect(task?.text).toBe(METIS_LINE.replace("- [ ] ", ""));
  });

  it("carries indented lines beneath a task into its text, and stops at the next task", () => {
    const md = [
      "- [ ] T01 — Add the endpoint (depends-on: none)",
      "  Description: POST /entries/mark-read",
      "",
      "  Acceptance: returns 204",
      "- [ ] T02 — Wire the button (depends-on: T01)",
      "Unindented prose ends it.",
      "  not part of T02",
    ].join("\n");
    const tasks = parseTasksMarkdown(md);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.text).toBe(
      "T01 — Add the endpoint (depends-on: none)\nDescription: POST /entries/mark-read\nAcceptance: returns 204",
    );
    expect(tasks[1]?.text).toBe("T02 — Wire the button (depends-on: T01)");
  });

  it("keeps a line that is only metadata as its own title", () => {
    const [task] = parseTasksMarkdown("- [ ] T06 — (depends-on: none)");
    expect(task?.title).toBe("(depends-on: none)");
  });
});
