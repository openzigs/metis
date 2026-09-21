/**
 * Document storage + parser + upload validation tests (Phase 5 / issue #39).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStorage } from "../src/lib/documents/storage.js";
import { parseDocument, sanitiseHtml } from "../src/lib/documents/parsers.js";
import { sanitiseFilename, validateUpload } from "../src/lib/documents/upload.js";
import {
  MAX_DOCUMENT_BYTES,
  UPLOAD_EXTENSION_ALLOWLIST,
  UPLOAD_MIME_ALLOWLIST,
} from "@metis/shared";

let root: string;
let storage: DocumentStorage;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "metis-store-"));
  storage = new DocumentStorage({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("DocumentStorage", () => {
  it("writes a blob under <root>/<projectId>/<sha256-prefix>/<sha256>", async () => {
    const blob = await storage.write({
      projectId: "p1",
      buffer: Buffer.from("hello world"),
    });
    expect(blob.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(blob.storagePath).toContain("p1");
    expect(blob.storagePath).toContain(blob.checksum);
    expect(blob.deduplicated).toBe(false);
    const read = await storage.read(blob.storagePath);
    expect(read.toString()).toBe("hello world");
  });

  it("dedupes by content hash on a re-upload", async () => {
    const a = await storage.write({ projectId: "p1", buffer: Buffer.from("x") });
    const b = await storage.write({ projectId: "p1", buffer: Buffer.from("x") });
    expect(a.checksum).toBe(b.checksum);
    expect(b.deduplicated).toBe(true);
  });

  it("never echoes the client filename into the on-disk path", async () => {
    const blob = await storage.write({
      projectId: "p1",
      buffer: Buffer.from("nasty"),
    });
    expect(blob.storagePath.includes("../")).toBe(false);
    expect(blob.storagePath.includes("client-supplied-name")).toBe(false);
  });

  it("rejects empty buffers", async () => {
    await expect(storage.write({ projectId: "p1", buffer: Buffer.alloc(0) })).rejects.toThrow(
      /empty/,
    );
  });

  it("rejects projectId values that look like path traversal", async () => {
    await expect(
      storage.write({ projectId: "../escape", buffer: Buffer.from("x") }),
    ).rejects.toThrow();
    await expect(storage.write({ projectId: "a/b", buffer: Buffer.from("x") })).rejects.toThrow();
  });

  it("resolveSafe refuses absolute escape paths", () => {
    expect(() => storage.resolveSafe("../../etc/passwd")).toThrow(/traversal/);
  });

  it("remove tolerates a missing file", async () => {
    await storage.remove("p1/aa/bb/never-existed");
  });

  it("remove deletes a previously-stored blob", async () => {
    const blob = await storage.write({ projectId: "p1", buffer: Buffer.from("y") });
    await storage.remove(blob.storagePath);
    await expect(storage.read(blob.storagePath)).rejects.toThrow();
  });

  it("removeProject wipes the per-project tree", async () => {
    await storage.write({ projectId: "p1", buffer: Buffer.from("y") });
    await storage.removeProject("p1");
    const exists = await fs
      .stat(path.join(root, "p1"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("constructor refuses missing root", () => {
    expect(() => new DocumentStorage({ root: "" })).toThrow(/root/);
  });
});

describe("parseDocument", () => {
  it("parses text/markdown verbatim", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("# hi\n\nbody"),
      mimeType: "text/markdown",
      filename: "n.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("# hi");
  });

  it("parses application/json with pretty-print fallback", async () => {
    const r = await parseDocument({
      buffer: Buffer.from('{"a":1}'),
      mimeType: "application/json",
      filename: "n.json",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('"a": 1');
  });

  it("strips a UTF-8 BOM", async () => {
    const r = await parseDocument({
      buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]),
      mimeType: "text/plain",
      filename: "n.txt",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("hello");
  });

  it("rejects invalid PDF bytes with PDF_PARSE_FAILED", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("%PDF-1.4 minimal"),
      mimeType: "application/pdf",
      filename: "n.pdf",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/^PDF_PARSE_FAILED/);
  });

  it("rejects oversized buffers with PARSER_FILE_TOO_LARGE", async () => {
    // 26 MB buffer (above 25 MB cap); content unimportant since size check fires first.
    const big = Buffer.alloc(26 * 1024 * 1024, 0x20);
    const r = await parseDocument({
      buffer: big,
      mimeType: "text/plain",
      filename: "n.txt",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("PARSER_FILE_TOO_LARGE");
  });

  // Since #1279 non-OOXML bytes are refused at the routing decision rather than handed to
  // the library to fail on its own. The reason names the declared type, so which handler
  // the MIME resolved to is still observable.
  it("returns CONTENT_TYPE_MISMATCH for non-OOXML bytes claiming DOCX", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("not a real docx file at all"),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "n.docx",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
      expect(r.reason).toContain("wordprocessingml.document");
    }
  });

  it("returns MIME_UNSUPPORTED for an unknown type", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("x"),
      mimeType: "application/x-bizarre",
      filename: "n.bin",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("MIME_UNSUPPORTED");
  });

  it("falls back to extension sniffing when MIME is generic", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("# heading"),
      mimeType: "application/octet-stream",
      filename: "n.md",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("# heading");
  });

  it("returns CONTENT_TYPE_MISMATCH for non-OOXML bytes claiming XLSX", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("not a real xlsx file"),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "n.xlsx",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
      expect(r.reason).toContain("spreadsheetml.sheet");
    }
  });

  it("returns CONTENT_TYPE_MISMATCH for non-OOXML bytes claiming PPTX", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("not a real pptx file"),
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      filename: "n.pptx",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/^CONTENT_TYPE_MISMATCH/);
      expect(r.reason).toContain("presentationml.presentation");
    }
  });

  it("sniffs .pptx extension from application/octet-stream", async () => {
    const r = await parseDocument({
      buffer: Buffer.from("not valid but tests extension sniffing"),
      mimeType: "application/octet-stream",
      filename: "deck.pptx",
    });
    // Will not parse, but the MIME detection should still route to PPTX — which the
    // refusal reason names.
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("declared application/vnd.openxmlformats");
  });
});

describe("sanitiseHtml", () => {
  it("removes <script> blocks entirely", () => {
    const out = sanitiseHtml("<p>before</p><script>alert(1)</script><p>after</p>");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("<script");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("removes <style> blocks entirely", () => {
    const out = sanitiseHtml("<style>body{}</style><p>visible</p>");
    expect(out).not.toContain("body{}");
    expect(out).toContain("visible");
  });

  it("strips on* event handler attributes", () => {
    const out = sanitiseHtml('<a href="#" onclick="steal()">link</a>');
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("steal");
  });

  it("neutralises javascript: and data: URLs", () => {
    const out = sanitiseHtml("<a href='javascript:evil()'>x</a>");
    expect(out).not.toContain("javascript:");
  });

  it("strips iframes, objects, and embeds", () => {
    const out = sanitiseHtml("<iframe src='evil'></iframe><object>x</object><embed src='y'/>");
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("object");
    expect(out).not.toContain("embed");
  });

  it("decodes the most common HTML entities", () => {
    const out = sanitiseHtml("<p>1 &lt; 2 &amp; 3 &gt; 0</p>");
    expect(out).toContain("1 < 2 & 3 > 0");
  });
});

describe("validateUpload", () => {
  it("accepts a markdown upload", () => {
    const r = validateUpload({
      filename: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# hi"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mimeType).toBe("text/markdown");
      expect(r.filename).toBe("notes.md");
    }
  });

  it("rejects an empty file with 400 EMPTY_FILE", () => {
    const r = validateUpload({
      filename: "n.md",
      mimeType: "text/markdown",
      buffer: Buffer.alloc(0),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.code).toBe("EMPTY_FILE");
    }
  });

  it("rejects files larger than the cap with 413 FILE_TOO_LARGE", () => {
    const r = validateUpload({
      filename: "huge.md",
      mimeType: "text/markdown",
      buffer: Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(413);
      expect(r.code).toBe("FILE_TOO_LARGE");
    }
  });

  it("rejects disallowed MIME types with 415 MIME_NOT_ALLOWED", () => {
    const r = validateUpload({
      filename: "x.exe",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from("MZ"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(415);
      expect(r.code).toBe("MIME_NOT_ALLOWED");
    }
  });

  it("falls back to extension sniffing for application/octet-stream", () => {
    const r = validateUpload({
      filename: "notes.md",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("# hi"),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an obvious magic-byte mismatch (binary disguised as text)", () => {
    const r = validateUpload({
      filename: "n.txt",
      mimeType: "text/plain",
      buffer: Buffer.concat([Buffer.from("hi "), Buffer.from([0x00, 0x01, 0x02])]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MAGIC_BYTE_MISMATCH");
  });

  it("requires PDF magic bytes for application/pdf", () => {
    const r = validateUpload({
      filename: "n.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not a pdf"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("MAGIC_BYTE_MISMATCH");
  });

  it("accepts a real-looking PDF prefix", () => {
    const r = validateUpload({
      filename: "n.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 ..."),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects an empty filename", () => {
    const r = validateUpload({
      filename: "",
      mimeType: "text/markdown",
      buffer: Buffer.from("# hi"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_FILENAME");
  });

  /**
   * #1279 — the upload boundary had no `presentationml.presentation` case at all, so PDF
   * bytes labelled `.pptx` fell through to `default` and were admitted. Admission control
   * and the parser router now share one signature predicate so they cannot drift apart.
   */
  describe("pptx signature (#1279)", () => {
    const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    const zipBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("rest of an OOXML package"),
    ]);

    it("refuses PDF bytes advertised as pptx with 415", () => {
      const r = validateUpload({
        filename: "disguised.pptx",
        mimeType: PPTX_MIME,
        buffer: Buffer.from("%PDF-1.4 a real pdf header"),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(415);
        expect(r.code).toBe("MAGIC_BYTE_MISMATCH");
      }
    });

    it("accepts a zip-signed pptx", () => {
      const r = validateUpload({
        filename: "deck.pptx",
        mimeType: PPTX_MIME,
        buffer: zipBytes,
      });
      expect(r.ok).toBe(true);
    });

    it("resolves an octet-stream .pptx to the pptx type rather than octet-stream", () => {
      // `pptx` is in UPLOAD_EXTENSION_ALLOWLIST, but `mimeForExtension` had no case for
      // it, so the resolved type was `application/octet-stream` — which no signature
      // check applies to. The resolved MIME is also what gets persisted and later fed to
      // the parser, so getting it wrong here skipped the check twice.
      const r = validateUpload({
        filename: "deck.pptx",
        mimeType: "application/octet-stream",
        buffer: zipBytes,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.mimeType).toBe(PPTX_MIME);
    });

    it("refuses an octet-stream .pptx carrying PDF bytes", () => {
      const r = validateUpload({
        filename: "disguised.pptx",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("%PDF-1.4 a real pdf header"),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("MAGIC_BYTE_MISMATCH");
    });

    /**
     * The pptx hole existed because `UPLOAD_EXTENSION_ALLOWLIST` grew an entry that
     * `mimeForExtension` never got a case for, and the miss was silent: the extension was
     * still accepted, it just resolved to `application/octet-stream`. This iterates the
     * exported allowlist rather than a hand-copied list, so the next extension added
     * without a MIME case fails here instead of quietly bypassing the signature check.
     */
    it("resolves every allowlisted extension to a real allowlisted MIME type", () => {
      // Literal per-extension bytes — deriving them from the code under test would make
      // the assertion agree with any mapping, including a wrong one.
      const bytesForExtension: Record<string, Buffer> = {
        txt: Buffer.from("plain text"),
        md: Buffer.from("# heading"),
        markdown: Buffer.from("# heading"),
        html: Buffer.from("<p>hi</p>"),
        htm: Buffer.from("<p>hi</p>"),
        json: Buffer.from('{"a":1}'),
        pdf: Buffer.from("%PDF-1.4 header"),
        docx: zipBytes,
        xlsx: zipBytes,
        pptx: zipBytes,
      };
      expect(Object.keys(bytesForExtension).sort()).toEqual([...UPLOAD_EXTENSION_ALLOWLIST].sort());

      for (const ext of UPLOAD_EXTENSION_ALLOWLIST) {
        const r = validateUpload({
          filename: `sample.${ext}`,
          mimeType: "application/octet-stream",
          buffer: bytesForExtension[ext],
        });
        expect(r.ok, `.${ext} should be admitted`).toBe(true);
        if (r.ok) {
          expect(
            (UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(r.mimeType),
            `.${ext} resolved to '${r.mimeType}', which is not an allowlisted MIME type`,
          ).toBe(true);
        }
      }
    });

    it("still refuses a docx/xlsx that carries no zip signature", () => {
      for (const mime of [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ]) {
        const r = validateUpload({
          filename: "x.bin",
          mimeType: mime,
          buffer: Buffer.from("%PDF-1.4 not an ooxml package"),
        });
        expect(r.ok).toBe(false);
      }
    });
  });
});

describe("sanitiseFilename", () => {
  it("strips directory components", () => {
    expect(sanitiseFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitiseFilename("/abs/path/file.md")).toBe("file.md");
  });
  it("removes control characters", () => {
    expect(sanitiseFilename("name\u0000.md")).toBe("name.md");
  });
  it("collapses double dots in the body", () => {
    expect(sanitiseFilename("file..name.md")).toBe("file.name.md");
  });
  it("returns '' for non-string input", () => {
    // @ts-expect-error - intentional misuse
    expect(sanitiseFilename(undefined)).toBe("");
  });
  it("clamps to 255 characters", () => {
    const out = sanitiseFilename("a".repeat(400));
    expect(out.length).toBe(255);
  });
});
