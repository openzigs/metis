/**
 * Tests for Epic #486 / Issue #491 — Document Exporters.
 */
import { describe, it, expect } from "vitest";
import { exportDocument } from "../../src/lib/docs-gen/exporters.js";

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

// The #686 mermaid render-security tests live in exporters-render-security.test.ts,
// which stubs puppeteer so they never spawn a real Chromium under the fan-out (#388).
