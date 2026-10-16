import { describe, expect, it } from "vitest";
import { stripMetisMarkers } from "./metis-markers.js";

describe("stripMetisMarkers — #1170", () => {
  it("removes the clarification markers with their lines and keeps the block", () => {
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
      ["Body.", "", "## Clarifications", "- **Q:** q", "", "After."].join("\n"),
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
