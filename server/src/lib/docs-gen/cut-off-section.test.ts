import { describe, expect, it } from "vitest";
import { cutOffNote, trimCutOffSection } from "./cut-off-section.js";
import { SHORTENED_NOTE_LEAD } from "./section-size.js";

const lastLine = (markdown: string): string =>
  markdown
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1) ?? "";

describe("#1132 — trimCutOffSection", () => {
  it("removes the sub-section the model was writing, bare label and all (run 8's shape)", () => {
    const md = [
      "## Component Breakdown",
      "Intro and a diagram.",
      "### 6. Feed Reader",
      "**Purpose**: Reads feeds.",
      "**Responsibilities**:\n- Poll\n- Parse",
      "### 7. Outbound Integration Hub",
      "**Purpose**",
    ].join("\n\n");
    const cut = trimCutOffSection(md);
    expect(cut.trimmed).toBe(true);
    expect(cut.omittedTopics).toEqual(["7. Outbound Integration Hub"]);
    expect(cut.markdown).toContain("### 6. Feed Reader");
    expect(cut.markdown).not.toContain("### 7.");
    expect(lastLine(cut.markdown)).toBe("- Parse");
  });

  it("removes a sub-section cut mid-sentence and names it", () => {
    const md = "## A\n\nIntro.\n\n### One\n\nDone.\n\n### Two\n\nHalf a sent";
    const cut = trimCutOffSection(md);
    expect(cut.markdown).toBe("## A\n\nIntro.\n\n### One\n\nDone.");
    expect(cut.omittedTopics).toEqual(["Two"]);
  });

  it("cuts the innermost sub-section, keeping complete deeper ones before it", () => {
    const md = "## A\n\n### One\n\nDone.\n\n### Two\n\n#### 2.1\n\nComplete.\n\n#### 2.2\n\nHalf";
    const cut = trimCutOffSection(md);
    expect(cut.markdown).toBe("## A\n\n### One\n\nDone.\n\n### Two\n\n#### 2.1\n\nComplete.");
    expect(cut.omittedTopics).toEqual(["2.2"]);
  });

  it("a single wrapper sub-section with no intro: keeps its complete children (review repro 1)", () => {
    const md = "## Components\n\n### 1. Wrapper\n\n#### 1.1 A\n\nok.\n\n#### 1.2 B\n\n**Purpose**";
    const cut = trimCutOffSection(md);
    expect(cut.trimmed).toBe(true);
    expect(cut.markdown).toBe("## Components\n\n### 1. Wrapper\n\n#### 1.1 A\n\nok.");
    expect(cut.omittedTopics).toEqual(["1.2 B"]);
  });

  it("nothing complete at all: still never ends on an empty heading or label (review repro 2)", () => {
    const cut = trimCutOffSection("## Components\n\n### 1. One\n\n**Purpose**");
    expect(cut).toEqual({
      markdown: "## Components",
      trimmed: true,
      omittedTopics: ["1. One"],
    });
  });

  it("looks only inside the last top-level block of a group that writes two sections", () => {
    const md = "## First\n\n### X\n\nDone.\n\n## Second\n\nComplete para.\n\nHalf a para";
    const cut = trimCutOffSection(md);
    // `Second` has no sub-sections: only the paragraph being written goes.
    expect(cut.markdown).toBe("## First\n\n### X\n\nDone.\n\n## Second\n\nComplete para.");
    expect(cut.omittedTopics).toEqual([]);
  });

  it("names a heading left with nothing under it once the cut paragraph goes", () => {
    const md = "## First\n\nDone.\n\n## Second\n\nHalf a para";
    const cut = trimCutOffSection(md);
    expect(cut.markdown).toBe("## First\n\nDone.");
    expect(cut.omittedTopics).toEqual(["Second"]);
  });

  it("drops a trailing heading the reply stopped right after", () => {
    const md = "## A\n\nDone.\n\n### Next";
    const cut = trimCutOffSection(md);
    expect(cut.markdown).toBe("## A\n\nDone.");
    expect(cut.omittedTopics).toEqual(["Next"]);
  });

  it("removes an unclosed fence or a half table with the sub-section that holds it", () => {
    const md = "## A\n\n### One\n\nDone.\n\n### Two\n\n| a | b |\n|---|---|\n| 1 |";
    expect(trimCutOffSection(md).markdown).toBe("## A\n\n### One\n\nDone.");
    const fence = "## A\n\n### One\n\nDone.\n\n### Two\n\n```mermaid\ngraph LR\nA-->";
    expect(trimCutOffSection(fence).markdown).toBe("## A\n\n### One\n\nDone.");
  });

  it("keeps the section as it was when nothing complete would be left and it ends on text", () => {
    for (const md of ["## A\n\nHalf a sent", "## A\n\n### One\n\nHalf", "Just text", ""]) {
      expect(trimCutOffSection(md)).toEqual({ markdown: md, trimmed: false, omittedTopics: [] });
    }
  });

  it("works on a section with no headings at all", () => {
    const cut = trimCutOffSection("Para one.\n\nPara two half");
    expect(cut).toEqual({ markdown: "Para one.", trimmed: true, omittedTopics: [] });
  });

  it("keeps the input's CRLF line endings, never mixing them", () => {
    const md = "## A\r\n\r\nIntro.\r\n\r\n### One\r\n\r\nDone.\r\n\r\n### Two\r\n\r\nHalf";
    const cut = trimCutOffSection(md);
    expect(cut.markdown).toBe("## A\r\n\r\nIntro.\r\n\r\n### One\r\n\r\nDone.");
    expect(cut.markdown.replace(/\r\n/g, "")).not.toContain("\n");
    expect(cut.omittedTopics).toEqual(["Two"]);
  });
});

describe("#1132 — cutOffNote", () => {
  it("opens like every shortened-section note and says plainly what happened", () => {
    const note = cutOffNote(["7. Outbound Integration Hub"]);
    expect(note.startsWith(SHORTENED_NOTE_LEAD)).toBe(true);
    expect(note).toContain("1 further topic was left out: 7. Outbound Integration Hub.");
    expect(note).toContain("Regenerate the document");
    expect(note).toContain("ask an administrator to raise the AI model's answer limit");
  });

  it("never implies the count is exact: topics never reached may be missing too", () => {
    expect(cutOffNote(["X"])).toContain("Topics it had not reached yet may be missing as well.");
  });

  it("still says detail is missing when no topic can be named", () => {
    expect(cutOffNote([])).toContain("Its remaining detail was left out.");
  });

  it("never claims a removal when nothing complete could be kept", () => {
    expect(cutOffNote([])).toContain("was removed");
    expect(cutOffNote([], { removed: false })).not.toContain("removed");
    expect(cutOffNote([], { removed: false })).toContain("its last part is unfinished");
  });

  it("says when the length cap shortened the section too", () => {
    expect(cutOffNote(["X"], { shortenedToChars: 60_000 })).toContain(
      "It was also shortened to about 60k characters",
    );
    expect(cutOffNote(["X"])).not.toContain("also shortened");
  });
});
