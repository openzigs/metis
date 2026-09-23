/**
 * #98 — the user-facing reason a document failed to index.
 *
 * The ingest pipeline writes the exception's own text into
 * `Document.errorMessage` (`ingest-queue.ts`'s retry fallthrough,
 * `KnowledgeService.markFailed`, the approval cleanup in `quarantine.ts`):
 * embedder HTTP bodies, LanceDB errors, absolute paths, provider payloads. Every
 * route and socket event that serves that column to a client used to return it
 * verbatim — the exposure #52/#67/#86 closed for generated documents, still open
 * on the indexing status line.
 *
 * This is a separate vocabulary from `generationFailureMessage`, which speaks
 * about *regenerating a document*; an indexing failure is fixed by re-indexing,
 * and has refusal reasons (unsupported type, empty text, …) no generation has.
 * It borrows only that module's provider *classification* — the HTTP status and
 * connection-failure rules — and answers with its own strings.
 *
 * Applied on READ, so the rows already full of raw text are covered too; the
 * raw error stays in the column and in the server log, where the ingest
 * pipeline already writes it.
 */
import {
  GENERATION_PROVIDER_AUTH_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_PROVIDER_RATE_LIMITED_MESSAGE,
  GENERATION_PROVIDER_UNREACHABLE_MESSAGE,
  generationFailureMessage,
} from "../docs-gen/generation-failure-message.js";

export const INDEXING_FAILED_MESSAGE =
  "Indexing failed. The details are in the server log; re-index the document to try again.";

export const INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE =
  "The embedding service failed while indexing this document. The details are in the server log; check the embedding settings, then re-index the document.";

export const INDEXING_PROVIDER_UNREACHABLE_MESSAGE =
  "The embedding provider could not be reached (connection failed). Check that the embedding host — for example a local Ollama server — is running and reachable from the METIS server, then re-index the document.";

export const INDEXING_PROVIDER_AUTH_MESSAGE =
  "The embedding provider rejected the configured credentials (401/403). Check the embedding settings, then re-index the document.";

export const INDEXING_PROVIDER_RATE_LIMITED_MESSAGE =
  "The embedding provider rate-limited the request (429 Too Many Requests). Wait a few minutes, then re-index the document.";

export const INDEXING_PROVIDER_BALANCE_MESSAGE =
  "The embedding provider refused the request: 402 Insufficient Balance. Top up the provider account, then re-index the document.";

export const INDEXING_STORAGE_MESSAGE =
  "The stored file could not be read for indexing. The details are in the server log.";

/** The same words the documentation page falls back to for a rejected row. */
export const INDEXING_REJECTED_MESSAGE = "Indexing was rejected.";

export const INDEXING_UNSUPPORTED_TYPE_MESSAGE = "This file type is not supported for indexing.";

export const INDEXING_CONTENT_MISMATCH_MESSAGE =
  "The file's content does not match its declared type, so it was not indexed.";

export const INDEXING_FILE_TOO_LARGE_MESSAGE = "The file is too large to index.";

export const INDEXING_TOO_MANY_PAGES_MESSAGE = "The PDF has too many pages to index.";

export const INDEXING_EMPTY_TEXT_MESSAGE =
  "No text could be extracted from the file (it may be scanned or image-only).";

export const INDEXING_PARSE_FAILED_MESSAGE =
  "The file could not be parsed; it may be corrupt or password-protected.";

/** METIS writes this on a soft-deleted row; it is its own, not an exception. */
const DELETED_MARKER = "deleted";

/** Every string a client may receive as an indexing `errorMessage`. */
const SAFE_MESSAGES: ReadonlySet<string> = new Set([
  INDEXING_FAILED_MESSAGE,
  INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE,
  INDEXING_PROVIDER_UNREACHABLE_MESSAGE,
  INDEXING_PROVIDER_AUTH_MESSAGE,
  INDEXING_PROVIDER_RATE_LIMITED_MESSAGE,
  INDEXING_PROVIDER_BALANCE_MESSAGE,
  INDEXING_STORAGE_MESSAGE,
  INDEXING_REJECTED_MESSAGE,
  INDEXING_UNSUPPORTED_TYPE_MESSAGE,
  INDEXING_CONTENT_MISMATCH_MESSAGE,
  INDEXING_FILE_TOO_LARGE_MESSAGE,
  INDEXING_TOO_MANY_PAGES_MESSAGE,
  INDEXING_EMPTY_TEXT_MESSAGE,
  INDEXING_PARSE_FAILED_MESSAGE,
  DELETED_MARKER,
]);

/**
 * The parser's refusal codes (`lib/documents/parsers.ts`), anchored at the start
 * of the stored text: `*_PARSE_FAILED` carries the parser's exception after the
 * code, and a code quoted inside some other exception is not a refusal.
 */
const PARSER_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^MIME_UNSUPPORTED\b/, INDEXING_UNSUPPORTED_TYPE_MESSAGE],
  [/^CONTENT_TYPE_MISMATCH\b/, INDEXING_CONTENT_MISMATCH_MESSAGE],
  [/^PARSER_FILE_TOO_LARGE\b/, INDEXING_FILE_TOO_LARGE_MESSAGE],
  [/^PDF_TOO_MANY_PAGES\b/, INDEXING_TOO_MANY_PAGES_MESSAGE],
  [/^(?:PDF|DOCX)_EMPTY_TEXT\b/, INDEXING_EMPTY_TEXT_MESSAGE],
  [/^(?:PDF|DOCX|XLSX|PPTX)_PARSE_FAILED\b/, INDEXING_PARSE_FAILED_MESSAGE],
];

/** The generation classifier's provider verdicts, re-worded for indexing. */
const PROVIDER_VERDICTS: ReadonlyMap<string, string> = new Map([
  [GENERATION_PROVIDER_UNREACHABLE_MESSAGE, INDEXING_PROVIDER_UNREACHABLE_MESSAGE],
  [GENERATION_PROVIDER_AUTH_MESSAGE, INDEXING_PROVIDER_AUTH_MESSAGE],
  [GENERATION_PROVIDER_RATE_LIMITED_MESSAGE, INDEXING_PROVIDER_RATE_LIMITED_MESSAGE],
  [GENERATION_PROVIDER_BALANCE_MESSAGE, INDEXING_PROVIDER_BALANCE_MESSAGE],
]);

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

/**
 * The user-safe message for an indexing failure. Accepts the thrown error or the
 * text already stored on a `Document` row. Never echoes its input unless the
 * input is already one of this vocabulary's strings.
 */
export function indexingFailureMessage(err: unknown): string {
  if (typeof err === "string" && SAFE_MESSAGES.has(err)) return err;
  const message = readMessage(err);

  for (const [pattern, safe] of PARSER_REFUSALS) {
    if (pattern.test(message)) return safe;
  }
  if (/^storage read failed\b/i.test(message)) return INDEXING_STORAGE_MESSAGE;
  if (message === "rejected") return INDEXING_REJECTED_MESSAGE;

  const provider = PROVIDER_VERDICTS.get(generationFailureMessage(err));
  if (provider) return provider;

  // KnowledgeService's own prefixes for an embedder that threw or answered
  // with the wrong shape.
  if (/^(?:embedding failed|embedder returned)\b/i.test(message)) {
    return INDEXING_EMBEDDER_UNAVAILABLE_MESSAGE;
  }
  return INDEXING_FAILED_MESSAGE;
}

export const APPROVAL_NOT_FOUND_MESSAGE = "The document was not found.";

export const APPROVAL_NOT_AWAITING_MESSAGE =
  "The document is not awaiting approval. Reload the document list to see its current state.";

export const APPROVAL_STATE_CHANGED_MESSAGE =
  "The document changed while it was being approved. Reload the document list and try again.";

export const APPROVAL_REVISION_UNAVAILABLE_MESSAGE =
  "This generated-document revision is no longer available for approval; a newer revision or a deletion superseded it.";

export const APPROVAL_EMBEDDING_MISSING_MESSAGE =
  "The quarantined copy has no embedding; re-index the document before approving it.";

/**
 * `quarantine.ts`'s own refusals, matched against the WHOLE message so an
 * exception that merely quotes one of them is not mistaken for it. Each answers
 * with a fixed string — the document id in the original text is dropped.
 */
const APPROVAL_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Document \S+ not found$/, APPROVAL_NOT_FOUND_MESSAGE],
  [/^Document \S+ not in approvable state: \w+$/, APPROVAL_NOT_AWAITING_MESSAGE],
  [
    /^Document \S+ (?:no longer approvable|approval attempt revoked|ingest generation revoked)$/,
    APPROVAL_STATE_CHANGED_MESSAGE,
  ],
  [/^Generated document revision unavailable for approval$/, APPROVAL_REVISION_UNAVAILABLE_MESSAGE],
  [/^Quarantine embedding missing; re-ingest before approval$/, APPROVAL_EMBEDDING_MISSING_MESSAGE],
];

/**
 * #108 — the message for a failed `POST /documents/:id/approve` or `/reject`.
 * `approveDocument` rethrows whatever the vector store, the BM25 index or
 * Prisma threw during cleanup, and the 409 body used to carry it verbatim. A
 * METIS-authored state refusal keeps its meaning; anything else goes through
 * {@link indexingFailureMessage}. The raw error is the caller's to log.
 */
export function approvalFailureMessage(err: unknown): string {
  const message = readMessage(err);
  for (const [pattern, safe] of APPROVAL_REFUSALS) {
    if (pattern.test(message)) return safe;
  }
  return indexingFailureMessage(err);
}

/**
 * The indexing `errorMessage` a client may see for a `Document` row (or a
 * publication outbox task), given the row's `indexState` when it has one.
 *
 * A `rejected` row always reads as {@link INDEXING_REJECTED_MESSAGE}: the column
 * normally holds the reviewer's optional reason, but the ingest queue's
 * retry-fallthrough write does not filter on `indexState`, so a rejected row can
 * be overwritten with an exception. The reason is kept in the audit log.
 */
export function publicIndexingErrorMessage(
  errorMessage: string | null | undefined,
  indexState?: string | null,
): string | null {
  if (errorMessage == null) return null;
  if (indexState === "rejected") return INDEXING_REJECTED_MESSAGE;
  return indexingFailureMessage(errorMessage);
}

/** A `Document` row as a client may see it: {@link publicIndexingErrorMessage} applied. */
export function publicDocumentRow<
  T extends { errorMessage?: string | null; indexState?: string | null },
>(row: T): T;
export function publicDocumentRow<
  T extends { errorMessage?: string | null; indexState?: string | null },
>(row: T | null): T | null;
export function publicDocumentRow<
  T extends { errorMessage?: string | null; indexState?: string | null },
>(row: T | null): T | null {
  if (!row || !("errorMessage" in row)) return row;
  return { ...row, errorMessage: publicIndexingErrorMessage(row.errorMessage, row.indexState) };
}
