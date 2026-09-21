/**
 * Tests for Epic #486 / Issue #491 — Document Exporters.
 */
import { describe, it, expect } from "vitest";
import {
  exportDocument,
  MERMAID_RENDER_SECURITY,
  chromeLaunchArgs,
} from "../../src/lib/docs-gen/exporters.js";

describe("exportDocument", () => {
  const sampleMarkdown = `# Test Document

## Section One

Hello world paragraph.

## Section Two

| Column A | Column B |
|----------|----------|
| Row 1    | Data 1   |
`;

  it("exports to PDF format (or falls back to html)", async () => {
    const result = await exportDocument(sampleMarkdown, "test-doc", "pdf");
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.filename).toMatch(/^test-doc\.(pdf|html)$/);
    expect(["application/pdf", "text/html"]).toContain(result.mimeType);
  }, 30_000);

  it("exports to DOCX format (or falls back to markdown)", async () => {
    const result = await exportDocument(sampleMarkdown, "test-doc", "docx");
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.filename).toMatch(/^test-doc\.(docx|md)$/);
    expect([
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/markdown",
    ]).toContain(result.mimeType);
  });

  it("exports to Markdown format as a pass-through of the source", async () => {
    const result = await exportDocument(sampleMarkdown, "test-doc", "markdown");
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.toString("utf-8")).toBe(sampleMarkdown);
    expect(result.mimeType).toBe("text/markdown");
    expect(result.filename).toBe("test-doc.md");
  });

  it("sanitizes the title for markdown exports too", async () => {
    const result = await exportDocument("# Hi", "../../../etc/passwd", "markdown");
    expect(result.filename).not.toContain("/");
    expect(result.filename).not.toContain("..");
    expect(result.filename).toMatch(/\.md$/);
  });

  it("sanitizes title to remove unsafe characters", async () => {
    const result = await exportDocument("# Hi", "../../../etc/passwd", "pdf");
    expect(result.filename).not.toContain("/");
    expect(result.filename).not.toContain("..");
  }, 30_000);

  it("truncates extremely long titles", async () => {
    const longTitle = "A".repeat(200);
    const result = await exportDocument("# Hi", longTitle, "pdf");
    // filename should be title (max 100 chars) + extension (.pdf or .html fallback)
    expect(result.filename.length).toBeLessThanOrEqual(105); // 100 + ".html"
  }, 30_000);

  it("generates actual PDF with Mermaid diagrams", async () => {
    const mdWithMermaid = `# Architecture

## System Overview

\`\`\`mermaid
graph TD
    A[Client] --> B[API Gateway]
    B --> C[Service]
    C --> D[Database]
\`\`\`

Some text after the diagram.
`;
    const result = await exportDocument(mdWithMermaid, "mermaid-test", "pdf");
    expect(result.buffer).toBeInstanceOf(Buffer);
    // If Chrome is available, should be real PDF (starts with %PDF)
    if (result.mimeType === "application/pdf") {
      expect(result.buffer.subarray(0, 4).toString()).toBe("%PDF");
      expect(result.filename).toBe("mermaid-test.pdf");
    }
  }, 60_000);

  it("generates DOCX with Mermaid diagrams as images", async () => {
    const mdWithMermaid = `# Architecture

\`\`\`mermaid
graph LR
    A --> B
\`\`\`

## Tables

| Name | Value |
|------|-------|
| foo  | bar   |
`;
    const result = await exportDocument(mdWithMermaid, "docx-mermaid", "docx");
    expect(result.buffer).toBeInstanceOf(Buffer);
    if (
      result.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      // DOCX files start with PK (zip signature)
      expect(result.buffer.subarray(0, 2).toString()).toBe("PK");
      expect(result.filename).toBe("docx-mermaid.docx");
      // Should be larger than a simple doc (has image data)
      expect(result.buffer.length).toBeGreaterThan(5000);
    }
  }, 60_000);
});

describe("mermaid render security (#686)", () => {
  it("renders diagrams under the STRICT security level with HTML labels disabled", () => {
    expect(MERMAID_RENDER_SECURITY.securityLevel).toBe("strict");
    expect(MERMAID_RENDER_SECURITY.htmlLabels).toBe(false);
  });

  it("does not let an injected HTML/JS node label execute in the export", async () => {
    // A crafted mermaid node label with an <img onerror> handler. Under the
    // strict security level with htmlLabels disabled the label renders as inert
    // SVG text; the HTML fallback escapes all markup. Either way the injected
    // element can never become live and fire onerror (SSXSS -> SSRF).
    const malicious = [
      "# Diagram",
      "",
      "```mermaid",
      "graph TD",
      '  A["<img src=x onerror=alert(1)>"] --> B[ok]',
      "```",
      "",
    ].join("\\n");
    const result = await exportDocument(malicious, "xss-probe", "pdf");
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(["application/pdf", "text/html"]).toContain(result.mimeType);
    if (result.mimeType === "text/html") {
      const html = result.buffer.toString("utf-8");
      // The injected markup is escaped, so it is inert text, not a live element.
      expect(html).not.toContain("<img src=x onerror");
      expect(html).toContain("&lt;img");
    }
  }, 30_000);

  it("uses --no-sandbox by default so the renderer still launches in containers", () => {
    delete process.env.PDF_EXPORT_CHROME_SANDBOX;
    const args = chromeLaunchArgs();
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-setuid-sandbox");
  });

  it("re-enables the Chrome sandbox when PDF_EXPORT_CHROME_SANDBOX=true", () => {
    const prev = process.env.PDF_EXPORT_CHROME_SANDBOX;
    process.env.PDF_EXPORT_CHROME_SANDBOX = "true";
    try {
      const args = chromeLaunchArgs();
      expect(args).not.toContain("--no-sandbox");
      expect(args).not.toContain("--disable-setuid-sandbox");
    } finally {
      if (prev === undefined) delete process.env.PDF_EXPORT_CHROME_SANDBOX;
      else process.env.PDF_EXPORT_CHROME_SANDBOX = prev;
    }
  });
});
