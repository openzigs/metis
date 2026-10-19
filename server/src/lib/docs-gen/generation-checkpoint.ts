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
import {
  GENERATION_FAILED_MESSAGE,
  generationFailureMessage,
} from "./generation-failure-message.js";
import { classifyGroundingError } from "./grounding/transient-retry.js";
import type { SectionSynthesisRecord } from "./section-reuse.js";

/** Where in a generation a failure happened. */
export type GenerationStage = "setup" | "facts" | "sections" | "assembly" | "commit";

/** Why a finished generation must not be saved as the document's content. */
export type UnpublishableReason = "inputs-changed" | "superseded" | "aborted" | "budget";

/**
 * A run stopped on purpose: the inputs moved, the row was replaced or deleted,
 * the run was cancelled (#855), or it reached its cost ceiling (#855). Its
 * output is never PUBLISHED as a version. What it finished may still be kept
 * as an unpublished, degraded draft (#857) — except for `superseded`, whose
 * row now belongs to someone else.
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
    "The project's sources changed while this document was being generated, so the result was not published.",
  superseded: "The document was deleted or replaced by another generation.",
  aborted: "The generation was cancelled.",
  budget:
    "The generation reached its cost ceiling (DOCS_GEN_MAX_RUN_COST_CENTS / DOCS_GEN_MAX_RUN_TOKENS) and was stopped.",
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
 * #942 — the warning for one section whose generation failed while the rest of
 * the run went on. A recognised failure (a provider 402, 429, an unreachable
 * host…) keeps its fixed message; an unrecognised one used to say only "the
 * details are in the server log", so it now names the error class too — never
 * the exception's own text (#67).
 */
export function sectionFailureWarning(section: string, err: unknown): DocWarning {
  const drop = droppedAttemptsOf(err);
  if (drop) return sectionFailedWarning(section, droppedConnectionDetail(drop));
  const message = generationFailureMessage(err);
  if (message !== GENERATION_FAILED_MESSAGE) return sectionFailedWarning(section, message);
  // #1209 — the transport classifier does not recognise the Anthropic
  // adapter's wrapped drop (`anthropic stream failed (TypeError): terminated`);
  // the grounding classifier does. PR #1274 review — but it also reads a host
  // that was never reached ("Connection error.", `fetch failed`) as
  // `stream-terminated`, so only a mid-reply drop's wording says "dropped".
  if (
    classifyGroundingError(err) === "stream-terminated" &&
    MID_REPLY_DROP_TEXT.test(err instanceof Error ? err.message : String(err))
  ) {
    return sectionFailedWarning(section, droppedConnectionDetail(undefined));
  }
  return sectionFailedWarning(
    section,
    `it failed with an unrecognised error (${errorClassOf(err)}); the full error is in the server log. Regenerate the document to retry it; the finished sections are reused.`,
  );
}

/** PR #1274 review — the wording of a reply cut off part-way, never of a connect that failed. */
const MID_REPLY_DROP_TEXT =
  /\bterminated\b|\bECONNRESET\b|\bEPIPE\b|\bsocket hang up\b|\bother side closed\b|\bpremature close\b/i;

/** #1209 — how many tries a section draft made before its connection dropped for the last time. */
export interface DroppedAttempts {
  attempts: number;
  /** The run had stopped retrying drops (`drop-retry-breaker.ts`), so this draft was tried once. */
  retriesStopped: boolean;
}

// Kept beside the error rather than on it, so no serialiser can leak it.
const DROPPED_ATTEMPTS = new WeakMap<object, DroppedAttempts>();

/** #1209 — record that `err` ended a section draft whose connection dropped on every one of its tries. */
export function markDroppedAttempts<E>(err: E, drop: DroppedAttempts): E {
  if (err !== null && typeof err === "object") DROPPED_ATTEMPTS.set(err, { ...drop });
  return err;
}

/** #1209 — see {@link markDroppedAttempts}. */
export function droppedAttemptsOf(err: unknown): DroppedAttempts | undefined {
  return err !== null && typeof err === "object" ? DROPPED_ATTEMPTS.get(err) : undefined;
}

/** #1209 — the reason a business reader sees for a section whose connection kept dropping. */
function droppedConnectionDetail(drop: DroppedAttempts | undefined): string {
  const tries = drop
    ? ` (${drop.attempts} ${drop.attempts === 1 ? "attempt" : "attempts"}${
        drop.retriesStopped
          ? "; METIS stopped retrying after the connection dropped on earlier sections too"
          : ""
      })`
    : "";
  return `the AI provider's connection dropped while it was writing this section${tries}. Regenerate the document to try this section again; the finished sections are reused.`;
}

/**
 * #942 — true when a document's warnings name a section that failed while the
 * rest of its run finished: a `section-failed` warning that is not a whole-run
 * stop cause (those carry a `stage`). Such a document is regeneratable even
 * with a published version — the regenerate writes those sections and reuses
 * the finished ones.
 */
export function hasFailedSections(warnings: unknown): boolean {
  return (
    Array.isArray(warnings) &&
    warnings.some(
      (w) =>
        w != null &&
        typeof w === "object" &&
        (w as { kind?: unknown }).kind === "section-failed" &&
        !("stage" in w),
    )
  );
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
