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
 */
import { constants, type Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveConnectorRoot, resolveSourcePath } from "../docs-gen/repository-sources.js";
import type { DetectionRepo, RepoFileLoader } from "./edge-detection.js";
import { MAX_BYTES, MAX_FILES, shouldSkipPath, type FileEntry } from "./repo-crawler.js";

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
    return readCloneFiles(root, {
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
  const files: FileEntry[] = [];
  let bytesRead = 0;

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
      if (!stat.isFile() || stat.size > limits.maxBytes - bytesRead) return null;
      const buffer = await handle.readFile();
      bytesRead += buffer.length;
      if (bytesRead > limits.maxBytes || buffer.includes(0)) return null;
      return { path: relPath, content: buffer.toString("utf-8"), size: buffer.length };
    } finally {
      await handle.close();
    }
  };

  const full = () => files.length >= limits.maxFiles || bytesRead >= limits.maxBytes;

  /** Walk `rel`; true once a limit is reached. */
  const walk = async (rel: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (full()) return true;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (shouldSkipPath(relPath)) continue;
      // A Dirent describes the entry itself: a symlink is neither a directory
      // nor a file here, so no link is walked or read.
      if (entry.isDirectory()) {
        if (await walk(relPath)) return true;
      } else if (entry.isFile()) {
        const file = await readContained(relPath);
        if (file) files.push(file);
      }
    }
    return full();
  };

  await walk("");
  return files;
}
