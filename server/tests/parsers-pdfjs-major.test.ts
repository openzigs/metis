import { describe, expect, it } from "vitest";

import { createPdf } from "./helpers/pdf-fixture.js";

/**
 * `officeparser` -> `pdfjs-dist` cross-major guard (GHSA-hq66-cqwq-w95j, #1273).
 *
 * ## Why this path exists at all
 *
 * `officeparser` is our PPTX parser, but it dispatches on CONTENT, not on the type we
 * decided. `parsePptx` hands it a Buffer, and `OfficeParser.parseOffice` uses a file
 * extension only when given a PATH — for a Buffer it sniffs magic bytes via `file-type`
 * and routes `%PDF` into its own bundled `pdfjs-dist`. So a PDF uploaded as `.pptx` was
 * parsed BY PDFJS. That is how GHSA-hq66-cqwq-w95j (CVSS 8.6, arbitrary JavaScript
 * execution on opening a malicious PDF) was reachable from document upload even though
 * `git grep pdfjs-dist -- server/src` returns nothing.
 *
 * ## Why it no longer goes through `parseDocument` (#1279)
 *
 * #1279 closed the ROUTE: `parseByMime` now refuses a document whose magic bytes
 * contradict its declared type, so PDF bytes labelled pptx never reach officeparser and
 * `parseDocument` returns `CONTENT_TYPE_MISMATCH`. That refusal is asserted in
 * `parsers-pptx-sniff-bypass.test.ts`.
 *
 * The pdfjs-dist override still has to be API-compatible, though — officeparser loads
 * pdfjs on its PDF branch, and that branch is still reachable from a real `.pptx` that
 * embeds a PDF attachment. So this guard now calls `officeparser` DIRECTLY rather than
 * through our router: it is a dependency-compatibility test, not a reachability test, and
 * conflating the two is what would let a broken override ship unnoticed behind the new
 * refusal.
 *
 * ## Why it needs its own test, and its own FILE
 *
 * `parsers.test.ts`'s `parsePptx (real officeparser)` feeds real PPTX bytes, and
 * officeparser loads pdfjs LAZILY on its PDF branch only — so the suite stayed green
 * whether pdfjs worked or not, making #1273's "document-parsing tests pass against the
 * new pdfjs-dist major" criterion vacuous. #1273's adversarial panel measured that gap.
 *
 * It is a separate FILE because of a PRE-EXISTING defect that has nothing to do with the
 * version bump. The tree carries two pdfjs copies (`pdf-parse` -> 5.4.296,
 * `officeparser` -> 6.2.108) and they collide through `globalThis.pdfjsWorker`, a
 * cross-copy global. Whichever copy loads FIRST installs its `WorkerMessageHandler`
 * there; the second copy short-circuits to that handler before it ever consults
 * `workerSrc`, so the API and worker versions disagree and pdfjs refuses to load. It is
 * bidirectional:
 *
 *   pdf-parse first    -> officeparser throws API "6.2.108" vs Worker "5.4.296"
 *   officeparser first -> pdf-parse    throws API "5.4.296" vs Worker "6.2.108"
 *
 * Confirmed to PRE-DATE this bump by installing the pre-change tree (officeparser@6.1.1
 * with its own pinned pdfjs 5.6.205) and reproducing BOTH directions; the bump only
 * changes the numbers. It is NOT `require.resolve` picking the wrong worker — that
 * resolves correctly, and deleting `globalThis.pdfjsWorker` makes the call succeed with
 * the same resolution, so `config.pdfWorkerSrc` cannot fix it either.
 *
 * Hence this file: vitest isolates per file, so keeping the assertion out of
 * `parsers.test.ts` — which loads `pdf-parse` first — is what makes it deterministic
 * rather than order-dependent.
 *
 * NOTE the security reading: the crash is not a control. In a fresh worker the disguised
 * PDF is parsed by pdfjs first and succeeds, which is why the version had to move. The
 * reverse direction is its own availability bug — one disguised upload can break every
 * subsequent legitimate PDF in that worker — and is tracked separately from #1273.
 */
describe("officeparser's bundled pdfjs-dist, driven across the forced major", () => {
  it("extracts text through officeparser's pdfjs branch, proving the forced major works", async () => {
    const buffer = createPdf(1, "PdfjsMajorProbe");

    const moduleName = "officeparser";
    const mod = (await import(moduleName)) as typeof import("officeparser");
    const ast = await mod.default.parseOffice(buffer);

    // The assertion that matters: officeparser drove pdfjs ACROSS THE MAJOR without
    // throwing and got the text out. `officeparser@6.1.1` pins pdfjs-dist to exactly
    // 5.6.205 and the override forces 6.2.108 over the top, so this is #1089's lesson
    // applied — resolving is not API compatibility, so run the code.
    expect(JSON.stringify(ast)).toContain("PdfjsMajorProbe");
    // `page` is the PDF AST shape, so this also pins that the Buffer path still sniffs —
    // if officeparser ever stops re-dispatching on content, #1279's gate is no longer
    // load-bearing and that should surface here rather than silently.
    expect(ast.content.map((node) => node.type)).toContain("page");
  });
});
