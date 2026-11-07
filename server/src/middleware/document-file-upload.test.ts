/**
 * `documentFile` (#1921) — the shared multipart reader behind the
 * project and governing document upload routes. Exercised through a tiny
 * Express app behind the real error handler, so the assertions are on the
 * HTTP envelope a client sees.
 */
import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { validateUpload } from "../lib/documents/upload.js";
import { documentFile } from "./document-file-upload.js";
import { errorHandler } from "./error-handler.js";

function appWith() {
  const app = express();
  app.post("/upload", documentFile, (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    res.status(200).json({ size: file?.buffer.length ?? null });
  });
  app.use(errorHandler);
  return app;
}

describe("documentFile", () => {
  it("passes a file at the cap through with its whole buffer", async () => {
    const res = await request(appWith())
      .post("/upload")
      .attach("file", Buffer.alloc(MAX_DOCUMENT_BYTES, 0x61), "at-cap.txt");
    expect(res.status).toBe(200);
    expect(res.body.size).toBe(MAX_DOCUMENT_BYTES);
  });

  it("answers a file one byte over the cap with validateUpload's 413 FILE_TOO_LARGE", async () => {
    const verdict = validateUpload({
      filename: "big.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61),
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    const res = await request(appWith())
      .post("/upload")
      .attach("file", Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61), "big.txt");
    expect(res.status).toBe(verdict.status);
    expect(res.body.error).toMatchObject({ code: verdict.code, message: verdict.message });
  });

  it("answers a file in another field with 400 UPLOAD_ERROR", async () => {
    const res = await request(appWith())
      .post("/upload")
      .attach("attachment", Buffer.from("x"), "x.txt");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UPLOAD_ERROR");
  });

  it("forwards a non-Multer error to the error handler unchanged", async () => {
    // A body cut off mid-part surfaces from busboy as a plain Error, not a
    // MulterError, so it keeps the global handler's 500.
    const res = await request(appWith())
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=x")
      .send('--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc');
    expect(res.status).toBe(500);
    expect(res.body.error.code).not.toBe("UPLOAD_ERROR");
  });
});
