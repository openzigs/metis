/**
 * `documentFile` (#1921, #1948) — the shared multipart reader behind the
 * project document, governing document and analysis clarify-import routes. Exercised through a tiny
 * Express app behind the real error handler, so the assertions are on the
 * HTTP envelope a client sees.
 */
import express, { type Request, type Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";
import { validateUpload } from "../lib/documents/upload.js";
import { documentFile, MALFORMED_UPLOAD_MESSAGE } from "./document-file-upload.js";
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
    expect(res.body.error).toMatchObject({
      code: "UPLOAD_ERROR",
      message: "Upload failed: one file in the 'file' field",
    });
  });

  it("answers a second file with the one-file hint", async () => {
    const res = await request(appWith())
      .post("/upload")
      .attach("file", Buffer.from("a"), "a.txt")
      .attach("file", Buffer.from("b"), "b.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "UPLOAD_ERROR",
      message: "Upload failed: one file in the 'file' field",
    });
  });

  it("answers a truncated body with 400 UPLOAD_ERROR, not the global 500", async () => {
    // busboy reports a body cut off mid-part as a plain Error ("Unexpected end
    // of form"): a client fault, so a 4xx.
    const res = await request(appWith())
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=x")
      .send('--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "UPLOAD_ERROR",
      message: MALFORMED_UPLOAD_MESSAGE,
    });
  });

  it("answers a part with a malformed header with 400 UPLOAD_ERROR", async () => {
    const res = await request(appWith())
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=x")
      .send("--x\r\nno-colon-here\r\n\r\nabc\r\n--x--\r\n");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "UPLOAD_ERROR",
      message: MALFORMED_UPLOAD_MESSAGE,
    });
  });

  it("answers a multipart request with no boundary with 400 UPLOAD_ERROR", async () => {
    const res = await request(appWith())
      .post("/upload")
      .set("Content-Type", "multipart/form-data")
      .send("abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "UPLOAD_ERROR",
      message: MALFORMED_UPLOAD_MESSAGE,
    });
  });

  it("names Multer's own reason for a field limit, not the one-file hint", async () => {
    // busboy's default field-value cap is 1 MiB: a longer value is LIMIT_FIELD_VALUE.
    const res = await request(appWith())
      .post("/upload")
      .field("title", "v".repeat(1024 * 1024 + 1))
      .attach("file", Buffer.from("x"), "x.txt");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: "UPLOAD_ERROR",
      message: "Upload failed: Field value too long",
    });
  });

  it("forwards a non-Multer, non-busboy error to the error handler unchanged", async () => {
    // A failure from somewhere other than the body parser (here, a request
    // stream that errors) is not the client's malformed upload: it keeps the
    // global handler's 500.
    const app = express();
    app.post(
      "/upload",
      (req: Request, _res: Response, next) => {
        process.nextTick(() => req.emit("error", new Error("socket blew up")));
        next();
      },
      documentFile,
      (_req: Request, res: Response) => {
        res.status(200).end();
      },
    );
    app.use(errorHandler);
    const res = await request(app).post("/upload").attach("file", Buffer.from("x"), "x.txt");
    expect(res.status).toBe(500);
    expect(res.body.error.code).not.toBe("UPLOAD_ERROR");
  });
});
