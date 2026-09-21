/**
 * Local-directory source guard — issue #288, mechanism (A).
 *
 * The `local` repo provider ingests a filesystem directory that the METIS
 * server process can read (self-hosted / mounted volume). Because it reads
 * arbitrary server files, it is gated behind a DEPLOYMENT-LEVEL allowlist and
 * an `admin`-only authorization check (enforced at the route layer).
 *
 * SECURITY MODEL (defense in depth):
 *   1. Allowlist roots come ONLY from env `LOCAL_SOURCE_ROOTS` (an OS path-list
 *      of ABSOLUTE directories). If unset/empty → DEFAULT DENY. The feature is
 *      opt-in by the operator who runs the server.
 *   2. The user-supplied path is resolved with `fs.realpath` (follows symlinks)
 *      BEFORE the containment check, so a symlink whose target escapes a root
 *      is rejected. `..` traversal collapses during resolution and is likewise
 *      caught by containment.
 *   3. Containment uses a RESOLVED-path + path-separator-boundary check, never
 *      a raw string prefix (so `/srv/allowed` does not match `/srv/allowed-evil`).
 *   4. During the walk we never follow a symlink whose realpath leaves the root.
 *
 * We never log the resolved path (it can reveal server layout); errors carry a
 * stable code and a generic message.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { delimiter as PATH_LIST_DELIMITER } from "node:path";
import { ConnectorError } from "../types.js";

/** Env var holding the OS-path-list of allowed absolute root directories. */
export const LOCAL_SOURCE_ROOTS_ENV = "LOCAL_SOURCE_ROOTS";

/**
 * Parse `LOCAL_SOURCE_ROOTS` into a normalized list of absolute root paths.
 * Relative or empty entries are dropped. Returns `[]` when the env is unset or
 * contains no usable absolute path — callers MUST treat `[]` as default-deny.
 */
export function getAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[LOCAL_SOURCE_ROOTS_ENV];
  if (!raw || raw.trim() === "") return [];
  return raw
    .split(PATH_LIST_DELIMITER)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && path.isAbsolute(p))
    .map((p) => path.resolve(p));
}

/**
 * True when `child` is the same path as `parent` or strictly nested beneath it.
 * Uses a path-separator boundary so `/a/b` does NOT contain `/a/bc`.
 */
function isContained(parent: string, child: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent + path.sep);
}

export interface ValidatedLocalSource {
  /** The realpath of the validated directory — safe to walk/ingest. */
  realPath: string;
  /** The allowed root (realpath) that contains it. */
  root: string;
}

/**
 * Validate that `userPath` resolves (via realpath) to an existing directory
 * contained within one of the `LOCAL_SOURCE_ROOTS` allowlist entries.
 *
 * Throws a {@link ConnectorError} on every failure mode:
 *   - allowlist unset/empty            → 403 LOCAL_SOURCE_DISABLED
 *   - path missing / not a directory   → 400 LOCAL_PATH_INVALID
 *   - resolved path outside every root → 403 LOCAL_PATH_FORBIDDEN
 *
 * On success returns the REALPATH (symlinks resolved) so callers walk the real
 * directory, never an alias that could later be repointed.
 */
export async function validateLocalSourcePath(
  userPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ValidatedLocalSource> {
  const roots = getAllowedRoots(env);
  if (roots.length === 0) {
    throw new ConnectorError(
      403,
      "LOCAL_SOURCE_DISABLED",
      "Local directory ingestion is disabled. Set LOCAL_SOURCE_ROOTS to opt in.",
    );
  }
  if (typeof userPath !== "string" || userPath.trim() === "" || userPath.includes("\0")) {
    throw new ConnectorError(400, "LOCAL_PATH_INVALID", "localPath is not a valid path");
  }

  // Resolve symlinks + `..` BEFORE any containment decision. realpath throws on
  // a non-existent path, which we surface as a generic invalid-path error.
  let realPath: string;
  try {
    realPath = await fs.realpath(path.resolve(userPath));
  } catch {
    throw new ConnectorError(
      400,
      "LOCAL_PATH_INVALID",
      "localPath does not exist or is unreadable",
    );
  }

  // Compare against the REALPATH of each root so a symlinked root entry is also
  // resolved consistently before the separator-boundary containment check.
  let contained = false;
  let matchedRoot = "";
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue; // a misconfigured / missing root is simply skipped
    }
    if (isContained(realRoot, realPath)) {
      contained = true;
      matchedRoot = realRoot;
      break;
    }
  }
  if (!contained) {
    throw new ConnectorError(
      403,
      "LOCAL_PATH_FORBIDDEN",
      "localPath is not within an allowed LOCAL_SOURCE_ROOTS directory",
    );
  }

  const stat = await fs.stat(realPath);
  if (!stat.isDirectory()) {
    throw new ConnectorError(400, "LOCAL_PATH_INVALID", "localPath must be a directory");
  }

  return { realPath, root: matchedRoot };
}
