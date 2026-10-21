/**
 * #1327 — `holdBatchReply`: a batch reply's topics past its planned share,
 * least important last, become its tail. Pure; no model.
 */
import { describe, expect, it } from "vitest";
import { citedSourceIds, holdBatchReply } from "./batch-hold.js";
import { renderedCitationLength } from "./citation-footnotes.js";

/** A topic of about `chars` characters, each paragraph citing `cites`. */
function topic(heading: string, cites: string[], paragraphs = 2, level = "###"): string {
  const marker = cites.map((id) => ` [${id}]`).join("");
  return [
    `${level} ${heading}`,
    ...Array.from(
      { length: paragraphs },
      (_, p) => `${heading} paragraph ${p}: the policy holds for every request.${marker}`,
    ),
  ].join("\n\n");
}

const rankOf = (id: string): number | undefined => {
  const m = /^facts:mod(\d+):\d+$/.exec(id);
  return m ? Number(m[1]) : undefined;
};

const headings = (markdown: string): string[] =>
  markdown
    .split("\n")
    .filter((line) => /^#{2,6} /.test(line))
    .map((line) => line.replace(/^#+ /, ""));

describe("holdBatchReply", () => {
  // Written as a model regroups: the most important module (mod0) LAST.
  const reply = [
    "## Business Rules",
    "Intro paragraph for the part.",
    topic("Display Rules", ["facts:mod3:3"]),
    topic("Retention", ["facts:mod2:2"]),
    topic("Feed Entities", ["facts:mod1:1", "facts:mod3:3"]),
    topic("Content Entities", ["facts:mod0:0"]),
  ].join("\n\n");
  const size = reply.length;

  it("returns the reply unchanged when it fits its share", () => {
    expect(holdBatchReply(reply, size, { rankOf })).toEqual({
      markdown: reply,
      reordered: false,
      overflowTopics: [],
    });
  });

  it("moves the least important topics past the share to the end, most important first", () => {
    const held = holdBatchReply(reply, Math.floor(size * 0.6), { rankOf });
    expect(held.reordered).toBe(true);
    // The two that fit keep their places; mod0's topic, written last, is one.
    expect(headings(held.markdown)).toEqual([
      "Business Rules",
      "Feed Entities",
      "Content Entities",
      "Retention",
      "Display Rules",
    ]);
    expect(held.overflowTopics).toEqual(["Retention", "Display Rules"]);
    // Nothing is removed: every paragraph is still there.
    expect(held.markdown.length).toBe(size);
    expect(held.markdown).toContain("Intro paragraph for the part.");
  });

  it("ranks a topic by the most important module it cites", () => {
    // Feed Entities cites mod1 and mod3: it ranks as mod1, ahead of Retention (mod2).
    const held = holdBatchReply(reply, Math.floor(size * 0.6), { rankOf });
    expect(held.overflowTopics).not.toContain("Feed Entities");
  });

  it("leaves a topic that cites nothing it can rank where it was written", () => {
    const withUncited = [
      "## Rules",
      topic("Overview", ["rag:doc:0"]),
      topic("Minor", ["facts:mod5:5"]),
      topic("Core", ["facts:mod0:0"]),
    ].join("\n\n");
    const overview = topic("Overview", ["rag:doc:0"]).length;
    const core = topic("Core", ["facts:mod0:0"]).length;
    const held = holdBatchReply(withUncited, "## Rules".length + overview + core + 12, { rankOf });
    // The overview stays first; only the ranked topics are ordered by priority.
    expect(headings(held.markdown)).toEqual(["Rules", "Overview", "Core", "Minor"]);
    expect(held.overflowTopics).toEqual(["Minor"]);
  });

  it("does not move a reply whose topics carry no rank at all", () => {
    const plain = ["## Rules", topic("A", []), topic("B", []), topic("C", [])].join("\n\n");
    expect(holdBatchReply(plain, 10).reordered).toBe(false);
  });

  it("keeps a priority prefix: a large important topic that does not fit stops it", () => {
    // The #1353 review's probe: the most important topic is the largest and
    // does not fit; a smaller, less important one would. Keeping that one
    // would make the cap cut the most important topic first.
    const para = (n: number, id: string) => `${"x".repeat(n)} [${id}]`;
    const reply = [
      "## S",
      "### Big A",
      para(500, "facts:mod0:0"),
      "### Small C",
      para(50, "facts:mod2:2"),
      "### Mid B",
      para(200, "facts:mod1:1"),
    ].join("\n\n");
    const held = holdBatchReply(reply, 400, { rankOf });
    expect(headings(held.markdown)).toEqual(["S", "Big A", "Mid B", "Small C"]);
    expect(held.overflowTopics).toEqual(["Big A", "Mid B", "Small C"]);
  });

  it("keeps an unequal-sized prefix in written order and moves the rest in priority order", () => {
    const reply = [
      "## Rules",
      topic("Small minor", ["facts:mod4:4"], 1),
      topic("Large", ["facts:mod1:1"], 8),
      topic("Mid", ["facts:mod2:2"], 3),
      topic("Core", ["facts:mod0:0"], 2),
    ].join("\n\n");
    const core = topic("Core", ["facts:mod0:0"], 2).length;
    const small = topic("Small minor", ["facts:mod4:4"], 1).length;
    // Room for Core and for Small minor, not for Large: Large ends the prefix,
    // so Small minor (less important than Large) is overflow too.
    const held = holdBatchReply(reply, "## Rules".length + core + small + 12, { rankOf });
    expect(headings(held.markdown)).toEqual(["Rules", "Core", "Large", "Mid", "Small minor"]);
    expect(held.overflowTopics).toEqual(["Large", "Mid", "Small minor"]);
  });

  it("never reorders numbered or step topics: only the cap's tail cut applies", () => {
    for (const [one, two] of [
      ["1. Fetch", "2. Parse"],
      ["1) Fetch", "2) Parse"],
      ["Step 1: Fetch", "Step 2: Parse"],
    ]) {
      const steps = [
        "## Workflow",
        topic(one, ["facts:mod3:3"]),
        topic(two, ["facts:mod0:0"]),
      ].join("\n\n");
      expect(holdBatchReply(steps, 50, { rankOf }).reordered).toBe(false);
    }
    // Control: the same topics unnumbered are reordered.
    const plain = [
      "## Workflow",
      topic("Fetch", ["facts:mod3:3"]),
      topic("Parse", ["facts:mod0:0"]),
    ].join("\n\n");
    expect(holdBatchReply(plain, 50, { rankOf }).reordered).toBe(true);
  });

  it("measures with the given measure: citations count as rendered", () => {
    const long = `facts:repo:${encodeURIComponent(JSON.stringify(["c1", "c2", "src/mod0"]))}:0`;
    const cited = ["## Rules", topic("Core", [long], 3), topic("Minor", [long], 3)].join("\n\n");
    // Over the share as drafted, within it as rendered.
    const share = renderedCitationLength(cited);
    expect(cited.length).toBeGreaterThan(share);
    expect(holdBatchReply(cited, share, { measure: renderedCitationLength }).reordered).toBe(false);
  });

  it("takes the topics under a single opening heading, at whatever depth they are written", () => {
    const deep = [
      "## Rules",
      topic("Minor", ["facts:mod3:3"], 2, "####"),
      topic("Core", ["facts:mod0:0"], 2, "####"),
    ].join("\n\n");
    const held = holdBatchReply(deep, Math.floor(deep.length * 0.6), { rankOf });
    expect(headings(held.markdown)).toEqual(["Rules", "Core", "Minor"]);
  });

  it("takes several top-level headings as topics when there is no single opening one", () => {
    const flat = [topic("Minor", ["facts:mod3:3"]), topic("Core", ["facts:mod0:0"])].join("\n\n");
    const held = holdBatchReply(flat, Math.floor(flat.length * 0.6), { rankOf });
    expect(headings(held.markdown)).toEqual(["Core", "Minor"]);
  });

  it("moves a topic with its sub-topics, and drops only the rules between topics", () => {
    const nested = [
      "## Rules",
      "---",
      topic("Minor", ["facts:mod3:3"]),
      "#### Minor detail",
      "Detail of the minor topic.",
      "---",
      topic("Core", ["facts:mod0:0"]),
      "| a | b |\n|---|---|\n| 1 | 2 |",
    ].join("\n\n");
    const held = holdBatchReply(nested, Math.floor(nested.length * 0.6), { rankOf });
    expect(headings(held.markdown)).toEqual(["Rules", "Core", "Minor", "Minor detail"]);
    expect(held.markdown).not.toContain("\n---\n");
    expect(held.markdown).toContain("| 1 | 2 |");
    expect(held.markdown.indexOf("Detail of the minor topic.")).toBeGreaterThan(
      held.markdown.indexOf("### Minor"),
    );
  });

  it("keeps a code fence whole when it moves its topic", () => {
    const core = topic("Core", ["facts:mod0:0"]);
    const fenced = [
      "## Rules",
      `### Minor\n\nText [facts:mod3:3]\n\n\`\`\`\nline one\n\nline two\n\`\`\``,
      core,
    ].join("\n\n");
    const held = holdBatchReply(fenced, "## Rules".length + core.length + 10, { rankOf });
    expect(held.overflowTopics).toEqual(["Minor"]);
    expect(held.markdown.endsWith("```\nline one\n\nline two\n```")).toBe(true);
  });

  it("keeps the input's line endings", () => {
    const crlf = reply.replace(/\n/g, "\r\n");
    const held = holdBatchReply(crlf, Math.floor(size * 0.6), { rankOf });
    expect(held.reordered).toBe(true);
    expect(held.markdown.replace(/\r\n/g, "")).not.toContain("\n");
    expect(held.markdown).toContain("\r\n");
  });

  it("leaves a reply with no heading, or one heading over its share, as written", () => {
    const prose = "One paragraph.\n\nAnother paragraph that is long enough to be over.";
    expect(holdBatchReply(prose, 10).reordered).toBe(false);
    const single = `## Rules\n\n${"Text. ".repeat(50)}`;
    expect(holdBatchReply(single, 10).reordered).toBe(false);
    const one = ["## Rules", topic("Only", ["facts:mod0:0"])].join("\n\n");
    // Its one topic is past the share, but already where overflow goes.
    expect(holdBatchReply(one, 10, { rankOf })).toEqual({
      markdown: one,
      reordered: false,
      overflowTopics: [],
    });
  });
});

describe("citedSourceIds", () => {
  it("reads every id of a marker cluster, and nothing outside markers", () => {
    expect(
      citedSourceIds(
        "A [facts:a:1] b [facts:b:2, facts:c:3; rag:doc:0] and facts:bare:9 and [web:x] [not:this]",
      ),
    ).toEqual(["facts:a:1", "facts:b:2", "facts:c:3", "rag:doc:0", "web:x"]);
  });

  it("stays linear on a reply full of unclosed markers", () => {
    // A wall-clock bound with a wide margin either way: the quadratic scan of
    // these 280,000 characters took about 5 s, the linear one about 1 ms.
    const hostile = "[facts:".repeat(40_000);
    const started = performance.now();
    expect(citedSourceIds(`${hostile}[facts:ok:1]`)).toEqual(["facts:ok:1"]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
