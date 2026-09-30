/**
 * #447 — the document-export tests that genuinely need a REAL headless Chromium
 * to produce a real PDF / DOCX binary. They used to live in
 * tests/unit/exporters.test.ts, where the Chromium spawn contended for CPU with
 * every other package's workers under the `pnpm test` fan-out and timed out
 * (#388). The `*.integration.test.ts` suffix keeps them out of that fan-out;
 * everything asserted on our side of the puppeteer boundary lives in
 * tests/unit/exporters-render-security.test.ts against a recorder.
 *
 * Gated like the other integration suites: runs only when
 * `RUN_INTEGRATION_TESTS=1`, i.e. via
 *
 *   pnpm --filter @metis/server test:integration exporters-real-chromium
 *
 * The exporter degrades to HTML / an image-less DOCX when Chrome cannot launch,
 * so each binary assertion is conditional on the real format having come back.
 */
import { describe, it, expect } from "vitest";
import { exportDocument } from "../src/lib/docs-gen/exporters.js";

const enabled = process.env.RUN_INTEGRATION_TESTS === "1";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe.runIf(enabled)("document export against a real Chromium (integration)", () => {
  it("generates an actual PDF with Mermaid diagrams", async () => {
    const md = [
      "# Architecture",
      "",
      "## System Overview",
      "",
      "```mermaid",
      "graph TD",
      "    A[Client] --> B[API Gateway]",
      "    B --> C[Service]",
      "    C --> D[Database]",
      "```",
      "",
      "Some text after the diagram.",
      "",
    ].join("\n");

    const result = await exportDocument(md, "mermaid-test", "pdf");

    // Unconditional (PR #451 review): this suite exists to exercise a real
    // Chromium, so an HTML fallback must fail it rather than skip the checks.
    expect(result.mimeType).toBe("application/pdf");
    expect(result.buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(result.filename).toBe("mermaid-test.pdf");
  });

  it("generates a DOCX with Mermaid diagrams embedded as images", async () => {
    const md = [
      "# Architecture",
      "",
      "```mermaid",
      "graph LR",
      "    A --> B",
      "```",
      "",
      "## Tables",
      "",
      "| Name | Value |",
      "|------|-------|",
      "| foo  | bar   |",
      "",
    ].join("\n");

    const result = await exportDocument(md, "docx-mermaid", "docx");

    expect(result.mimeType).toBe(DOCX_MIME);
    // DOCX files are zips: PK signature.
    expect(result.buffer.subarray(0, 2).toString()).toBe("PK");
    expect(result.filename).toBe("docx-mermaid.docx");
    // It embeds the rasterised diagram, which only a real Chromium produces.
    // Size alone does not show that: an image-less DOCX with this table is
    // already over 5 KB. Zip entry names are stored uncompressed, so look for
    // the embedded image part directly.
    expect(result.buffer.includes(Buffer.from("word/media/"))).toBe(true);
  });
});
