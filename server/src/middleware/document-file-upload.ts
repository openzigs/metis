/**
 * The one multipart `file` field every upload route reads (#1921, #1948).
 *
 * Multer's memory storage, capped at `MAX_DOCUMENT_BYTES` and one file, with
 * the client's upload faults given the upload contract's codes instead of
 * falling through to the global handler's 500:
 *
 *   - `LIMIT_FILE_SIZE` is 413 `FILE_TOO_LARGE`, the code and message
 *     `validateUpload` gives a buffer over the cap. Multer stops reading at the
 *     cap, so `validateUpload` never sees that buffer and its own size check
 *     cannot answer for it.
 *   - A second file or a file in another field is 400 `UPLOAD_ERROR` saying to
 *     send one file in the `file` field; every other Multer limit is 400
 *     `UPLOAD_ERROR` with Multer's own fixed reason ("Field name too long", …).
 *   - A body busboy cannot parse — cut off mid-part, a malformed part header,
 *     a multipart type with no boundary — is 400 `UPLOAD_ERROR`. busboy raises
 *     these as plain `Error`s, so they are recognised by message.
 *
 * Anything else (a request stream error, a storage failure) is forwarded
 * unchanged.
 *
 * Used by the project document route (`routes/documents.ts`), the workspace
 * governing route (`routes/governing-documents.ts`) and the analysis clarify
 * CSV import (`routes/analysis.ts`), so the three cannot drift.
 */
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { FILE_TOO_LARGE_MESSAGE } from "../lib/documents/upload.js";
import { AppError } from "./error-handler.js";

export const MALFORMED_UPLOAD_MESSAGE =
  "Upload failed: the multipart body is malformed or incomplete";

/** Multer codes whose fix is "send exactly one file, in the `file` field". */
const ONE_FILE_CODES = new Set(["LIMIT_FILE_COUNT", "LIMIT_UNEXPECTED_FILE"]);

/**
 * busboy 1.x's messages for a body it cannot parse: all client faults. (A body
 * cut off mid-file also destroys the file stream with "Unexpected end of
 * file", but busboy reports "Unexpected end of form" first, and Multer passes
 * on only the first error.)
 */
const MALFORMED_BODY_MESSAGES = new Set([
  "Unexpected end of form",
  "Malformed part header",
  "Multipart: Boundary not found",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
});

/** `upload.single("file")` with the upload contract's error codes. */
export function documentFile(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new AppError(413, "FILE_TOO_LARGE", FILE_TOO_LARGE_MESSAGE));
        return;
      }
      const message = ONE_FILE_CODES.has(err.code)
        ? "Upload failed: one file in the 'file' field"
        : `Upload failed: ${err.message}`;
      next(new AppError(400, "UPLOAD_ERROR", message));
      return;
    }
    if (err instanceof Error && MALFORMED_BODY_MESSAGES.has(err.message)) {
      next(new AppError(400, "UPLOAD_ERROR", MALFORMED_UPLOAD_MESSAGE));
      return;
    }
    next(err);
  });
}
