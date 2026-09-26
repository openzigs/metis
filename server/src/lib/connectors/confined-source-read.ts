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
 *      final path component fails to open (`ELOOP`) instead of being followed.
 *   2. `fstat` the handle: it must be a regular file, and no larger than the
 *      ceiling (a file can grow after the walk sized it).
 *   3. `lstat` the path: it must still be a regular file with the handle's
 *      device and inode. This is the final-component check on platforms
 *      without `O_NOFOLLOW` (Windows), where the open follows a link.
 *   4. With a boundary, `realpath` the path and require it inside the boundary,
 *      then `stat` that real path and require the handle's device and inode.
 *      `O_NOFOLLOW` only guards the last component — a PARENT directory swapped
 *      for a symlink still resolves outside — and this is what catches that.
 *
 * Content is read from the handle only after all of that, so what is embedded
 * is the file that was checked. Node has no `openat`, so a parent swapped and
 * swapped back between steps 1 and 4 is not closed completely; step 4's inode
 * comparison narrows it to an attacker who can toggle a directory repeatedly
 * inside that window on the server itself.
 */
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";

/** True where `open` can refuse a symlink (Linux, macOS, BSD); false on Windows. */
export const O_NOFOLLOW_SUPPORTED = typeof fsConstants.O_NOFOLLOW === "number";

/** Flags for opening a source file: read-only, plus `O_NOFOLLOW` where available and wanted. */
export function sourceOpenFlags(
  constants: { O_RDONLY: number; O_NOFOLLOW?: number } = fsConstants,
  noFollow = true,
): number {
  return noFollow && typeof constants.O_NOFOLLOW === "number"
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : constants.O_RDONLY;
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
    return { ok: true, content: await handle.readFile("utf-8"), sizeBytes };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
