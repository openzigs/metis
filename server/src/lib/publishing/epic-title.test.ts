/**
 * Issue #23 — the generated epic draft used to be titled with an internal id
 * (`[Epic] METIS — Analysis cmubq3ls`). It is now titled from what was analysed.
 */
import { describe, expect, it } from "vitest";
import { buildEpicTitle, buildLegacyEpicTitle, EPIC_TITLE_SUBJECT_MAX } from "./epic-title.js";

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
        "[Epic] METIS — Analysis of 2026-09-29 14:05:33 UTC",
      );
    }
  });

  describe("#1064 — named after the batch, not after one requirement", () => {
    // The run-7 walkthrough text: five imported requirements, one bullet each.
    const FIVE = [
      "- Mark all as read older than X",
      "- Terminate all sessions for a user",
      "- Per-feed IPv4/IPv6 forcing preference",
      "- Per-feed last successful refresh timestamp",
      "- Cross-feed entry deduplication",
    ].join("\n");

    it("does not title a list of requirements after its first item", () => {
      const title = buildEpicTitle("Miniflux", analysis({ extraInstructions: FIVE }));
      expect(title).toBe(
        "[Epic] Miniflux — 5 stated requirements (analysis of 2026-09-29 14:05:33 UTC)",
      );
      expect(title).not.toContain("Mark all as read");
    });

    it("counts only the opening list, and numbered items too", () => {
      const text = "1. First\n2) Second\n\nSome free text the user also typed.\n- detail";
      expect(buildEpicTitle("P", analysis({ extraInstructions: text }))).toBe(
        "[Epic] P — 2 stated requirements (analysis of 2026-09-29 14:05:33 UTC)",
      );
    });

    it("uses the heading when the user gave the list one", () => {
      const text = `## Reader quality-of-life batch\n${FIVE}`;
      expect(buildEpicTitle("Miniflux", analysis({ extraInstructions: text }))).toBe(
        "[Epic] Miniflux — Reader quality-of-life batch",
      );
    });

    it("prefers an import label to a count when the list has no heading", () => {
      expect(
        buildEpicTitle("Miniflux", analysis({ extraInstructions: FIVE, label: "Q3 backlog" })),
      ).toBe("[Epic] Miniflux — Q3 backlog");
    });

    it("still titles one stated requirement after itself, detail list or not", () => {
      expect(buildEpicTitle("P", analysis({ extraInstructions: "- Dark mode" }))).toBe(
        "[Epic] P — Dark mode",
      );
      const withDetail = "Export results to CSV\n- include headers\n- UTF-8";
      expect(buildEpicTitle("P", analysis({ extraInstructions: withDetail }))).toBe(
        "[Epic] P — Export results to CSV",
      );
    });

    describe("the list shapes people actually write", () => {
      const WHEN = "(analysis of 2026-09-29 14:05:33 UTC)";
      const title = (text: string) => buildEpicTitle("P", analysis({ extraInstructions: text }));

      it("a loose list — a blank line between the items", () => {
        expect(title("- Mark all as read\n\n- Terminate sessions\n\n- Dedupe entries")).toBe(
          `[Epic] P — 3 stated requirements ${WHEN}`,
        );
        expect(title("1. First\n\n2. Second")).toBe(`[Epic] P — 2 stated requirements ${WHEN}`);
      });

      it("items with wrapped, indented or nested continuation lines", () => {
        const text = [
          "- Mark all as read older than a",
          "  number of days the user chooses",
          "- Terminate all sessions for a user",
          "wrapped without an indent",
          "- Cross-feed deduplication",
          "  - by URL",
          "  - by content hash",
        ].join("\n");
        expect(title(text)).toBe(`[Epic] P — 3 stated requirements ${WHEN}`);
      });

      it("one imported item followed by a typed list, as the start form writes it", () => {
        // `composeImportedRequirementInput`: one bullet, a bare heading, the list.
        const text =
          "- Imported: per-feed refresh timestamp\n\n## Requirements\n\n- Dark mode\n- Offline reading";
        expect(title(text)).toBe(`[Epic] P — 3 stated requirements ${WHEN}`);
        expect(title(text)).not.toContain("Imported");
      });

      it("none of them is named after its first requirement, and the old title still finds the old epic", () => {
        for (const text of [
          "- A one\n\n- B two",
          "- A one\n  more\n- B two",
          "- A one\n\n## Requirements\n\n- B two\n- C three",
        ]) {
          const a = analysis({ extraInstructions: text });
          expect(buildEpicTitle("P", a)).not.toContain("A one");
          // The title is the dedup key: an epic drafted under the old rule is
          // looked up by the OLD title, which is still the first line.
          expect(buildLegacyEpicTitle("P", a)).toBe("[Epic] P — A one");
        }
      });

      it("still reads these as ONE stated requirement, titled by its first line", () => {
        for (const [text, subject] of [
          ["- Dark mode\n\nSome notes about it.", "Dark mode"],
          ["- Dark mode\n  with a wrapped line", "Dark mode"],
          ["- Dark mode\n\n## Background\n\n- a\n- b", "Dark mode"],
          ["Export to CSV\n\n- include headers\n- UTF-8", "Export to CSV"],
          ["- Only item\n\n## Requirements\n\nno list here", "Only item"],
        ] as const) {
          expect(title(text)).toBe(`[Epic] P — ${subject}`);
        }
      });

      it("a list ends at the first paragraph after a blank line", () => {
        expect(title("- a\n- b\n\nA paragraph.\n\n- not counted\n- nor this")).toBe(
          `[Epic] P — 2 stated requirements ${WHEN}`,
        );
      });
    });

    it("drops the time when the run has no start time", () => {
      expect(buildEpicTitle("P", analysis({ extraInstructions: FIVE }, null))).toBe(
        "[Epic] P — 5 stated requirements",
      );
    });

    it("is the same title every time for the same run (it is the dedup key)", () => {
      const a = analysis({ extraInstructions: FIVE });
      expect(buildEpicTitle("P", a)).toBe(buildEpicTitle("P", a));
    });
  });

  describe("buildLegacyEpicTitle — the pre-#1064 title, to find an epic that already has it", () => {
    it("is the first line of the requirement text, even when that is one of a list", () => {
      const a = analysis({ extraInstructions: "- Mark all as read\n- Terminate sessions" });
      expect(buildLegacyEpicTitle("Miniflux", a)).toBe("[Epic] Miniflux — Mark all as read");
      expect(buildEpicTitle("Miniflux", a)).not.toBe(buildLegacyEpicTitle("Miniflux", a));
    });

    it("is the import label when there is no requirement text", () => {
      expect(buildLegacyEpicTitle("P", analysis({ label: "Q3 backlog" }))).toBe(
        "[Epic] P — Q3 backlog",
      );
    });

    it("agrees with the current rule wherever that rule did not change", () => {
      for (const meta of [
        null,
        {},
        { extraInstructions: "Export results to CSV" },
        { extraInstructions: "## Batch name\n- a\n- b" },
        { label: "Q3 backlog" },
      ]) {
        const a = analysis(meta);
        expect(buildLegacyEpicTitle("P", a)).toBe(buildEpicTitle("P", a));
      }
    });
  });

  it("tolerates unparseable metadata", () => {
    const a = { id: "cmubq3ls", startedAt: STARTED, metadata: "{not json" };
    expect(buildEpicTitle("METIS", a)).toBe("[Epic] METIS — Analysis of 2026-09-29 14:05:33 UTC");
    const arr = { id: "cmubq3ls", startedAt: STARTED, metadata: "[1,2]" };
    expect(buildEpicTitle("METIS", arr)).toBe("[Epic] METIS — Analysis of 2026-09-29 14:05:33 UTC");
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
