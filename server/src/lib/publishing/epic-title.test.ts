/**
 * Issue #23 — the generated epic draft used to be titled with an internal id
 * (`[Epic] METIS — Analysis cmubq3ls`). It is now titled from what was analysed.
 */
import { describe, expect, it } from "vitest";
import { buildEpicTitle, EPIC_TITLE_SUBJECT_MAX } from "./epic-title.js";

const STARTED = new Date("2026-09-29T14:05:33.000Z");

function analysis(metadata: unknown, startedAt: Date | null = STARTED) {
  return {
    id: "cmubq3ls0000abcdef",
    startedAt,
    metadata: metadata === null ? null : JSON.stringify(metadata),
  };
}

describe("buildEpicTitle", () => {
  it("titles the epic from the requirement text the analysis evaluated", () => {
    const title = buildEpicTitle(
      "METIS",
      analysis({ extraInstructions: "Export analysis results to CSV\nMore detail here." }),
    );
    expect(title).toBe("[Epic] METIS — Export analysis results to CSV");
    expect(title).not.toContain("cmubq3ls");
  });

  it("skips blank lines and strips markdown markers from the first line", () => {
    expect(
      buildEpicTitle(
        "METIS",
        analysis({ extraInstructions: "\n\n  ## Single sign-on   via  SAML \n" }),
      ),
    ).toBe("[Epic] METIS — Single sign-on via SAML");
    expect(buildEpicTitle("METIS", analysis({ extraInstructions: "- [ ] Dark mode" }))).toBe(
      "[Epic] METIS — Dark mode",
    );
    expect(buildEpicTitle("METIS", analysis({ extraInstructions: "> **Audit log**" }))).toBe(
      "[Epic] METIS — Audit log",
    );
  });

  it("truncates a long subject on a word boundary with an ellipsis", () => {
    const long = `${"word ".repeat(40)}end`;
    const title = buildEpicTitle("METIS", analysis({ extraInstructions: long }));
    const subject = title.replace("[Epic] METIS — ", "");
    expect(subject.endsWith("…")).toBe(true);
    expect(subject.length).toBeLessThanOrEqual(EPIC_TITLE_SUBJECT_MAX);
    expect(subject).not.toMatch(/\s…$/);
    expect(long.startsWith(subject.slice(0, -1))).toBe(true);
  });

  it("hard-cuts a single over-long token rather than returning nothing", () => {
    const token = "x".repeat(200);
    const subject = buildEpicTitle("P", analysis({ extraInstructions: token })).replace(
      "[Epic] P — ",
      "",
    );
    expect(subject).toBe(`${"x".repeat(EPIC_TITLE_SUBJECT_MAX - 1)}…`);
  });

  it("falls back to an import label when there is no requirement text", () => {
    expect(
      buildEpicTitle("METIS", analysis({ kind: "import", source: "jira", label: "Q3 backlog" })),
    ).toBe("[Epic] METIS — Q3 backlog");
  });

  it("falls back to the run's start time — never the id — when nothing names the feature", () => {
    for (const meta of [
      null,
      {},
      { extraInstructions: null },
      { extraInstructions: "   \n  " },
      { extraInstructions: "###" },
      { label: 42 },
    ]) {
      expect(buildEpicTitle("METIS", analysis(meta))).toBe(
        "[Epic] METIS — Analysis of 2026-09-29 14:05 UTC",
      );
    }
  });

  it("tolerates unparseable metadata", () => {
    const a = { id: "cmubq3ls", startedAt: STARTED, metadata: "{not json" };
    expect(buildEpicTitle("METIS", a)).toBe("[Epic] METIS — Analysis of 2026-09-29 14:05 UTC");
    const arr = { id: "cmubq3ls", startedAt: STARTED, metadata: "[1,2]" };
    expect(buildEpicTitle("METIS", arr)).toBe("[Epic] METIS — Analysis of 2026-09-29 14:05 UTC");
  });

  it("uses a plain subject when the start time is unavailable", () => {
    expect(buildEpicTitle("METIS", analysis(null, null))).toBe(
      "[Epic] METIS — Requirements analysis",
    );
    expect(buildEpicTitle("METIS", analysis(null, new Date("invalid")))).toBe(
      "[Epic] METIS — Requirements analysis",
    );
  });
});
