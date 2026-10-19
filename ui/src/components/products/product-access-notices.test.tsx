/**
 * #1261 — the product page says how many repos are hidden from the reader, and a
 * generated document says when it was built without some of them. Counts only.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HiddenReposNotice, PartialDocNotice } from "./product-access-notices";
import { partialDocRepoCount } from "@/lib/products-api";

const metadata = (m: object) => ({ metadata: JSON.stringify(m) });

describe("HiddenReposNotice (#1261)", () => {
  it("says how many repos are hidden", () => {
    render(<HiddenReposNotice count={3} />);
    expect(screen.getByRole("note")).toHaveTextContent("3 repos hidden.");
  });

  it("uses the singular for one", () => {
    render(<HiddenReposNotice count={1} />);
    expect(screen.getByRole("note")).toHaveTextContent("1 repo hidden.");
  });

  it.each([0, undefined])("renders nothing for %s", (count) => {
    const { container } = render(<HiddenReposNotice count={count} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("PartialDocNotice (#1261)", () => {
  it("says how many repos the document was built without", () => {
    render(<PartialDocNotice doc={metadata({ partial: true, inaccessibleRepoCount: 2 })} />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "Built without 2 repos the person who ran it couldn't access",
    );
  });

  it("names no repo, even when the metadata records source ids", () => {
    render(
      <PartialDocNotice
        doc={metadata({ partial: true, inaccessibleRepoCount: 1, repoConnectionIds: ["rc-a"] })}
      />,
    );
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("Built without 1 repo the person");
    expect(note).not.toHaveTextContent("rc-a");
  });

  it.each([
    ["a complete doc", { partial: false, inaccessibleRepoCount: 0 }],
    ["a doc written before the field", { repoConnectionIds: ["rc-a"] }],
  ])("renders nothing for %s", (_label, m) => {
    const { container } = render(<PartialDocNotice doc={metadata(m)} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("partialDocRepoCount (#1261)", () => {
  it("reads the count off a partial doc", () => {
    expect(partialDocRepoCount(metadata({ partial: true, inaccessibleRepoCount: 4 }))).toBe(4);
  });

  it("is 0 for unparseable or non-object metadata", () => {
    expect(partialDocRepoCount({ metadata: "{not json" })).toBe(0);
    expect(partialDocRepoCount({ metadata: "null" })).toBe(0);
  });

  it("is 0 when partial is not exactly true", () => {
    expect(partialDocRepoCount(metadata({ partial: "yes", inaccessibleRepoCount: 2 }))).toBe(0);
  });

  it("still reports a partial doc whose count is missing or malformed", () => {
    expect(partialDocRepoCount(metadata({ partial: true }))).toBe(1);
    expect(partialDocRepoCount(metadata({ partial: true, inaccessibleRepoCount: -2 }))).toBe(1);
  });
});
