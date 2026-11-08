/**
 * `documentFile` (#1921, #1948) — the shared multipart reader behind the
 * project document, governing document and analysis clarify-import routes. Exercised through a tiny
 * Express app behind the real error handler, so the assertions are on the
 * HTTP envelope a client sees.
 */
import express, { type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DOCUMENT_BYTES } from "@metis/shared";

// #1985 — the truncation log line, read off this module's own logger.
const uploadLog = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/logger.js")>();
  return {
    ...actual,
    createChildLogger: (module: string) =>
      module === "document-file-upload"
        ? (uploadLog as unknown as ReturnType<typeof actual.createChildLogger>)
        : actual.createChildLogger(module),
  };
});

const { FILE_TOO_LARGE_MESSAGE, ONE_FILE_MESSAGE, validateUpload } =
  await import("../lib/documents/upload.js");
const { documentFile, MALFORMED_UPLOAD_MESSAGE, singleFileUpload } =
  await import("./document-file-upload.js");
const { errorHandler } = await import("./error-handler.js");

beforeEach(() => {
  uploadLog.warn.mockReset();
});

function appWith(middleware = documentFile) {
  const app = express();
  app.post("/upload", middleware, (req: Request, res: Response) => {
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
      message: ONE_FILE_MESSAGE,
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
      message: ONE_FILE_MESSAGE,
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

  it("#1985 — logs a truncated body with the bytes declared and the bytes received", async () => {
    // A proxy body cap cuts the body off like this too; the 400 alone would
    // hide it, so the log line says how much of the body arrived.
    const body = '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc';
    const res = await request(appWith())
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=x")
      .send(body);
    expect(res.status).toBe(400);
    expect(uploadLog.warn).toHaveBeenCalledTimes(1);
    expect(uploadLog.warn).toHaveBeenCalledWith("upload body ended before its closing boundary", {
      declaredBytes: Buffer.byteLength(body),
      receivedBytes: Buffer.byteLength(body),
    });
  });

  it("#1985 — logs nothing for a malformed body that was not cut off", async () => {
    await request(appWith())
      .post("/upload")
      .set("Content-Type", "multipart/form-data; boundary=x")
      .send("--x\r\nno-colon-here\r\n\r\nabc\r\n--x--\r\n");
    expect(uploadLog.warn).not.toHaveBeenCalled();
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

  it("#1985 — the size message reads in megabytes", () => {
    expect(FILE_TOO_LARGE_MESSAGE).toBe("The file is larger than 10 MB");
  });

  it("#1985 — singleFileUpload answers its own cap with its own message", async () => {
    const small = singleFileUpload({ maxBytes: 4, tooLargeMessage: "The archive is too big" });
    const at = await request(appWith(small))
      .post("/upload")
      .attach("file", Buffer.from("abcd"), "a.zip");
    expect(at.status).toBe(200);
    expect(at.body.size).toBe(4);
    const over = await request(appWith(small))
      .post("/upload")
      .attach("file", Buffer.from("abcde"), "a.zip");
    expect(over.status).toBe(413);
    expect(over.body.error).toMatchObject({
      code: "FILE_TOO_LARGE",
      message: "The archive is too big",
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
