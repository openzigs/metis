/**
 * #1371 — Project Overview rendered raw markdown.
 *
 * The measured symptom on `/projects/{id}/overview` was a DOM check returning
 * `table` elements = **0** and `table a` links = 0, with `# Project Overview`,
 * `## Summary` and the `| ---: | --- |` delimiter row all printed literally.
 *
 * Falsifiable: against `main` this component did not exist and the page wrapped
 * the same string in a `<pre>`, so every `getByRole("table"|"heading")` here
 * fails.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverviewMarkdown, demoteHeadings } from "./overview-markdown";

/** A faithful slice of a real `project_overview.md`. */
const OVERVIEW_MD = [
  "# Project Overview — OrderBatch",
  "",
  "## Summary",
  "",
  "**OrderBatch** is indexed with 860 symbols across 7895 edges.",
  "",
  "## Top Symbols by In-Degree",
  "",
  "| Rank | Symbol | Kind | In-Degree | File |",
  "| ---: | --- | --- | ---: | --- |",
  "| 1 | `WmsClient.send` | method | 42 | `src/main/java/com/acme/WmsClient.java` |",
  "",
].join("\n");

describe("OverviewMarkdown (#1371)", () => {
  it("renders the symbol table as a real table element, not literal text", () => {
    render(<OverviewMarkdown markdown={OVERVIEW_MD} />);
    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "In-Degree" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: /WmsClient\.send/ })).toBeTruthy();
  });

  it("never prints the markdown table delimiter row as visible text", () => {
    const { container } = render(<OverviewMarkdown markdown={OVERVIEW_MD} />);
    expect(container.textContent).not.toContain("| ---: | --- |");
  });

  // #29 — the page's own <h1> is "Code Overview — name", so the document's
  // headings nest one level beneath it; the body contributes no <h1>.
  it("renders headings as real heading elements, one level below the page title", () => {
    render(<OverviewMarkdown markdown={OVERVIEW_MD} />);
    expect(screen.getByRole("heading", { level: 2, name: /Project Overview/ })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Summary" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: "Top Symbols by In-Degree" }),
    ).toBeTruthy();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("does not leave `#` or `**` emphasis markers in the visible text", () => {
    const { container } = render(<OverviewMarkdown markdown={OVERVIEW_MD} />);
    expect(container.textContent).not.toContain("# Project Overview");
    expect(container.textContent).not.toContain("**OrderBatch**");
    expect(container.textContent).toContain("OrderBatch");
  });

  it("uses the theme foreground token rather than a hard-coded low-contrast grey", () => {
    const { container } = render(<OverviewMarkdown markdown={OVERVIEW_MD} />);
    const body = container.querySelector('[data-testid="overview-markdown"]');
    expect(body?.className).toContain("text-foreground");
    expect(body?.className).not.toContain("text-zinc-400");
    expect(body?.className).not.toContain("text-zinc-500");
  });

  it("renders an empty document without throwing", () => {
    const { container } = render(<OverviewMarkdown markdown="" />);
    expect(container.querySelector('[data-testid="overview-markdown"]')).toBeTruthy();
  });
});

describe("demoteHeadings (#29)", () => {
  it("moves every ATX heading down one level", () => {
    expect(demoteHeadings("# A\n## B\n##### E")).toBe("## A\n### B\n###### E");
  });

  it("leaves a level-6 heading, and text that only starts with #, alone", () => {
    expect(demoteHeadings("###### F\n#hashtag")).toBe("###### F\n#hashtag");
  });

  it("leaves lines inside backtick and tilde fences alone", () => {
    const md = "```sh\n# comment\n```\n~~~\n# also\n~~~\n# Real";
    expect(demoteHeadings(md)).toBe("```sh\n# comment\n```\n~~~\n# also\n~~~\n## Real");
  });

  it("does not close a backtick fence on a tilde line", () => {
    expect(demoteHeadings("```\n~~~\n# in code\n```\n# out")).toBe(
      "```\n~~~\n# in code\n```\n## out",
    );
  });
});
