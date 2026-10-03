/**
 * #782 — what a generation that stops early leaves behind.
 *
 * A full-scope BRD ran for 77 minutes, finished its sections and then failed
 * in its last second. Everything it had produced was discarded, and the only
 * thing the document said was "the details are in the server log" — which a
 * user cannot read, and which nothing else recorded. This module holds the two
 * pieces `generateDocumentAsync` needs to do better:
 *
 * - {@link generationFailureWarning}: the cause, stored ON the document — the
 *   stage it stopped in, the section in progress and the error class — through
 *   METIS-authored text only (#52/#67: never an exception's message);
 * - {@link partialDocumentMarkdown}: a readable document from the sections the
 *   run finished (its stored checkpoint records), for a failure that left no
 *   assembled document behind.
 */
import { sectionFailedWarning, type DocWarning } from "./grounding/degraded-warnings.js";
import { generationFailureMessage } from "./generation-failure-message.js";
import type { SectionSynthesisRecord } from "./section-reuse.js";

/** Where in a generation a failure happened. */
export type GenerationStage = "setup" | "facts" | "sections" | "assembly" | "commit";

/** Why a finished generation must not be saved as the document's content. */
export type UnpublishableReason = "inputs-changed" | "superseded" | "aborted";

/**
 * A failure that is the commit boundary doing its job: the inputs moved, the
 * row was replaced or the run was cancelled. Its output must never be saved
 * (the revalidation in `generateDocumentAsync`), so it is never salvaged.
 */
export class UnpublishableGenerationError extends Error {
  constructor(
    readonly reason: UnpublishableReason,
    message: string,
  ) {
    super(message);
    this.name = "UnpublishableGenerationError";
  }
}

const STAGE_TEXT: Readonly<Record<GenerationStage, string>> = {
  setup: "while preparing the generation",
  facts: "while extracting facts from the source (phase 1)",
  sections: "while writing sections (phase 2)",
  assembly: "after the sections were written, while assembling the document",
  commit: "while saving the document",
};

const UNPUBLISHABLE_TEXT: Readonly<Record<UnpublishableReason, string>> = {
  "inputs-changed":
    "The project's sources changed while this document was being generated, so the result was not saved.",
  superseded: "The document was deleted or replaced by another generation.",
  aborted: "The generation was cancelled.",
};

// A class name is identifier-shaped. Anything else (a subclass that set
// `name` to prose, say) is not echoed.
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** The error's class name, when it is a plain identifier — never its message. */
export function errorClassOf(err: unknown): string {
  if (err instanceof Error) return ERROR_CLASS.test(err.name) ? err.name : "Error";
  return "non-Error value";
}

/** The failure warning carries its cause as fields as well as prose. */
export type GenerationFailureWarning = DocWarning & {
  stage: GenerationStage;
  errorClass: string;
};

/** The longest detail `sectionFailedWarning` keeps. */
const DETAIL_LIMIT = 300;

/**
 * The cause of a failed generation, as a warning a user can read: the stage,
 * the section in progress (when it was writing one), the error class, and the
 * fixed-vocabulary reason. The reason is dropped rather than cut mid-sentence
 * when it does not fit.
 */
export function generationFailureWarning(input: {
  stage: GenerationStage;
  section?: string;
  err: unknown;
}): GenerationFailureWarning {
  const { stage, err } = input;
  const section = input.section?.trim() || undefined;
  const where =
    stage === "sections" && section ? `${STAGE_TEXT.sections}, in this section` : STAGE_TEXT[stage];
  const errorClass = errorClassOf(err);
  const head = `generation stopped ${where} (${errorClass}).`;
  const cause =
    err instanceof UnpublishableGenerationError
      ? UNPUBLISHABLE_TEXT[err.reason]
      : generationFailureMessage(err);
  const detail = head.length + 1 + cause.length <= DETAIL_LIMIT ? `${head} ${cause}` : head;
  return {
    ...sectionFailedWarning(section ?? "Document", detail),
    stage,
    errorClass,
  };
}

/**
 * A document assembled from the sections a run finished, in section order, for
 * a failure that left no assembled document. The note says plainly that it is
 * incomplete; the failure warning says why.
 */
export function partialDocumentMarkdown(
  title: string,
  records: readonly SectionSynthesisRecord[],
): string {
  const ordered = [...records].sort((a, b) => a.metadata.sectionIndex - b.metadata.sectionIndex);
  const body = ordered.map((record) => record.markdown.trim()).join("\n\n");
  return `# ${title}\n\n> **Incomplete document.** Generation stopped before every section was written; ${ordered.length} finished section${ordered.length === 1 ? " is" : "s are"} shown below. Regenerate to write the rest — finished sections are reused.\n\n${body}\n`;
}
