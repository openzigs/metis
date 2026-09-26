/**
 * Issue #217 — read one repository source file without following a symlink
 * swapped in after the walk checked it.
 *
 * The walk (`walkSourceFiles`) yields only regular files and, for the `local`
 * provider, only entries whose realpath stays inside the validated boundary.
 * Candidate collection `lstat`s each one. Both checks are by path, so a file
 * replaced by a symlink between them and the read was followed (#209 review).
 *
 * The read now goes through a handle:
 *   1. `open` with `O_NOFOLLOW` where the platform has it, so a symlink in the
 *      final path component fails to open (`ELOOP`) instead of being followed;
 *      and with `O_NONBLOCK` where the platform has it, so a FIFO swapped in
 *      returns at once instead of waiting forever for a writer (that wait held
 *      the connector's ingest lease and a libuv threadpool thread for the life
 *      of the process). `O_NONBLOCK` does not change reads of a regular file.
 *      Windows defines neither flag and needs neither: it has no filesystem
 *      FIFOs (named pipes live in the `\\.\pipe\` namespace, and opening
 *      one connects or fails at once rather than waiting for a writer).
 *   2. `fstat` the handle: it must be a regular file (a FIFO, socket or device
 *      is refused here, unread), and no larger than the ceiling (a file can
 *      grow after the walk sized it).
 *   3. `lstat` the path: it must still be a regular file with the handle's
 *      device and inode. This is the final-component check on platforms
 *      without `O_NOFOLLOW` (Windows), where the open follows a link.
 *   4. With a boundary, `realpath` the path and require it inside the boundary,
 *      then `stat` that real path and require the handle's device and inode.
 *      `O_NOFOLLOW` only guards the last component — a PARENT directory swapped
 *      for a symlink still resolves outside — and this is what catches that.
 *
 * Content is read from the handle only after all of that, so what is embedded
 * is the file that was checked. The read stops one byte past the ceiling, so a
 * file still growing after step 2 is reported `too-large`, never buffered
 * whole. Node has no `openat`, so a parent swapped and
 * swapped back between steps 1 and 4 is not closed completely; step 4's inode
 * comparison narrows it to an attacker who can toggle a directory repeatedly
 * inside that window on the server itself.
 */
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

/** True where `open` can refuse a symlink (Linux, macOS, BSD); false on Windows. */
export const O_NOFOLLOW_SUPPORTED = typeof fsConstants.O_NOFOLLOW === "number";

/** True where `open` can be made non-blocking (Linux, macOS, BSD); false on Windows. */
export const O_NONBLOCK_SUPPORTED = typeof fsConstants.O_NONBLOCK === "number";

/**
 * Flags for opening a source file: read-only, plus `O_NONBLOCK` where the
 * platform has it and `O_NOFOLLOW` where available and wanted.
 */
export function sourceOpenFlags(
  constants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number } = fsConstants,
  noFollow = true,
): number {
  let flags = constants.O_RDONLY;
  if (typeof constants.O_NONBLOCK === "number") flags |= constants.O_NONBLOCK;
  if (noFollow && typeof constants.O_NOFOLLOW === "number") flags |= constants.O_NOFOLLOW;
  return flags;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read from the start of `handle` until EOF or until more than `limit` bytes
 * have arrived. `null` means the file holds more than `limit` bytes.
 */
async function readAtMost(handle: fs.FileHandle, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
    if (total > limit) return null;
  }
}

/** `child` is `boundary` or strictly beneath it (separator boundary, not a string prefix). */
export function isWithinBoundary(boundary: string, child: string): boolean {
  return child === boundary || child.startsWith(boundary + path.sep);
}

export type ConfinedReadResult =
  | { ok: true; content: string; sizeBytes: number }
  /** A symlink, directory or other non-regular entry now sits at the path. */
  | { ok: false; reason: "not-regular" }
  /** The path now resolves outside the boundary. */
  | { ok: false; reason: "escaped" }
  /** Grew past the ceiling since the walk sized it; not read. */
  | { ok: false; reason: "too-large"; sizeBytes: number }
  | { ok: false; reason: "unreadable" };

export interface ConfinedReadOptions {
  /** Realpath the file must stay within (the `local` provider's validated root). */
  boundary?: string;
  maxFileBytes: number;
  /** Test seam for the Windows path; defaults to whether the platform has `O_NOFOLLOW`. */
  noFollow?: boolean;
}

function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export async function readConfinedSourceFile(
  absPath: string,
  opts: ConfinedReadOptions,
): Promise<ConfinedReadResult> {
  const noFollow = opts.noFollow ?? O_NOFOLLOW_SUPPORTED;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absPath, sourceOpenFlags(fsConstants, noFollow));
  } catch (err) {
    // ELOOP (Linux, macOS) / EMLINK (FreeBSD): O_NOFOLLOW met a symlink.
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === "ELOOP" || code === "EMLINK" ? "not-regular" : "unreadable",
    };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return { ok: false, reason: "not-regular" };

    const atPath = await fs.lstat(absPath, { bigint: true });
    if (!atPath.isFile() || !sameFile(atPath, opened)) return { ok: false, reason: "not-regular" };

    if (opts.boundary) {
      const real = await fs.realpath(absPath);
      if (!isWithinBoundary(opts.boundary, real)) return { ok: false, reason: "escaped" };
      if (!sameFile(await fs.stat(real, { bigint: true }), opened)) {
        return { ok: false, reason: "escaped" };
      }
    }

    const sizeBytes = Number(opened.size);
    if (sizeBytes > opts.maxFileBytes) return { ok: false, reason: "too-large", sizeBytes };
    const content = await readAtMost(handle, opts.maxFileBytes);
    if (!content) {
      // Grew past the ceiling after the fstat above; report its size now.
      return { ok: false, reason: "too-large", sizeBytes: Number((await handle.stat()).size) };
    }
    return { ok: true, content: content.toString("utf-8"), sizeBytes: content.length };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
