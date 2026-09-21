import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/lib/documents/parsers.js";
import { createPdf } from "./helpers/pdf-fixture.js";

const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * The #1279 bypass, isolated: PDF bytes declared `.pptx` must never reach officeparser.
 *
 * ## Why this file loads no PDF parser of its own
 *
 * `pdf-parse` and `officeparser` carry two different `pdfjs-dist` copies that collide
 * through `globalThis.pdfjsWorker` (see `parsers-pdfjs-major.test.ts` for the full
 * diagnosis). Any file that loads `pdf-parse` first makes officeparser's PDF branch
 * *throw* — which would mask the bypass behind a crash and make the mutation proof
 * dishonest: the test would go red on revert for the wrong reason.
 *
 * So this file exercises only the pptx route. With the routing gate reverted and this
 * file run alone, the measured result on the shipped tree is `ok: true` with 28,012
 * characters extracted from a 2001-page PDF — the cap silently skipped, no crash. That is
 * the defect, and it is what these assertions are red against.
 */
describe("PDF bytes declared as pptx (#1279)", () => {
  it("is refused on content evidence instead of being handed to officeparser", async () => {
    const buffer = createPdf(1, "SniffProbe");

    const r = await parseDocument({
      buffer,
      mimeType: PPTX_MIME,
      filename: "disguised.pptx",
    });

    expect(r.ok, "PDF bytes labelled pptx must not parse").toBe(false);
    if (!r.ok) {
      // Not `PPTX_PARSE_FAILED`: the refusal happens at the routing decision, so
      // officeparser is never invoked and never gets to sniff.
      expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
      expect(r.reason).toContain("content pdf");
    }
  });

  it("refuses an over-cap PDF declared as pptx, so MAX_PDF_PAGES cannot be side-stepped", async () => {
    // 2001 pages against a cap of 2000. Deliberately ~320 KB, far below
    // MAX_DOCUMENT_PARSE_BYTES: the byte ceiling must not be what refuses this, or the
    // assertion would hold with the page cap gone.
    const buffer = createPdf(2001, "OverCapProbe");
    expect(buffer.length).toBeLessThan(1024 * 1024);

    const r = await parseDocument({
      buffer,
      mimeType: PPTX_MIME,
      filename: "big-deck.pptx",
    });

    expect(r.ok, "an over-cap PDF must not be parsed via the pptx route").toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
  });

  it("still refuses when the type comes from the .pptx extension rather than the MIME", async () => {
    // `normaliseMime` resolves `application/octet-stream` + `.pptx` to the pptx type, so
    // the extension fallback is a second way into the same handler. The gate runs after
    // normalisation, so it covers both.
    const r = await parseDocument({
      buffer: createPdf(1, "ExtensionProbe"),
      mimeType: "application/octet-stream",
      filename: "disguised.pptx",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
  });
});
