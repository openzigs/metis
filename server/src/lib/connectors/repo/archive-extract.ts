/**
 * Folder-upload archive extraction — issue #288, mechanism (B).
 *
 * The `upload` repo provider lets a user upload a .zip of a directory; the
 * server extracts it into a fresh, dedicated extraction root and ingests the
 * source files via the SAME pipeline GitHub clones feed.
 *
 * SECURITY MODEL (defense in depth):
 *   - ZIP-SLIP: every entry's destination is resolved against the extraction
 *     root and rejected unless it is contained within it (separator-boundary
 *     check on the RESOLVED path). Absolute paths, `..` traversal, and Windows
 *     drive letters / backslashes all collapse to "outside the root" and are
 *     rejected. We only ever write within the dedicated root.
 *   - ZIP-BOMB: total uncompressed bytes, per-file uncompressed bytes, and
 *     entry count are all capped. We check the declared `uncompressedSize` up
 *     front as a fast reject AND inflate each entry through a size-bounded
 *     STREAM that aborts the moment its output crosses the per-file cap, so a
 *     forged header that lies about its size cannot force unbounded in-memory
 *     decompression (#684).
 *   - EXTENSION FILTER: only files whose extension is in `SOURCE_EXTENSIONS`
 *     are written to disk; everything else is ignored.
 *
 * All `fs` writes target paths derived from the caller-controlled extraction
 * root joined with a zip-slip-validated relative path; see the `nosemgrep`
 * annotations at each write site.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_EXTRACTED_BYTES,
  MAX_EXTRACTED_FILE_BYTES,
  isJunkSourcePath,
} from "@metis/shared";
import { ConnectorError } from "../types.js";
import { SOURCE_EXTENSIONS } from "../connector-ingest.js";

/** Best-effort recursive remove that never throws (used on cleanup paths). */
async function rmSilent(target: string): Promise<void> {
  try {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename.detect-non-literal-fs-filename -- callers only pass server-derived extraction dirs (root + cuid) or zip-slip-validated paths; never raw user input.
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    /* swallow — cleanup is best-effort */
  }
}

/**
 * Root under which all per-connector extraction directories live.
 *
 * Issue #329 — DEFAULT is a PERSISTENT app-data dir (`<cwd>/data/repo-extracts`),
 * mirroring the other on-disk stores (`data/uploads`, `data/repo-clones`,
 * `data/lancedb`). The previous default of `os.tmpdir()` was purged by macOS
 * (`/var/folders/.../T`) and many container runtimes, which silently wiped an
 * upload connector's working copy between ingests. `UPLOAD_EXTRACT_DIR` still
 * overrides it (e.g. to a mounted volume in production).
 */
export function uploadExtractionRoot(): string {
  return path.resolve(
    process.env.UPLOAD_EXTRACT_DIR || path.join(process.cwd(), "data", "repo-extracts"),
  );
}

/**
 * Directory where uploaded .zip archives are persisted for re-ingest.
 *
 * Issue #329 — see {@link uploadExtractionRoot}. The DEFAULT is now
 * `<cwd>/data/repo-archives` (persistent) instead of `os.tmpdir()`, so a stored
 * archive survives OS temp purges and re-ingest can re-extract without requiring
 * the user to re-upload (the intent of #289). `UPLOAD_ARCHIVE_DIR` overrides it.
 */
export function uploadArchiveRoot(): string {
  return path.resolve(
    process.env.UPLOAD_ARCHIVE_DIR || path.join(process.cwd(), "data", "repo-archives"),
  );
}

/**
 * Resolve `relPath` (a zip entry name) against `root` and return the absolute
 * destination ONLY if it stays within `root`. Returns `null` for any entry that
 * would escape (absolute path, `..`, drive letter, backslash traversal).
 */
function safeJoin(root: string, relPath: string): string | null {
  // Normalize Windows separators so a `a\..\..\evil` entry can't slip past a
  // POSIX-only `..` check on the server.
  const normalizedRel = relPath.replace(/\\/g, "/");
  if (normalizedRel.includes("\0")) return null;
  const dest = path.resolve(root, normalizedRel);
  if (dest === root) return root;
  if (!dest.startsWith(root + path.sep)) return null;
  return dest;
}

export interface ExtractResult {
  /** Absolute path of the populated extraction directory — safe to walk. */
  dir: string;
  /** Number of source files actually written. */
  filesWritten: number;
  /** Total uncompressed bytes written. */
  bytesWritten: number;
}

/**
 * Persist an uploaded .zip buffer to a stable archive path so re-ingest can
 * re-extract without requiring re-upload. Returns the archive path.
 */
export async function storeUploadedArchive(connectorId: string, buffer: Buffer): Promise<string> {
  const root = uploadArchiveRoot();
  await fs.mkdir(root, { recursive: true });
  // connectorId is a server-generated cuid (no user-controlled separators).
  const archivePath = path.join(root, `${connectorId}.zip`);
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `connectorId` is a server-generated cuid (matches /^[a-z0-9]+$/), never user input, so the join cannot traverse outside `uploadArchiveRoot()`.
  await fs.writeFile(archivePath, buffer, { mode: 0o600 });
  return archivePath;
}

/**
 * Extract a stored archive (by path) into a FRESH extraction directory for the
 * given connector, enforcing all zip-slip / zip-bomb guards and the source
 * extension filter. The caller owns cleanup of the returned `dir`.
 */
export async function extractArchiveFromPath(
  connectorId: string,
  archivePath: string,
): Promise<ExtractResult> {
  let buffer: Buffer;
  try {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename.detect-non-literal-fs-filename -- `archivePath` is produced by storeUploadedArchive() from a server-generated cuid; it is never raw user input.
    buffer = await fs.readFile(archivePath);
  } catch (err) {
    // Issue #329 — a missing stored archive means re-ingest CANNOT re-extract
    // (the archive was purged, e.g. a pre-#329 connector that staged into the
    // OS temp dir). FAIL LOUDLY with a clean domain error instead of letting a
    // raw ENOENT bubble up as an opaque 500 — and instead of the old behaviour
    // where doc-gen then rebuilt EMPTY facts off a vanished working copy. The
    // 410 (Gone) tells the caller the connector must be re-uploaded.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new ConnectorError(
        410,
        "UPLOAD_ARCHIVE_MISSING",
        "The stored upload archive is missing — re-upload the folder to re-ingest this connector",
      );
    }
    throw err;
  }
  return extractArchiveBuffer(connectorId, buffer);
}

/**
 * Inflate a single zip entry through JSZip's STREAMING interface, aborting the
 * instant the running output exceeds `maxBytes`. Returns `overflow: true` with
 * an empty buffer (rather than the full payload) when the cap is crossed.
 *
 * Issue #684 - the declared-size guard (`_data.uncompressedSize`) is a cheap
 * fast-path, but a forged header that lies about its size slips past it. The old
 * code then called `entry.async("nodebuffer")`, which materializes the ENTIRE
 * decompressed payload in memory before the length is re-checked - so a ~1000:1
 * DEFLATE bomb could inflate to tens of GB and OOM the worker. Streaming and
 * aborting bounds peak memory to ~`maxBytes` + one chunk no matter what the
 * header claimed.
 */
export function inflateEntryBounded(
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<{ content: Buffer; overflow: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = entry.nodeStream("nodebuffer");

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    stream.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        // Cross the cap -> stop inflating NOW. pause() halts JSZip's worker so
        // no further chunks are produced; drop what we buffered so nothing
        // large survives. The caller turns overflow into the domain 413.
        stream.pause();
        chunks.length = 0;
        settle(() => resolve({ content: Buffer.alloc(0), overflow: true }));
        return;
      }
      chunks.push(buf);
    });
    stream.on("error", (err: Error) => settle(() => reject(err)));
    stream.on("end", () =>
      settle(() => resolve({ content: Buffer.concat(chunks), overflow: false })),
    );
  });
}

/**
 * Extract a .zip buffer into a fresh extraction directory for the connector.
 * Enforces zip-slip + zip-bomb guards and the SOURCE_EXTENSIONS filter.
 */
export async function extractArchiveBuffer(
  connectorId: string,
  buffer: Buffer,
): Promise<ExtractResult> {
  const root = uploadExtractionRoot();
  // connectorId is a server-generated cuid — safe to join.
  const dir = path.join(root, connectorId);
  // Always start from a clean extraction directory.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename.detect-non-literal-fs-filename -- `dir` is root + server-generated cuid; no user-controlled path segment.
  await fs.rm(dir, { recursive: true, force: true });
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename.detect-non-literal-fs-filename -- `dir` is root + server-generated cuid; no user-controlled path segment.
  await fs.mkdir(dir, { recursive: true });
  const realDir = await fs.realpath(dir);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    await rmSilent(dir);
    throw new ConnectorError(400, "ARCHIVE_INVALID", "Uploaded file is not a valid .zip archive");
  }

  // Entry-count guard (zip-bomb): reject before doing any work.
  const entryNames = Object.keys(zip.files);
  if (entryNames.length > MAX_ARCHIVE_ENTRIES) {
    await rmSilent(dir);
    throw new ConnectorError(
      413,
      "ARCHIVE_TOO_MANY_ENTRIES",
      `Archive exceeds the ${MAX_ARCHIVE_ENTRIES}-entry limit`,
    );
  }

  let filesWritten = 0;
  let bytesWritten = 0;

  try {
    for (const name of entryNames) {
      const entry = zip.files[name];
      if (entry.dir) continue;

      // ZIP-SLIP guard — reject any entry that escapes the extraction root.
      const dest = safeJoin(realDir, entry.name);
      if (dest === null) {
        throw new ConnectorError(
          400,
          "ARCHIVE_ZIP_SLIP",
          "Archive entry escapes the extraction directory",
        );
      }

      // OS/archive junk filter — macOS Finder zips embed a `__MACOSX/` tree of
      // AppleDouble `._*` resource-fork stubs. They are never source; skipping
      // them here keeps them off disk so they can never reach ingestion. This
      // runs BEFORE the extension filter because `._foo.sas` would otherwise
      // pass the `.sas` allowlist.
      if (isJunkSourcePath(entry.name)) continue;

      // Extension filter — only ingest known source files.
      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      // ZIP-BOMB guard (declared size) — reject before decompressing if the
      // header already claims a per-file size over the cap.
      const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize;
      if (typeof declared === "number" && declared > MAX_EXTRACTED_FILE_BYTES) {
        throw new ConnectorError(
          413,
          "ARCHIVE_FILE_TOO_LARGE",
          "An archive entry exceeds the per-file size cap",
        );
      }

      // ZIP-BOMB guard (actual size) — stream the inflation and ABORT the
      // instant the running output crosses the per-file cap, so a FORGED
      // `uncompressedSize` header (which slips past the declared-size check
      // above) can never inflate to gigabytes in memory before we notice
      // (#684). Peak memory stays bounded to ~MAX_EXTRACTED_FILE_BYTES.
      const { content, overflow } = await inflateEntryBounded(entry, MAX_EXTRACTED_FILE_BYTES);
      if (overflow) {
        throw new ConnectorError(
          413,
          "ARCHIVE_FILE_TOO_LARGE",
          "An archive entry exceeds the per-file size cap",
        );
      }
      if (bytesWritten + content.length > MAX_EXTRACTED_BYTES) {
        throw new ConnectorError(
          413,
          "ARCHIVE_TOO_LARGE",
          "Archive exceeds the total uncompressed size cap",
        );
      }

      // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename.detect-non-literal-fs-filename -- `dest` is the output of safeJoin(realDir, ...) which guarantees containment within the realpath'd extraction root; zip-slip entries are rejected above.
      await fs.mkdir(path.dirname(dest), { recursive: true });
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename.detect-non-literal-fs-filename -- `dest` passed the safeJoin containment guard, so it cannot escape the extraction root.
      await fs.writeFile(dest, content);
      filesWritten += 1;
      bytesWritten += content.length;
    }
  } catch (err) {
    // On any guard failure, leave no partial extraction on disk.
    await rmSilent(dir);
    throw err;
  }

  return { dir: realDir, filesWritten, bytesWritten };
}

/** Remove a connector's extraction directory (best-effort). */
export async function cleanupExtraction(connectorId: string): Promise<void> {
  const dir = path.join(uploadExtractionRoot(), connectorId);
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-fs-filename.detect-non-literal-fs-filename -- `dir` is root + server-generated cuid; no user-controlled segment.
  await rmSilent(dir);
}
