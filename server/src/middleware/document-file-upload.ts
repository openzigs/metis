/**
 * The one multipart `file` field every upload route reads (#1921, #1948, #1985).
 *
 * Multer's memory storage, capped at one file and a byte limit, with the
 * client's upload faults given the upload contract's codes instead of falling
 * through to the global handler's 500:
 *
 *   - `LIMIT_FILE_SIZE` is 413 `FILE_TOO_LARGE`. For a document that is the
 *     code and message `validateUpload` gives a buffer over the cap. Multer
 *     stops reading at the cap, so `validateUpload` never sees that buffer and
 *     its own size check cannot answer for it.
 *   - A second file or a file in another field is 400 `UPLOAD_ERROR` saying to
 *     send one file in the `file` field ({@link ONE_FILE_MESSAGE}); every other
 *     Multer limit is 400 `UPLOAD_ERROR` with Multer's own fixed reason ("Field
 *     name too long", …).
 *   - A body busboy cannot parse — cut off mid-part, a malformed part header,
 *     a multipart type with no boundary — is 400 `UPLOAD_ERROR`. busboy raises
 *     these as plain `Error`s, so they are recognised by message. A body cut
 *     off is also logged with the bytes declared and received: a proxy's body
 *     cap (the Next proxy's `proxyClientMaxBodySize`) cuts a body off the same
 *     way a client that gave up does, and the log line tells them apart.
 *
 * Anything else (a request stream error, a storage failure) is forwarded
 * unchanged.
 *
 * {@link documentFile} is used by the project document route
 * (`routes/documents.ts`), the workspace governing route
 * (`routes/governing-documents.ts`) and the analysis clarify CSV import
 * (`routes/analysis.ts`); the connector `.zip` upload (`routes/connectors.ts`)
 * builds its own with {@link singleFileUpload} at the archive cap. One mapping
 * serves all four, so they cannot drift.
 */
import type { RequestHandler } from "express";
import multer from "multer";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { FILE_TOO_LARGE_MESSAGE, ONE_FILE_MESSAGE } from "../lib/documents/upload.js";
import { createChildLogger } from "../lib/logger.js";
import { AppError } from "./error-handler.js";

const logger = createChildLogger("document-file-upload");

export const MALFORMED_UPLOAD_MESSAGE =
  "Upload failed: the multipart body is malformed or incomplete";

/** Multer codes whose fix is "send exactly one file, in the `file` field". */
const ONE_FILE_CODES = new Set(["LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"]);

/** busboy's message for a body that ends before its closing boundary. */
const TRUNCATED_BODY_MESSAGE = "Unexpected end of form";

/**
 * busboy 1.x's messages for a body it cannot parse: all client faults. (A body
 * cut off mid-file also destroys the file stream with "Unexpected end of
 * file", but busboy reports "Unexpected end of form" first, and Multer passes
 * on only the first error.)
 */
const MALFORMED_BODY_MESSAGES = new Set([
  TRUNCATED_BODY_MESSAGE,
  "Malformed part header",
  "Multipart: Boundary not found",
]);

export interface SingleFileUploadOptions {
  /** The largest file accepted, in bytes. */
  maxBytes: number;
  /** The 413 `FILE_TOO_LARGE` message for a file over `maxBytes`. */
  tooLargeMessage: string;
}

/** `multer(...).single("file")` at `maxBytes`, with the upload contract's error codes. */
export function singleFileUpload({
  maxBytes,
  tooLargeMessage,
}: SingleFileUploadOptions): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
  });
  return (req, res, next) => {
    // The body bytes that arrived, for the truncation log line: a second
    // listener beside Multer's pipe reads the same chunks and leaves the
    // pipe's backpressure alone. Only a multipart body is piped, so only one
    // is counted (a listener on another body would drain it).
    let receivedBytes = 0;
    const count = (chunk: Buffer) => {
      receivedBytes += chunk.length;
    };
    const multipart = Boolean(req.is("multipart"));
    if (multipart) req.on("data", count);
    upload.single("file")(req, res, (err: unknown) => {
      if (multipart) req.off("data", count);
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          next(new AppError(413, "FILE_TOO_LARGE", tooLargeMessage));
          return;
        }
        const message = ONE_FILE_CODES.has(err.code)
          ? ONE_FILE_MESSAGE
          : `Upload failed: ${err.message}`;
        next(new AppError(400, "UPLOAD_ERROR", message));
        return;
      }
      if (err instanceof Error && MALFORMED_BODY_MESSAGES.has(err.message)) {
        if (err.message === TRUNCATED_BODY_MESSAGE) {
          const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
          logger.warn("upload body ended before its closing boundary", {
            declaredBytes: Number.isFinite(declared) ? declared : null,
            receivedBytes,
          });
        }
        next(new AppError(400, "UPLOAD_ERROR", MALFORMED_UPLOAD_MESSAGE));
        return;
      }
      next(err);
    });
  };
}

/** A document upload: {@link singleFileUpload} at `MAX_DOCUMENT_BYTES`. */
export const documentFile: RequestHandler = singleFileUpload({
  maxBytes: MAX_DOCUMENT_BYTES,
  tooLargeMessage: FILE_TOO_LARGE_MESSAGE,
});
