/**
 * Issue #329 — upload-connector archives must live under a PERSISTENT app-data
 * dir, not the OS temp dir (which macOS / many container runtimes purge),
 * otherwise re-ingest silently re-extracts nothing and doc-gen rebuilds empty
 * facts. These tests pin:
 *   - the DEFAULT archive/extract roots are persistent (under `<cwd>/data/...`),
 *     NOT `os.tmpdir()`;
 *   - the `UPLOAD_ARCHIVE_DIR` / `UPLOAD_EXTRACT_DIR` overrides are still honored;
 *   - a missing stored archive (e.g. an OS-temp purge of a pre-#329 connector)
 *     fails LOUDLY with a clean domain error instead of a raw ENOENT 500;
 *   - the store → re-extract round-trip survives across separate calls (the
 *     durability the fix is for) and existing extraction behaviour is unchanged.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { ConnectorError } from "../types.js";
import {
  extractArchiveBuffer,
  extractArchiveFromPath,
  storeUploadedArchive,
  uploadArchiveRoot,
  uploadExtractionRoot,
  cleanupExtraction,
} from "./archive-extract.js";

const ORIG_ENV = { ...process.env };

/** Build a minimal valid .zip with the given entries. */
async function makeZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Unique scratch dirs so parallel test files / runs never collide. */
let scratch: string;

beforeEach(async () => {
  delete process.env.UPLOAD_ARCHIVE_DIR;
  delete process.env.UPLOAD_EXTRACT_DIR;
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-329-test-"));
});

afterEach(async () => {
  process.env = { ...ORIG_ENV };
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("default archive/extract roots are persistent (issue #329)", () => {
  it("uploadArchiveRoot defaults UNDER the app data dir, not os.tmpdir()", () => {
    const root = uploadArchiveRoot();
    expect(root).toBe(path.resolve(process.cwd(), "data", "repo-archives"));
    // Regression guard: the bug was defaulting into the purge-prone OS temp dir.
    expect(root.startsWith(path.resolve(os.tmpdir()))).toBe(false);
  });

  it("uploadExtractionRoot defaults UNDER the app data dir, not os.tmpdir()", () => {
    const root = uploadExtractionRoot();
    expect(root).toBe(path.resolve(process.cwd(), "data", "repo-extracts"));
    expect(root.startsWith(path.resolve(os.tmpdir()))).toBe(false);
  });

  it("honors UPLOAD_ARCHIVE_DIR / UPLOAD_EXTRACT_DIR overrides", () => {
    process.env.UPLOAD_ARCHIVE_DIR = path.join(scratch, "custom-archives");
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "custom-extracts");
    expect(uploadArchiveRoot()).toBe(path.resolve(scratch, "custom-archives"));
    expect(uploadExtractionRoot()).toBe(path.resolve(scratch, "custom-extracts"));
  });
});

describe("store + re-extract durability round-trip (issue #329)", () => {
  it("a stored archive can be re-extracted in a SEPARATE call (survives re-ingest)", async () => {
    process.env.UPLOAD_ARCHIVE_DIR = path.join(scratch, "archives");
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "extracts");
    const buf = await makeZip({ "src/a.py": "x=1\n", "src/b.go": "package main\n" });

    const archivePath = await storeUploadedArchive("conn1abc", buf);
    // Archive lives under the configured (persistent) root, NOT tmp.
    expect(archivePath).toBe(path.join(path.resolve(scratch, "archives"), "conn1abc.zip"));
    expect((await fs.stat(archivePath)).isFile()).toBe(true);

    // Re-ingest path: re-extract straight from the stored archive.
    const result = await extractArchiveFromPath("conn1abc", archivePath);
    expect(result.filesWritten).toBe(2);
    expect(await fs.readFile(path.join(result.dir, "src/a.py"), "utf-8")).toBe("x=1\n");

    await cleanupExtraction("conn1abc");
  });

  it("survives a purge of the EXTRACTION dir as long as the archive persists", async () => {
    process.env.UPLOAD_ARCHIVE_DIR = path.join(scratch, "archives");
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "extracts");
    const buf = await makeZip({ "src/a.py": "x=1\n" });
    const archivePath = await storeUploadedArchive("conn2abc", buf);

    // First extraction, then simulate an OS purge of ONLY the transient extract dir.
    const first = await extractArchiveFromPath("conn2abc", archivePath);
    await fs.rm(uploadExtractionRoot(), { recursive: true, force: true });
    await expect(fs.stat(first.dir)).rejects.toThrow();

    // Re-extract still works because the archive lives in the persistent root.
    const second = await extractArchiveFromPath("conn2abc", archivePath);
    expect(second.filesWritten).toBe(1);
  });
});

describe("missing archive fails loudly, not silently (issue #329)", () => {
  it("throws a clean ConnectorError(410, UPLOAD_ARCHIVE_MISSING) when the archive is gone", async () => {
    process.env.UPLOAD_ARCHIVE_DIR = path.join(scratch, "archives");
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "extracts");
    // Path under the configured root that was never written (simulates a
    // pre-#329 connector whose os-temp archive was purged).
    const goneArchive = path.join(path.resolve(scratch, "archives"), "purgedconn.zip");

    const err = await extractArchiveFromPath("purgedconn", goneArchive).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).status).toBe(410);
    expect((err as ConnectorError).code).toBe("UPLOAD_ARCHIVE_MISSING");
    // Must NOT leak the raw ENOENT / filesystem path in the user-facing message.
    expect((err as ConnectorError).message).not.toMatch(/ENOENT/);
  });

  it("a non-ENOENT read failure still propagates (not masked as UPLOAD_ARCHIVE_MISSING)", async () => {
    process.env.UPLOAD_ARCHIVE_DIR = path.join(scratch, "archives");
    // Point at a DIRECTORY rather than a file → read fails with EISDIR, which is
    // a real error we must not silently rewrite into "missing".
    const dirAsArchive = path.resolve(scratch, "archives");
    await fs.mkdir(dirAsArchive, { recursive: true });
    const err = await extractArchiveFromPath("dirconn", dirAsArchive).catch((e) => e);
    // Either a raw EISDIR error or a ConnectorError, but NOT the missing-archive code.
    if (err instanceof ConnectorError) {
      expect(err.code).not.toBe("UPLOAD_ARCHIVE_MISSING");
    } else {
      expect(String(err)).toMatch(/EISDIR|illegal operation/i);
    }
  });
});

describe("existing extraction behaviour unchanged (regression)", () => {
  it("extracts source files, filters junk + non-source extensions", async () => {
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "extracts");
    const buf = await makeZip({
      "src/keep.py": "print(1)\n",
      "src/skip.bin": "binary",
      "__MACOSX/._keep.py": "junk",
    });
    const result = await extractArchiveBuffer("conn3abc", buf);
    expect(result.filesWritten).toBe(1);
    await expect(fs.stat(path.join(result.dir, "src/keep.py"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(result.dir, "src/skip.bin"))).rejects.toThrow();
    await cleanupExtraction("conn3abc");
  });

  it("rejects an invalid (non-zip) buffer with ARCHIVE_INVALID", async () => {
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "extracts");
    const err = await extractArchiveBuffer("conn4abc", Buffer.from("not a zip")).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("ARCHIVE_INVALID");
  });

  it("rejects a per-file over-cap entry with ARCHIVE_FILE_TOO_LARGE", async () => {
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "extracts");
    // 1 MiB + 1 byte of source content → over MAX_EXTRACTED_FILE_BYTES (1 MiB).
    const huge = "a".repeat(1 * 1024 * 1024 + 1);
    const buf = await makeZip({ "src/big.py": huge });
    const err = await extractArchiveBuffer("conn5abc", buf).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as ConnectorError).code).toBe("ARCHIVE_FILE_TOO_LARGE");
    // The failed extraction must leave no partial dir behind.
    await expect(fs.stat(path.join(uploadExtractionRoot(), "conn5abc"))).rejects.toThrow();
  });

  it("cleanupExtraction removes a connector's extraction dir and never throws", async () => {
    process.env.UPLOAD_EXTRACT_DIR = path.join(scratch, "extracts");
    const buf = await makeZip({ "src/a.py": "x=1\n" });
    const result = await extractArchiveBuffer("conn7abc", buf);
    await expect(fs.stat(result.dir)).resolves.toBeDefined();
    await cleanupExtraction("conn7abc");
    await expect(fs.stat(result.dir)).rejects.toThrow();
    // Idempotent: a second cleanup on an already-gone dir is a no-op, not a throw.
    await expect(cleanupExtraction("conn7abc")).resolves.toBeUndefined();
  });
});
