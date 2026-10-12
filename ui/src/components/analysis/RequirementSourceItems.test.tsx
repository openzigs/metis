/**
 * Issue #1063 — a requirement card shows the imported item it came from: the
 * imported title, a link back, or "Added by the analysis". An imported title
 * and URL are tracker data and are never trusted as markup.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AnalysisSourceRequirement } from "@metis/shared";
import { ADDED_BY_ANALYSIS_TOOLTIP, RequirementSourceItems } from "./RequirementSourceItems";

const item = (over: Partial<AnalysisSourceRequirement> = {}): AnalysisSourceRequirement => ({
  candidateId: "NR-4",
  requirementId: "req-imported-4",
  title: "Add a button to terminate all sessions",
  externalSource: "github",
  externalId: "4074",
  externalUrl: "https://github.com/miniflux/v2/issues/4074",
  ...over,
});

describe("RequirementSourceItems", () => {
  it("shows the imported item's own title next to a link back to it", () => {
    render(<RequirementSourceItems sourceItems={[item()]} />);
    const line = screen.getByTestId("requirement-source-item-NR-4");
    expect(line).toHaveTextContent("Imported as: Add a button to terminate all sessions");
    const link = screen.getByRole("link", { name: "github #4074" });
    expect(link).toHaveAttribute("href", "https://github.com/miniflux/v2/issues/4074");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("lists every item of a requirement that merges two imported items", () => {
    render(
      <RequirementSourceItems
        sourceItems={[
          item(),
          item({ candidateId: "NR-5", title: "Force IPv4 or IPv6", externalId: "4538" }),
        ]}
      />,
    );
    expect(screen.getByTestId("requirement-source-items").querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByTestId("requirement-source-item-NR-5")).toHaveTextContent(
      "Force IPv4 or IPv6",
    );
  });

  it("marks a requirement the analysis added, and says what that means", () => {
    render(<RequirementSourceItems sourceItems={[]} />);
    const badge = screen.getByTestId("requirement-added-by-analysis");
    expect(badge).toHaveTextContent("Added by the analysis");
    expect(badge).toHaveAttribute("title", ADDED_BY_ANALYSIS_TOOLTIP);
    expect(screen.queryByTestId("requirement-source-items")).toBeNull();
  });

  it.each([null, undefined])("renders nothing when the source is not recorded (%s)", (value) => {
    const { container } = render(<RequirementSourceItems sourceItems={value} />);
    expect(container).toBeEmptyDOMElement();
    // "Not recorded" must never read as "added by the analysis".
    expect(screen.queryByTestId("requirement-added-by-analysis")).toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example/x",
    "not a url",
    " JaVaScRiPt:alert(1)",
  ])("does not link a URL that is not http(s): %s", (externalUrl) => {
    render(<RequirementSourceItems sourceItems={[item({ externalUrl })]} />);
    expect(screen.queryByRole("link")).toBeNull();
    // The reference is still shown, as text.
    expect(screen.getByTestId("requirement-source-item-NR-4")).toHaveTextContent("github #4074");
  });

  it("links a plain http URL too", () => {
    render(
      <RequirementSourceItems
        sourceItems={[item({ externalUrl: "http://jira.internal/browse/X-1" })]}
      />,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "http://jira.internal/browse/X-1");
  });

  it("shows only the source when the item has no number or URL", () => {
    render(
      <RequirementSourceItems
        sourceItems={[item({ externalId: null, externalUrl: null, externalSource: "linear" })]}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByTestId("requirement-source-item-NR-4")).toHaveTextContent("linear");
  });

  it("renders an imported title as text, never as markup", () => {
    const { container } = render(
      <RequirementSourceItems
        sourceItems={[item({ title: '<img src=x onerror="alert(1)"><b>bold</b>' })]}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByTestId("requirement-source-item-NR-4").textContent).toContain(
      '<img src=x onerror="alert(1)">',
    );
  });
});
