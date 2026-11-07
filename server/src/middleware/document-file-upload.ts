/**
 * The one multipart `file` field every document upload route reads (#1921).
 *
 * Multer's memory storage, capped at `MAX_DOCUMENT_BYTES` and one file, with
 * Multer's own errors given the upload contract's codes instead of falling
 * through to the global handler's 500:
 *
 *   - `LIMIT_FILE_SIZE` is 413 `FILE_TOO_LARGE`, the code and message
 *     `validateUpload` gives a buffer over the cap. Multer stops reading at the
 *     cap, so `validateUpload` never sees that buffer and its own size check
 *     cannot answer for it.
 *   - Every other Multer error (a second file, an unexpected field) is 400
 *     `UPLOAD_ERROR`.
 *
 * Used by the project route (`routes/documents.ts`) and the workspace
 * governing route (`routes/governing-documents.ts`), so the two cannot drift.
 */
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { AppError } from "./error-handler.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1 },
});

/** `upload.single("file")` with the upload contract's error codes. */
export function documentFile(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        next(new AppError(413, "FILE_TOO_LARGE", `File exceeds ${MAX_DOCUMENT_BYTES} byte limit`));
        return;
      }
      next(new AppError(400, "UPLOAD_ERROR", "Upload failed: one file in the 'file' field"));
      return;
    }
    next(err);
  });
}
