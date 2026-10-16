import { describe, expect, it } from "vitest";
import { stripMetisMarkers } from "./metis-markers.js";

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

  it("leaves other comments and marker-free text alone, and is stable across calls", () => {
    const text = "<!-- not metis -->\n  indented  \n<!-- metis: generated from plan.md v2 -->";
    expect(stripMetisMarkers(text)).toBe(text);
    expect(stripMetisMarkers("x <!-- metis:a -->")).toBe("x");
    expect(stripMetisMarkers("x <!-- metis:a -->")).toBe("x");
  });
});
