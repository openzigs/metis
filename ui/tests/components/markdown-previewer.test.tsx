/**
 * Tests for Epic #486 / Issue #492 — Markdown Previewer component.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownPreviewer } from "../../src/components/markdown-previewer";

// Mock IntersectionObserver for jsdom
beforeAll(() => {
  global.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
});

describe("MarkdownPreviewer", () => {
  it("renders markdown content", () => {
    render(<MarkdownPreviewer content="# Hello World\n\nSome paragraph." />);
    expect(screen.getByTestId("markdown-content")).toBeDefined();
    expect(screen.getByTestId("markdown-content").innerHTML).toContain("Hello World");
  });

  it("renders table of contents from headings", () => {
    const md = "# Title\n## Section One\n## Section Two\n### Subsection";
    render(<MarkdownPreviewer content={md} />);
    const toc = screen.getByTestId("markdown-toc");
    expect(toc).toBeDefined();
    expect(toc.textContent).toContain("Section One");
    expect(toc.textContent).toContain("Section Two");
  });

  it("hides TOC when showToc=false", () => {
    const md = "# Title\n## Section One\n## Section Two\n### Sub\n## Another";
    render(<MarkdownPreviewer content={md} showToc={false} />);
    expect(screen.queryByTestId("markdown-toc")).toBeNull();
  });

  it("renders code blocks", () => {
    const md = "```typescript\nconst x = 1;\n```";
    render(<MarkdownPreviewer content={md} />);
    const content = screen.getByTestId("markdown-content");
    expect(content.innerHTML).toContain("language-typescript");
    expect(content.innerHTML).toContain("const x = 1;");
  });

  it("renders mermaid blocks with language-mermaid code element", () => {
    const md = "```mermaid\ngraph LR\n  A --> B\n```";
    render(<MarkdownPreviewer content={md} />);
    const content = screen.getByTestId("markdown-content");
    expect(content.innerHTML).toContain("language-mermaid");
  });

  it("renders tables", () => {
    const md = "| Name | Type |\n|------|------|\n| foo | string |";
    render(<MarkdownPreviewer content={md} />);
    const content = screen.getByTestId("markdown-content");
    expect(content.innerHTML).toContain("<table");
    expect(content.innerHTML).toContain("foo");
  });

  it("renders inline code", () => {
    const md = "Use `myFunction()` here.";
    render(<MarkdownPreviewer content={md} />);
    const content = screen.getByTestId("markdown-content");
    // react-markdown emits a <code> element for inline code with our
    // custom Tailwind utility classes. Check for the wrapper element
    // and the source text instead of a brittle class name.
    expect(content.innerHTML).toMatch(/<code[^>]*>myFunction\(\)<\/code>/);
  });

  it("renders math notation via KaTeX", () => {
    const md = "The formula is $x^2 + y^2 = z^2$.";
    render(<MarkdownPreviewer content={md} />);
    const content = screen.getByTestId("markdown-content");
    // rehype-katex renders inline math into <span class="katex">...
    expect(content.innerHTML).toContain("katex");
  });

  it("renders blockquotes", () => {
    const md = "> This is a quote";
    render(<MarkdownPreviewer content={md} />);
    const content = screen.getByTestId("markdown-content");
    expect(content.innerHTML).toContain("<blockquote>");
  });

  it("applies className prop", () => {
    render(<MarkdownPreviewer content="# Test" className="my-class" />);
    expect(screen.getByTestId("markdown-previewer").className).toContain("my-class");
  });
});
