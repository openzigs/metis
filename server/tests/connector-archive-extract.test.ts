/**
 * Issue #288 — `upload` provider archive extraction guards.
 *
 * Proves: zip-slip rejection (../ escape + absolute + backslash); zip-bomb
 * rejection (per-file cap, total cap, entry-count cap); SOURCE_EXTENSIONS
 * filtering; and a valid archive extracting source files into a fresh root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { MAX_ARCHIVE_ENTRIES, MAX_EXTRACTED_FILE_BYTES } from "@metis/shared";
import {
  extractArchiveBuffer,
  extractArchiveFromPath,
  storeUploadedArchive,
  cleanupExtraction,
  inflateEntryBounded,
} from "../src/lib/connectors/repo/archive-extract.js";
import { MAX_EXTRACTED_BYTES } from "@metis/shared";

let extractDir: string;
const CONNECTOR_ID = "abc123connector";

beforeEach(async () => {
  extractDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-extract-test-")));
  process.env.UPLOAD_EXTRACT_DIR = extractDir;
  process.env.UPLOAD_ARCHIVE_DIR = path.join(extractDir, "archives");
});

afterEach(async () => {
  await cleanupExtraction(CONNECTOR_ID);
  await fs.rm(extractDir, { recursive: true, force: true });
  delete process.env.UPLOAD_EXTRACT_DIR;
  delete process.env.UPLOAD_ARCHIVE_DIR;
  vi.restoreAllMocks();
});

async function zipFrom(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/**
 * Build a stubbed JSZip whose entry names are used VERBATIM. JSZip normalizes
 * `../` away when you call `.file()`, so a real malicious archive (built by a
 * non-JSZip tool) is simulated by stubbing `loadAsync` to return raw names —
 * this is exactly what `loadAsync` does when it reads a hostile central
 * directory. This drives the zip-slip guard with names that DON'T self-sanitize.
 */
function stubMaliciousZip(entryName: string, content = "export const evil = 1;\n"): void {
  const files = {
    [entryName]: {
      dir: false,
      name: entryName,
      async: async () => Buffer.from(content),
      _data: { uncompressedSize: content.length },
    },
  };
  vi.spyOn(JSZip, "loadAsync").mockResolvedValue({ files } as unknown as JSZip);
}

describe("extractArchiveBuffer", () => {
  it("extracts source files into a fresh extraction root", async () => {
    const buf = await zipFrom({
      "src/index.ts": "export const x = 1;\n",
      "pkg/util.py": "x = 1\n",
      "README.md": "# ignored — not a source extension\n",
    });
    const result = await extractArchiveBuffer(CONNECTOR_ID, buf);
    expect(result.filesWritten).toBe(2); // .ts + .py, NOT .md
    const written = await fs.readFile(path.join(result.dir, "src/index.ts"), "utf-8");
    expect(written).toContain("export const x = 1;");
    // .md must NOT be written (extension filter)
    await expect(fs.access(path.join(result.dir, "README.md"))).rejects.toBeTruthy();
  });

  it("skips macOS __MACOSX / AppleDouble junk even when it has a source extension", async () => {
    // A real Finder-created zip carries a parallel `__MACOSX/` tree of `._*`
    // resource-fork stubs. `._app.sas` would pass the `.sas` extension filter,
    // so the junk filter must run first and drop them — only the real file is
    // written. (risk-calc regression: 91/182 ingested "files" were these stubs.)
    const buf = await zipFrom({
      "RISK/src/app.sas": "%macro m; %mend;\n",
      "__MACOSX/RISK/src/._app.sas": "Mac OS X resource fork stub",
      "RISK/src/._app.sas": "AppleDouble stub outside __MACOSX",
      "RISK/.DS_Store": "desktop metadata",
    });
    const result = await extractArchiveBuffer(CONNECTOR_ID, buf);
    expect(result.filesWritten).toBe(1); // only RISK/src/app.sas
    const written = await fs.readFile(path.join(result.dir, "RISK/src/app.sas"), "utf-8");
    expect(written).toContain("%macro m;");
    // None of the junk must be on disk.
    await expect(fs.access(path.join(result.dir, "__MACOSX"))).rejects.toBeTruthy();
    await expect(fs.access(path.join(result.dir, "RISK/src/._app.sas"))).rejects.toBeTruthy();
    await expect(fs.access(path.join(result.dir, "RISK/.DS_Store"))).rejects.toBeTruthy();
  });

  it("rejects an invalid (non-zip) buffer", async () => {
    await expect(
      extractArchiveBuffer(CONNECTOR_ID, Buffer.from("not a zip")),
    ).rejects.toMatchObject({ code: "ARCHIVE_INVALID" });
  });

  it("ZIP-SLIP: rejects an entry that escapes via `..`", async () => {
    stubMaliciousZip("../escape.ts");
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_ZIP_SLIP",
    });
  });

  it("ZIP-SLIP: rejects a deep `..` traversal", async () => {
    stubMaliciousZip("a/b/../../../../../../tmp/evil.ts");
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_ZIP_SLIP",
    });
  });

  it("ZIP-SLIP: rejects an absolute-path entry", async () => {
    stubMaliciousZip("/etc/evil.ts");
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_ZIP_SLIP",
    });
  });

  it("ZIP-SLIP: rejects a Windows backslash traversal", async () => {
    stubMaliciousZip("a\\..\\..\\..\\evil.ts");
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_ZIP_SLIP",
    });
  });

  it("ZIP-BOMB: rejects an entry exceeding the per-file size cap", async () => {
    const big = Buffer.alloc(MAX_EXTRACTED_FILE_BYTES + 1, 0x61);
    const buf = await zipFrom({ "huge.ts": big });
    await expect(extractArchiveBuffer(CONNECTOR_ID, buf)).rejects.toMatchObject({
      code: "ARCHIVE_FILE_TOO_LARGE",
    });
  });

  it("ZIP-BOMB: rejects an archive exceeding the entry-count cap", async () => {
    // Stub loadAsync to return a file set larger than the cap so we exercise the
    // entry-count guard without materialising tens of thousands of real entries.
    const files: Record<string, { dir: boolean; name: string }> = {};
    for (let i = 0; i <= MAX_ARCHIVE_ENTRIES; i++) {
      files[`f${i}.ts`] = { dir: false, name: `f${i}.ts` };
    }
    vi.spyOn(JSZip, "loadAsync").mockResolvedValue({ files } as unknown as JSZip);
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_TOO_MANY_ENTRIES",
    });
  });

  it("a normal small archive succeeds (entry-count guard not tripped)", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 5; i++) zip.file(`f${i}.ts`, "x\n");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    const res = await extractArchiveBuffer(CONNECTOR_ID, buf);
    expect(res.filesWritten).toBe(5);
  });

  it("leaves no partial extraction directory after a guard failure", async () => {
    stubMaliciousZip("../escape.ts");
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toBeTruthy();
    await expect(fs.access(path.join(extractDir, CONNECTOR_ID))).rejects.toBeTruthy();
  });

  it("ZIP-BOMB: rejects on the DECLARED uncompressed size (before decompressing)", async () => {
    // A header that lies BIG must be rejected up front without decompressing.
    const files = {
      "a.ts": {
        dir: false,
        name: "a.ts",
        async: async () => Buffer.from("small"),
        _data: { uncompressedSize: Number.MAX_SAFE_INTEGER },
      },
    };
    vi.spyOn(JSZip, "loadAsync").mockResolvedValue({ files } as unknown as JSZip);
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_FILE_TOO_LARGE",
    });
  });

  it("ZIP-BOMB: rejects when total uncompressed bytes exceed the cap", async () => {
    // Many entries, each under the per-file cap, summing past the total cap.
    // Stubbed so we don't materialise 100+ MiB of real data on disk.
    const perFile = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB, == per-file cap edge
    const entryCount = Math.ceil(MAX_EXTRACTED_BYTES / perFile.length) + 2;
    const files: Record<string, unknown> = {};
    for (let i = 0; i < entryCount; i++) {
      files[`f${i}.ts`] = {
        dir: false,
        name: `f${i}.ts`,
        async: async () => perFile,
        nodeStream: () => Readable.from([perFile]),
        _data: { uncompressedSize: perFile.length },
      };
    }
    vi.spyOn(JSZip, "loadAsync").mockResolvedValue({ files } as unknown as JSZip);
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_TOO_LARGE",
    });
  });

  it("storeUploadedArchive + extractArchiveFromPath round-trips a stored .zip", async () => {
    const buf = await zipFrom({ "src/app.ts": "export const app = 1;\n" });
    const archivePath = await storeUploadedArchive(CONNECTOR_ID, buf);
    expect(await fs.readFile(archivePath)).toEqual(buf);
    const result = await extractArchiveFromPath(CONNECTOR_ID, archivePath);
    expect(result.filesWritten).toBe(1);
    const written = await fs.readFile(path.join(result.dir, "src/app.ts"), "utf-8");
    expect(written).toContain("export const app = 1;");
  });

  it("cleanupExtraction removes the extraction directory", async () => {
    const buf = await zipFrom({ "src/app.ts": "export const app = 1;\n" });
    const result = await extractArchiveBuffer(CONNECTOR_ID, buf);
    await expect(fs.access(result.dir)).resolves.toBeUndefined();
    await cleanupExtraction(CONNECTOR_ID);
    await expect(fs.access(result.dir)).rejects.toBeTruthy();
  });

  it("ZIP-BOMB: rejects a FORGED small-header entry that inflates past the cap (#684)", async () => {
    // The declared header LIES that the entry is 5 bytes (slipping past the
    // declared-size gate), but the stream inflates well past the per-file cap.
    // The streaming inflater must abort and reject without draining the bomb.
    const CHUNK = 64 * 1024;
    let produced = 0;
    async function* bomb() {
      const target = MAX_EXTRACTED_FILE_BYTES * 8; // 8x the cap if fully drained
      while (produced < target) {
        produced += CHUNK;
        yield Buffer.alloc(CHUNK, 0x61);
      }
    }
    const files = {
      "bomb.ts": {
        dir: false,
        name: "bomb.ts",
        async: async () => Buffer.alloc(MAX_EXTRACTED_FILE_BYTES * 8, 0x61),
        nodeStream: () => Readable.from(bomb()),
        _data: { uncompressedSize: 5 },
      },
    };
    vi.spyOn(JSZip, "loadAsync").mockResolvedValue({ files } as unknown as JSZip);
    await expect(extractArchiveBuffer(CONNECTOR_ID, Buffer.from("x"))).rejects.toMatchObject({
      code: "ARCHIVE_FILE_TOO_LARGE",
    });
    // Bounded allocation: the extractor stopped pulling well before the 8x drain.
    expect(produced).toBeLessThan(MAX_EXTRACTED_FILE_BYTES * 4);
  });
});

describe("inflateEntryBounded (#684 streaming size guard)", () => {
  const entryWith = (stream: () => Readable) =>
    ({ nodeStream: stream }) as unknown as Parameters<typeof inflateEntryBounded>[0];

  it("returns the full content when under the cap", async () => {
    const data = Buffer.from("hello world");
    const { content, overflow } = await inflateEntryBounded(
      entryWith(() => Readable.from([data])),
      1024,
    );
    expect(overflow).toBe(false);
    expect(content.equals(data)).toBe(true);
  });

  it("allows content exactly at the cap", async () => {
    const data = Buffer.alloc(1024, 0x61);
    const { content, overflow } = await inflateEntryBounded(
      entryWith(() => Readable.from([data])),
      1024,
    );
    expect(overflow).toBe(false);
    expect(content.length).toBe(1024);
  });

  it("aborts with overflow the instant output crosses the cap, without draining", async () => {
    const CHUNK = 256;
    const cap = 1024;
    let produced = 0;
    async function* chunks() {
      for (let i = 0; i < (cap * 100) / CHUNK; i++) {
        produced += CHUNK;
        yield Buffer.alloc(CHUNK, 0x61);
      }
    }
    const { content, overflow } = await inflateEntryBounded(
      entryWith(() => Readable.from(chunks())),
      cap,
    );
    expect(overflow).toBe(true);
    expect(content.length).toBe(0);
    expect(produced).toBeLessThan(cap * 10);
  });

  it("propagates a stream error", async () => {
    const boom = () => {
      const r = new Readable({ read() {} });
      process.nextTick(() => r.destroy(new Error("inflate failed")));
      return r;
    };
    await expect(inflateEntryBounded(entryWith(boom), 1024)).rejects.toThrow("inflate failed");
  });
});
