/**
 * Tests for Epic #486 / Issue #491 — Document Exporters.
 *
 * #447 — nothing in this file may launch a real Chromium: under the `pnpm test`
 * fan-out that spawn contends for CPU and times out (#388). Every test that
 * reaches the puppeteer boundary lives in exporters-render-security.test.ts,
 * against a recorder; the ones that need a real PDF/DOCX binary live in
 * tests/exporters-real-chromium.integration.test.ts, outside the fan-out.
 * puppeteer is mocked here only to PROVE no test reaches it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const launches = vi.hoisted(() => ({ count: 0 }));
vi.mock("puppeteer", () => ({
  default: {
    launch: async () => {
      launches.count++;
      throw new Error("a unit test reached puppeteer.launch() (#447)");
    },
  },
}));

const { exportDocument } = await import("../../src/lib/docs-gen/exporters.js");

afterEach(() => {
  const launched = launches.count;
  launches.count = 0; // reset first, so one offender does not fail every later test
  expect(launched, "no unit test may launch Chromium (#447)").toBe(0);
});

describe("exportDocument", () => {
  const sampleMarkdown = `# Test Document

## Section One

Hello world paragraph.

## Section Two

| Column A | Column B |
|----------|----------|
| Row 1    | Data 1   |
`;

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
});
