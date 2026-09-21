/**
 * Issue #433 — issue-sync unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import { applyIssueEventToTasksMarkdown, syncIssueEvent } from "./issue-sync.js";

describe("applyIssueEventToTasksMarkdown", () => {
  const bullet = "- [ ] T01 — Build login form (depends-on: none)\n- [ ] T02 — Wire auth API\n";
  const table = [
    "| # | Title | SP | Deps | Notes |",
    "| --- | --- | --- | --- | --- |",
    "| T01 | Build login form | 3 | none | |",
    "| T02 | Wire auth API | 5 | T01 | |",
    "",
  ].join("\n");

  it("toggles a bullet checkbox to [x] on `closed`", () => {
    const r = applyIssueEventToTasksMarkdown(bullet, "T01", "closed");
    expect(r.change).toBe("checkbox");
    expect(r.content).toContain("- [x] T01");
    expect(r.content).toContain("- [ ] T02");
  });

  it("flips back to [ ] on `reopened`", () => {
    const closed = applyIssueEventToTasksMarkdown(bullet, "T01", "closed").content;
    const r = applyIssueEventToTasksMarkdown(closed, "T01", "reopened");
    expect(r.change).toBe("checkbox");
    expect(r.content).toContain("- [ ] T01");
  });

  it("annotates a table row with a closed marker on `closed`", () => {
    const r = applyIssueEventToTasksMarkdown(table, "T02", "closed");
    expect(r.change).toBe("checkbox");
    expect(r.content).toMatch(/T02.*closed/);
  });

  it("flips a table row's closed marker back to open on `reopened`", () => {
    const closed = applyIssueEventToTasksMarkdown(table, "T01", "closed").content;
    const r = applyIssueEventToTasksMarkdown(closed, "T01", "reopened");
    expect(r.change).toBe("checkbox");
    expect(r.content).toMatch(/T01.*open/);
  });

  it("rewrites the title on `edited` for a bullet task", () => {
    const r = applyIssueEventToTasksMarkdown(bullet, "T01", "edited", "Build login form v2");
    expect(r.change).toBe("title");
    expect(r.content).toContain("T01 — Build login form v2");
    expect(r.content).not.toContain("T01 — Build login form (depends-on");
  });

  it("rewrites the title cell on `edited` for a table task", () => {
    const r = applyIssueEventToTasksMarkdown(table, "T02", "edited", "Renamed");
    expect(r.change).toBe("title");
    expect(r.content).toContain("| T02 | Renamed |");
  });

  it("returns noop when the task id is not present", () => {
    const r = applyIssueEventToTasksMarkdown(bullet, "T99", "closed");
    expect(r.change).toBe("noop");
    expect(r.content).toBe(bullet);
  });

  it("returns noop when `edited` arrives without a newTitle", () => {
    const r = applyIssueEventToTasksMarkdown(bullet, "T01", "edited");
    expect(r.change).toBe("noop");
  });

  it("returns noop when the task is already in the requested state", () => {
    const closed = applyIssueEventToTasksMarkdown(bullet, "T01", "closed").content;
    const r = applyIssueEventToTasksMarkdown(closed, "T01", "closed");
    expect(r.change).toBe("noop");
  });

  // Issue #438 — table close marker substitutes the real issue number.
  it("substitutes the real issue number into the table close marker", () => {
    const r = applyIssueEventToTasksMarkdown(table, "T01", "closed", undefined, 4242);
    expect(r.change).toBe("checkbox");
    expect(r.content).toContain("<!-- closed via #4242 -->");
    expect(r.content).not.toContain("#N");
  });

  it("falls back to `#N` when no issue number is supplied (back-compat)", () => {
    const r = applyIssueEventToTasksMarkdown(table, "T01", "closed");
    expect(r.change).toBe("checkbox");
    expect(r.content).toContain("<!-- closed via #N -->");
  });

  // Issue #438 — String.replace replacement-pattern bug.
  it("treats `$1` / `$&` / `$$` in newTitle as literal text on bullet rows", () => {
    const r = applyIssueEventToTasksMarkdown(
      bullet,
      "T01",
      "edited",
      "Inject $1 and $& and $$ literals",
    );
    expect(r.change).toBe("title");
    expect(r.content).toContain("T01 — Inject $1 and $& and $$ literals");
  });

  // Issue #438 — pipe / newline corruption.
  it("escapes pipes and collapses newlines in the new title (table row)", () => {
    const r = applyIssueEventToTasksMarkdown(
      table,
      "T02",
      "edited",
      "Renamed | with | pipes\nand newlines",
    );
    expect(r.change).toBe("title");
    const renamed = r.content.split("\n").find((l) => l.includes("T02"))!;
    // Pipes inside the title cell must be backslash-escaped so a markdown
    // renderer treats them as literal text instead of cell separators.
    expect(renamed).toContain("Renamed \\| with \\| pipes and newlines");
    // Newlines must be collapsed so the row stays on a single line.
    expect(renamed).not.toContain("\n");
    // No raw, unescaped pipe was introduced into the title cell that
    // would shift downstream columns. Count UNESCAPED pipes (i.e., `|`
    // not preceded by `\`) — a markdown renderer treats those as
    // separators. Both the original row and the renamed row must agree.
    const countUnescaped = (s: string) => (s.match(/(?<!\\)\|/g) ?? []).length;
    const originalRow = table.split("\n").find((l) => l.includes("T02"))!;
    expect(countUnescaped(renamed)).toBe(countUnescaped(originalRow));
  });

  it("escapes pipes and collapses newlines in the new title (bullet row)", () => {
    const r = applyIssueEventToTasksMarkdown(bullet, "T01", "edited", "New | title\nwith newline");
    expect(r.change).toBe("title");
    expect(r.content).toContain("T01 — New \\| title with newline");
  });

  // Issue #17.2 — HTML / comment scrubbing in titles (A03 injection).
  it("neutralises inline <script> tags in an edited title (bullet row)", () => {
    const r = applyIssueEventToTasksMarkdown(
      bullet,
      "T01",
      "edited",
      "Login <script>alert(1)</script>",
    );
    expect(r.change).toBe("title");
    // No raw angle brackets survive — they are HTML-entity encoded so a
    // renderer shows literal text instead of executing markup.
    expect(r.content).not.toContain("<script>");
    expect(r.content).not.toContain("</script>");
    expect(r.content).not.toMatch(/<[a-z!/]/i);
    expect(r.content).toContain("&lt;script&gt;");
  });

  it("strips HTML comments so a title cannot inject a fake status marker (table row)", () => {
    const r = applyIssueEventToTasksMarkdown(
      table,
      "T02",
      "edited",
      "Renamed <!-- closed via #1 -->",
    );
    expect(r.change).toBe("title");
    const renamed = r.content.split("\n").find((l) => l.includes("T02"))!;
    // The injected comment must be gone — neither a raw comment nor a fake
    // close/open marker may reach the rendered tasks.md from a user title.
    expect(renamed).not.toContain("<!--");
    expect(renamed).not.toContain("-->");
  });

  it("neutralises an <img onerror=...> payload in an edited title", () => {
    const r = applyIssueEventToTasksMarkdown(
      bullet,
      "T01",
      "edited",
      '<img src=x onerror="alert(1)">',
    );
    expect(r.change).toBe("title");
    expect(r.content).not.toMatch(/<img/i);
    expect(r.content).not.toMatch(/<[a-z!/]/i);
    expect(r.content).toContain("&lt;img");
  });

  it("strips an unterminated HTML comment in a title", () => {
    const r = applyIssueEventToTasksMarkdown(bullet, "T01", "edited", "Title <!-- dangling");
    expect(r.change).toBe("title");
    expect(r.content).not.toContain("<!--");
    expect(r.content).toContain("T01 — Title");
  });
});

describe("syncIssueEvent (unit)", () => {
  function makeDeps(overrides: {
    exportRow?: { projectId: string; featureSlug: string; taskId: string } | null;
    feature?: { id: string } | null;
  }) {
    return {
      findExport: vi.fn(async () => overrides.exportRow ?? null),
      findFeature: vi.fn(async () => overrides.feature ?? null),
    };
  }

  it("returns NO_TASK_EXPORT when the issue is not bound to a task", async () => {
    const r = await syncIssueEvent(
      { repoOwner: "acme", repoName: "proj", issueNumber: 1, action: "closed" },
      makeDeps({ exportRow: null }),
    );
    expect(r).toEqual({ handled: false, reason: "NO_TASK_EXPORT" });
  });

  it("returns FEATURE_MISSING when the feature row has been deleted", async () => {
    const r = await syncIssueEvent(
      { repoOwner: "acme", repoName: "proj", issueNumber: 1, action: "closed" },
      makeDeps({
        exportRow: { projectId: "p1", featureSlug: "001-x", taskId: "T01" },
        feature: null,
      }),
    );
    expect(r).toEqual({ handled: false, reason: "FEATURE_MISSING" });
  });
});
