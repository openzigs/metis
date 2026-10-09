/**
 * Issue #979 — requirement bodies showed raw Markdown and the
 * `<!-- metis:clarifications:start -->` markers as text.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RequirementBody, stripInternalMarkers } from "./RequirementBody";

const enriched = [
  "Users can **export** feeds.",
  "",
  "<!-- metis:clarifications:start -->",
  "## Clarifications",
  "",
  "- **Q:** Which format?",
  "  **A:** OPML",
  "<!-- metis:clarifications:end -->",
].join("\n");

describe("RequirementBody", () => {
  it("renders Markdown instead of showing its syntax", () => {
    render(<RequirementBody body={enriched} />);
    const body = screen.getByTestId("requirement-body");
    expect(screen.getByRole("heading", { name: "Clarifications" })).toBeInTheDocument();
    expect(screen.getByText("export").tagName).toBe("STRONG");
    expect(body.querySelector("li")).not.toBeNull();
    expect(body.textContent).not.toMatch(/\*\*|##/);
  });

  it("hides the clarification markers", () => {
    render(<RequirementBody body={enriched} />);
    expect(screen.getByTestId("requirement-body").textContent).not.toContain("metis:");
  });

  it("does not turn raw HTML in a body into markup", () => {
    const { container } = render(
      <RequirementBody
        body={'Hi <img src=x onerror="alert(1)"> <script>alert(2)</script> there'}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("neutralises a javascript: link", () => {
    const { container } = render(<RequirementBody body={"[click](javascript:alert(1))"} />);
    const href = container.querySelector("a")?.getAttribute("href") ?? "";
    expect(href).not.toMatch(/^javascript:/i);
  });

  it("renders nothing for an empty or marker-only body", () => {
    const { container } = render(<RequirementBody body={null} />);
    expect(container).toBeEmptyDOMElement();
    const markersOnly = render(
      <RequirementBody
        body={"<!-- metis:clarifications:start -->\n<!-- metis:clarifications:end -->"}
      />,
    );
    expect(markersOnly.container).toBeEmptyDOMElement();
  });
});

describe("stripInternalMarkers", () => {
  it("removes both markers and leaves the content", () => {
    expect(stripInternalMarkers(enriched)).not.toContain("<!--");
    expect(stripInternalMarkers(enriched)).toContain("## Clarifications");
  });
});
