/**
 * #1643 — the production `RepoFileLoader` for product edge detection (#1619):
 * a repo's files, read from its connector's existing clone.
 *
 * - **The connector's own clone only.** The root is found where every other
 *   reader finds it (`resolveConnectorRoot`, `docs-gen/repository-sources.ts`);
 *   a repo with no checkout there yields `null`, so detection leaves its stored
 *   edges alone. Nothing is cloned or fetched here.
 * - **Never outside the root.** A symlink is not followed, file or directory
 *   (the walk goes by each entry's own type), and every file is re-resolved
 *   (`resolveSourcePath`) and opened with `O_NOFOLLOW` in case the tree changes
 *   under the walk, so a link committed into a repository cannot point a read
 *   at the server's own files.
 * - **Bounded like the crawl.** At most `MAX_FILES` files and `MAX_BYTES` bytes
 *   are read, the limits `crawlFiles` applies, in a stable (sorted) order; the
 *   directories the crawl skips are not walked. A file that does not fit what is
 *   left of the byte budget is not read, and a binary one (a NUL byte) is read
 *   against the budget but not handed on.
 * - **Only what the crawl can use (#1703).** A doc, data, lock or asset file
 *   (`isCrawlRelevant`) is skipped before it is opened, so it counts toward
 *   neither limit; and once less than a thousandth of the byte budget is left,
 *   the walk stops rather than open and list the rest of the tree.
 * - **A cut-short read says so.** When a limit leaves any file unread, the
 *   result is `partial`, and detection then deletes no stored edge touching the
 *   repo: on a repo with more files than the limit, the one that held an edge
 *   may sort after it (review of #1700).
 */
import { constants, type Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveConnectorRoot, resolveSourcePath } from "../docs-gen/repository-sources.js";
import type { DetectionRepo, RepoFileLoader, RepoFiles } from "./edge-detection.js";
import {
  MAX_BYTES,
  MAX_FILES,
  isCrawlRelevant,
  shouldSkipPath,
  type FileEntry,
} from "./repo-crawler.js";

export interface CloneFileLoaderOptions {
  /** Where a connector's clone is; null when it has none. Defaults to `resolveConnectorRoot`. */
  resolveRoot?: (connectorId: string) => Promise<string | null>;
  maxFiles?: number;
  maxBytes?: number;
}

/** A `RepoFileLoader` over each repo's connector clone. */
export function createCloneFileLoader(options: CloneFileLoaderOptions = {}): RepoFileLoader {
  const resolveRoot = options.resolveRoot ?? resolveConnectorRoot;
  return async (repo: DetectionRepo) => {
    const root = await resolveRoot(repo.repoConnectionId);
    if (!root) return null;
    return readCloneRepoFiles(root, {
      maxFiles: options.maxFiles ?? MAX_FILES,
      maxBytes: options.maxBytes ?? MAX_BYTES,
    });
  };
}

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** The text files under `root`, within the limits; paths are `/`-separated and relative. */
export async function readCloneFiles(
  root: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<FileEntry[]> {
  return (await readCloneRepoFiles(root, limits)).files;
}

/** `readCloneFiles`, plus whether a limit left any file unread. */
export async function readCloneRepoFiles(
  root: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<RepoFiles> {
  const files: FileEntry[] = [];
  let bytesRead = 0;
  let partial = false;

  /** The file, or null when it is not to be handed on. */
  const readContained = async (relPath: string): Promise<FileEntry | null> => {
    let absolute: string;
    try {
      absolute = await resolveSourcePath(root, relPath);
    } catch {
      return null; // escapes the root, or vanished
    }
    const handle = await open(absolute, OPEN_FLAGS).catch(() => null);
    if (!handle) return null;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      if (stat.size > limits.maxBytes - bytesRead) {
        partial = true;
        return null;
      }
      const buffer = await handle.readFile();
      bytesRead += buffer.length;
      if (bytesRead > limits.maxBytes) {
        partial = true;
        return null;
      }
      if (buffer.includes(0)) return null;
      return { path: relPath, content: buffer.toString("utf-8"), size: buffer.length };
    } finally {
      await handle.close();
    }
  };

  // #1703 — once less than a thousandth of the byte budget is left, the walk
  // stops: what is left can hold almost nothing, and opening and listing the
  // rest of a large tree for it is what made the read slow.
  const byteFloor = Math.ceil(limits.maxBytes / 1000);
  const full = () => files.length >= limits.maxFiles || limits.maxBytes - bytesRead < byteFloor;

  /**
   * Walk `rel`. Once a limit is reached, the next entry any level of the walk
   * comes to is one left unread, so the read is marked partial there.
   */
  const walk = async (rel: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (shouldSkipPath(relPath)) continue;
      // #1703 — a file the crawl cannot use is neither read nor counted.
      if (entry.isFile() && !isCrawlRelevant(relPath)) continue;
      if (full()) {
        partial = true;
        return;
      }
      // A Dirent describes the entry itself: a symlink is neither a directory
      // nor a file here, so no link is walked or read.
      if (entry.isDirectory()) {
        await walk(relPath);
      } else if (entry.isFile()) {
        const file = await readContained(relPath);
        if (file) files.push(file);
      }
    }
  };

  await walk("");
  return { files, partial };
}
