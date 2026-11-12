/**
 * #2369 — a full-project or repository document whose code graph yields no
 * documentable module produces no document.
 *
 * The holistic synthesizer used to return a stub ("No documentable modules
 * were found … could not be generated") as the document's content. The run
 * then committed it as `ready`, toasted "Documentation ready" and queued it
 * for indexing, so a documents-only project gained a knowledge document that
 * said it had failed. The synthesizer now throws this instead: the run ends
 * `failed`, with a fixed message that says what to do, and nothing is
 * published or indexed.
 */

/** Stable machine code for "there was no code to document". */
export const NO_DOCUMENTABLE_CODE = "NO_DOCUMENTABLE_CODE";

/** Thrown when a code-based document's scope holds no documentable module. */
export class NoDocumentableCodeError extends Error {
  readonly code = NO_DOCUMENTABLE_CODE;
  /**
   * The code symbols indexed for the scope before modules were formed: 0 for
   * a project with no source code at all, more when everything indexed was
   * excluded (test, generated or build files) or too small to summarize.
   */
  constructor(readonly indexedSymbols: number) {
    super(
      indexedSymbols > 0
        ? `None of the ${indexedSymbols} indexed code symbol(s) formed a documentable module.`
        : "The project has no indexed source code.",
    );
    this.name = "NoDocumentableCodeError";
  }
}
