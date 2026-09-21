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
