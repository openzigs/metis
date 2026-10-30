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

  // #1567 — the stored form the clarification block writes (`<` kept as typed,
  // a tag-shaped `<` as `&lt;`) reads as the analyst's text on the hub and review.
  it("shows a clarification answer's comparisons and tag-shaped text as typed", () => {
    const answered = [
      "<!-- metis:clarifications:start -->",
      "- **Q:** Which cutoff?",
      "  **A:** exclusive (published_at < X), then <=, a < b > c and &lt;tag> AT&T &amp;lt;",
      "<!-- metis:clarifications:end -->",
    ].join("\n");
    render(<RequirementBody body={answered} />);
    expect(screen.getByTestId("requirement-body").textContent).toContain(
      "exclusive (published_at < X), then <=, a < b > c and <tag> AT&T &lt;",
    );
  });

  it("hides the clarification markers", () => {
    render(<RequirementBody body={enriched} />);
    expect(screen.getByTestId("requirement-body").textContent).not.toContain("metis:");
  });

  it("drops raw HTML from a body instead of printing or rendering it", () => {
    const { container } = render(
      <RequirementBody
        body={
          'Hi <img src=x onerror="alert(1)"> <iframe src="https://evil.example"></iframe> there'
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    // The element checks above pass with `skipHtml` removed, and even against a
    // plain-text renderer: without rehype-raw, react-markdown prints raw HTML as
    // TEXT. Only the text tells whether the tags were dropped.
    const text = screen.getByTestId("requirement-body").textContent ?? "";
    expect(text).not.toContain("<");
    expect(text).not.toContain("onerror");
    expect(text).not.toContain("evil.example");
    expect(text.replace(/\s+/g, " ")).toBe("Hi there");
  });

  it("drops a raw HTML block as well as inline tags", () => {
    render(<RequirementBody body={"Before\n\n<script>alert(2)</script>\n\nAfter"} />);
    const text = screen.getByTestId("requirement-body").textContent ?? "";
    expect(text).not.toContain("script");
    expect(text).not.toContain("alert(");
    expect(text.replace(/\s+/g, " ")).toBe("Before After");
  });

  it("leaves a javascript: link with no usable href", () => {
    const { container } = render(<RequirementBody body={"[click](javascript:alert(1))"} />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveTextContent("click");
    expect(link?.getAttribute("href")).toBe("");
    expect(container.innerHTML).not.toMatch(/javascript:/i);
  });

  // #998 — a body can be imported issue text: a remote image is a tracking beacon.
  describe("images", () => {
    it("shows a remote image as a link, never as an <img>", () => {
      const { container } = render(
        <RequirementBody body={"See ![the diagram](https://tracker.example/pixel.png?u=1) here"} />,
      );
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("[src]")).toBeNull();
      const link = screen.getByRole("link", { name: "the diagram" });
      expect(link).toHaveAttribute("href", "https://tracker.example/pixel.png?u=1");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    });

    it("shows a javascript: image as its alt text, with no src or href", () => {
      const { container } = render(<RequirementBody body={"![x](javascript:alert(1))"} />);
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("[src]")).toBeNull();
      expect(container.querySelector("a")).toBeNull();
      expect(screen.getByTestId("body-image-text")).toHaveTextContent("x");
      expect(container.innerHTML).not.toMatch(/javascript:/i);
    });

    it("shows a relative image as text: no request to this origin either", () => {
      const { container } = render(<RequirementBody body={"![logo](/api/auth/logout)"} />);
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("a")).toBeNull();
      expect(screen.getByTestId("body-image-text")).toHaveTextContent("logo");
    });

    it("labels an image that has no alt text", () => {
      render(<RequirementBody body={"![](https://tracker.example/pixel.png)"} />);
      expect(screen.getByRole("link", { name: "image" })).toBeInTheDocument();
    });
  });

  it("breaks a long unbroken token instead of overflowing its card", () => {
    render(<RequirementBody body={`https://example.com/${"a".repeat(300)}`} />);
    expect(screen.getByTestId("requirement-body")).toHaveClass("break-words");
  });

  describe("minHeadingLevel", () => {
    const headings = "# One\n\n## Two\n\n#### Four\n\n###### Six";

    it("renders headings as written by default", () => {
      render(<RequirementBody body={headings} />);
      expect(screen.getByRole("heading", { name: "One", level: 1 })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Two", level: 2 })).toBeInTheDocument();
    });

    it("pushes shallower headings down to the minimum and leaves deeper ones", () => {
      const { container } = render(<RequirementBody body={headings} minHeadingLevel={4} />);
      expect(container.querySelector("h1, h2, h3")).toBeNull();
      expect(screen.getByRole("heading", { name: "One", level: 4 })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Two", level: 4 })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Four", level: 4 })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Six", level: 6 })).toBeInTheDocument();
    });
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

  // Issue #998 — the criteria flag (#1116) is a second marker kind, written inline.
  it("removes every metis: marker kind", () => {
    const flagged = "> **Check the criteria.** <!-- metis:criteria-predate-answers -->";
    expect(stripInternalMarkers(flagged)).toBe("> **Check the criteria.**");
    expect(stripInternalMarkers("a <!--metis:some-future_marker:v2--> b")).toBe("a  b");
  });

  it("leaves an ordinary HTML comment for the renderer to drop", () => {
    expect(stripInternalMarkers("a <!-- note --> b")).toBe("a <!-- note --> b");
  });
});
