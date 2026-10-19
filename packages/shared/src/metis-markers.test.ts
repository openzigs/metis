import { describe, expect, it } from "vitest";
import { findMetisMarkers, stripMetisMarkers } from "./metis-markers.js";

describe("findMetisMarkers — #1162", () => {
  it("finds every marker the stripper hides, whitespace variants included", () => {
    const text = "a <!--metis:clarifications:start--> b <!--  metis:clarifications:end  --> c";
    expect(findMetisMarkers(text)).toEqual([
      { name: "clarifications:start", index: 2, length: 33 },
      { name: "clarifications:end", index: 38, length: 35 },
    ]);
    expect(stripMetisMarkers(text)).not.toContain("metis:");
  });

  it("finds nothing in plain text or a non-METIS comment", () => {
    expect(findMetisMarkers("Body. <!-- other:thing -->")).toEqual([]);
  });
});

describe("stripMetisMarkers — #1170", () => {
  it("removes the clarification markers and keeps the block", () => {
    const body = [
      "Body.",
      "",
      "<!-- metis:clarifications:start -->",
      "## Clarifications",
      "- **Q:** q",
      "<!-- metis:clarifications:end -->",
      "",
      "After.",
    ].join("\n");
    expect(stripMetisMarkers(body)).toBe(
      ["Body.", "", "", "## Clarifications", "- **Q:** q", "", "", "After."].join("\n"),
    );
  });

  it("strips a long run of trailing tabs in linear time", () => {
    const line = `x${"\t".repeat(100_000)}y <!-- metis:a -->`;
    const started = performance.now();
    expect(stripMetisMarkers(line)).toBe(`x${"\t".repeat(100_000)}y`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps a paragraph typed straight after the end marker apart from the last answer", () => {
    // A marker line is a line break; removing it outright would make "Typed."
    // a lazy continuation of the list item above.
    expect(stripMetisMarkers("- **A:** a\n<!-- metis:clarifications:end -->\nTyped.")).toBe(
      "- **A:** a\n\nTyped.",
    );
  });

  it("removes an inline marker and the space before it, keeping the line", () => {
    expect(
      stripMetisMarkers(
        "> **Check the criteria.** Edit them. <!-- metis:criteria-predate-answers -->",
      ),
    ).toBe("> **Check the criteria.** Edit them.");
  });

  it("removes a marker with odd spacing and every marker on a line", () => {
    expect(stripMetisMarkers("a <!--metis:x--> b <!--  metis:y:z  -->")).toBe("a  b");
  });

  // #1237 — `findMetisMarkers` finds a marker split across lines, so the
  // stripper must remove it too: what one finds, the other hides.
  it("removes a marker split across lines, as findMetisMarkers finds it", () => {
    const inline = "> Check them. <!--\nmetis:criteria-predate-answers\n-->\nAfter.";
    expect(findMetisMarkers(inline)).toHaveLength(1);
    expect(stripMetisMarkers(inline)).toBe("> Check them.\nAfter.");

    // Alone on its lines: one blank line, as a one-line marker leaves.
    const alone = "- **A:** a\n<!--\n  metis:clarifications:end\n-->\nTyped.";
    expect(stripMetisMarkers(alone)).toBe("- **A:** a\n\nTyped.");

    for (const text of [inline, alone]) {
      expect(findMetisMarkers(stripMetisMarkers(text))).toEqual([]);
    }
  });

  it("leaves other comments and marker-free text alone, and is stable across calls", () => {
    const text = "<!-- not metis -->\n  indented  \n<!-- metis: generated from plan.md v2 -->";
    expect(stripMetisMarkers(text)).toBe(text);
    expect(stripMetisMarkers("x <!-- metis:a -->")).toBe("x");
    expect(stripMetisMarkers("x <!-- metis:a -->")).toBe("x");
  });
});
