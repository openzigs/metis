/**
 * Epic #396 (MVP-7) — path-traversal + workspace-attachment guard for the
 * filesystem installer.
 *
 * Every write target MUST resolve to a path inside the project's attached
 * workspace root. Symlinks and `..` segments that escape the root are
 * rejected with `403 path_not_attached`.
 *
 * Symlink-safe: uses `fs.realpath()` on both the workspace root AND the
 * resolved target so a symlink under the workspace pointing outside cannot
 * bypass the lexical containment check (TOCTOU-resistant).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { SpecKitArtifactError } from "../artifacts.js";

export interface PathGuardOptions {
  workspaceRoot: string;
  /** Path relative to the workspace root, OR an absolute path inside it. */
  target: string;
}

/**
 * Resolve `target` against `workspaceRoot` and assert it stays inside.
 * Returns the absolute, **realpath-normalized** path. Throws on any escape.
 *
 * For targets that do not exist yet (typical for installer writes), we
 * realpath the deepest existing ancestor and re-attach the missing tail —
 * still rejecting if the real ancestor escapes the workspace.
 */
export async function resolveAttached(opts: PathGuardOptions): Promise<string> {
  // Defence-in-depth — reject `..` segments in the *raw* input even though
  // `path.resolve` would normalize them away. Audit log preserves what the
  // caller actually sent.
  if (opts.target.split(/[\\/]/).includes("..")) {
    throw new SpecKitArtifactError(
      403,
      "PATH_NOT_ATTACHED",
      `Path contains '..' segment which is forbidden: ${opts.target}`,
    );
  }

  // Realpath the root — reject if the workspace itself does not exist.
  let realRoot: string;
  try {
    realRoot = await fs.realpath(opts.workspaceRoot);
  } catch {
    throw new SpecKitArtifactError(
      403,
      "PATH_NOT_ATTACHED",
      `Workspace root does not exist or is unreadable: ${opts.workspaceRoot}`,
    );
  }

  const lexical = path.isAbsolute(opts.target)
    ? path.resolve(opts.target)
    : path.resolve(realRoot, opts.target);

  // Resolve symlinks on the target if it exists. If it does not exist (the
  // common case for new installer writes), walk up to the deepest existing
  // ancestor and realpath that — then re-attach the missing tail. This
  // keeps the check symlink-safe without requiring the file to pre-exist.
  let realTarget: string;
  try {
    realTarget = await fs.realpath(lexical);
  } catch {
    realTarget = await realpathDeepestAncestor(lexical);
  }

  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new SpecKitArtifactError(
      403,
      "PATH_NOT_ATTACHED",
      `Refusing to write outside attached workspace: ${opts.target}`,
    );
  }
  return realTarget;
}

/**
 * Walk up the path tree until we find an ancestor that exists, realpath
 * it, then re-attach the missing tail segments. Returns an absolute path
 * whose ancestor chain is symlink-resolved up to the first real entry.
 */
async function realpathDeepestAncestor(absPath: string): Promise<string> {
  const tail: string[] = [];
  let current = absPath;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root with nothing real — fall back to the
      // lexical form so the containment check can reject as appropriate.
      return absPath;
    }
    try {
      const realParent = await fs.realpath(parent);
      tail.unshift(path.basename(current));
      return path.join(realParent, ...tail);
    } catch {
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Workspace-attachment registry — pluggable so tests can inject a memory map. */
export interface AttachedWorkspaceLookup {
  /** Returns the absolute root path for a project's attached workspace, or null when none. */
  resolveWorkspaceRoot(projectId: string): Promise<string | null>;
}

/**
 * Default lookup — there is no first-class AttachedWorkspace model yet
 * (tracked for follow-up). The route layer rejects `/install` with HTTP
 * 501 until one exists. Unit tests inject a memory lookup.
 */
export const passthroughWorkspaceLookup: AttachedWorkspaceLookup = {
  async resolveWorkspaceRoot() {
    return null;
  },
};
