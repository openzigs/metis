/**
 * Magic-byte signatures for the binary formats we accept (#1279).
 *
 * ## Why this module exists
 *
 * A declared MIME type is a *claim by the client*. It decided which of our parsers we
 * call — but not which parser actually runs, because `officeparser` re-dispatches on
 * **content**. `OfficeParser.parseOffice` uses a filename extension only when given a
 * path; handed a Buffer it sniffs magic bytes with `file-type` and routes `%PDF` into its
 * own bundled `pdfjs-dist`. So a PDF uploaded as `.pptx` was routed by us to `parsePptx`
 * and by officeparser into PDF parsing — skipping `MAX_PDF_PAGES`, which is enforced only
 * in `parsePdf`. Measured on this tree: a 2001-page PDF (cap 2000) declared
 * `application/pdf` was refused `PDF_TOO_MANY_PAGES`; the same bytes declared
 * `…presentationml.presentation` returned 28,012 characters of extracted text.
 *
 * The general rule, and why this is a class rather than an incident: **"which parser does
 * our code call for this MIME type" and "which parser actually runs" are different
 * questions whenever the library accepts bytes rather than a typed handle.**
 *
 * ## What this module guarantees
 *
 * The predicate here is deliberately *congruent with `file-type`'s own detectors*, because
 * `file-type` is what officeparser sniffs with. It recognises exactly two families:
 *
 *   - `pdf` — `%PDF` at offset 0 (`file-type` `checkString('%PDF')`)
 *   - `zip` — `PK` followed by `{0x03,0x05,0x07}` and `{0x04,0x06,0x08}`, the
 *     local-file-header / end-of-central-directory / spanned-archive signatures
 *     (`file-type` `check([0x50, 0x4B]) && …`)
 *
 * Congruence is the load-bearing property: because a buffer accepted for a declared OOXML
 * type must carry a zip signature, and `file-type` classifies every such buffer in the zip
 * family, **officeparser can no longer be handed anything it would sniff as a PDF** — nor
 * as any other format it supports (rtf, images via tesseract). That closes the next
 * advisory in any of those formats by the same route, not just `GHSA-hq66-cqwq-w95j`.
 *
 * `file-type` itself is not importable here: it is a transitive dependency of
 * `officeparser` and is not resolvable from `server/` (verified with `require.resolve`),
 * so using it directly would mean adding a dependency. These two signatures are four bytes
 * each and are pinned by tests against real OOXML and PDF fixtures.
 */

/** The magic-byte family a buffer carries. */
export type ContentFamily = "pdf" | "zip";

/**
 * The signature family a declared MIME type requires, or `null` for types that carry no
 * magic bytes at all (text, markdown, html, json) and so cannot be checked this way.
 */
export function requiredContentFamily(mime: string): ContentFamily | null {
  switch (mime) {
    case "application/pdf":
      return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return "zip";
    default:
      return null;
  }
}

/** The family the bytes actually carry, or `null` when no known signature is present. */
export function detectContentFamily(buffer: Buffer): ContentFamily | null {
  if (buffer.length < 4) return null;
  if (buffer.toString("ascii", 0, 4) === "%PDF") return "pdf";
  if (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  ) {
    return "zip";
  }
  return null;
}

/**
 * Whether the buffer's signature is consistent with the declared MIME type.
 *
 * Types with no signature (`requiredContentFamily` → `null`) are accepted here; they are
 * screened separately for binary content at the upload boundary.
 */
export function contentMatchesDeclaredMime(mime: string, buffer: Buffer): boolean {
  const required = requiredContentFamily(mime);
  if (required === null) return true;
  return detectContentFamily(buffer) === required;
}
