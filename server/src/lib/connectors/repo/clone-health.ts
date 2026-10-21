/**
 * #1322 — is a connector's clone actually there, and if not, put it back.
 *
 * Clones used to default to the OS temp dir. macOS purged one down to 145 empty
 * directories, and a paid BRD was then generated from no source: "100 of 100 code
 * module(s) could not be read … effectively 0% grounded". Nothing noticed the
 * clone was hollow before the model calls started, and nothing put it back.
 *
 * {@link inspectClone} is the cheap check — HEAD readable and at least one file
 * in the working tree, found by a bounded walk that stops at the first file — and
 * {@link ensureConnectorClone} is what a reader calls before it relies on source:
 *
 *   1. healthy where it should be            → use it;
 *   2. healthy at the pre-#1322 tmp location, at the SAME commit → move it across;
 *   3. otherwise, a recorded commit to restore → re-fetch exactly that commit;
 *   4. otherwise → report why, so the caller can stop before any model spend.
 *
 * It never produces a clone at a commit other than the one it was asked for: the
 * code graph's symbols and line numbers describe that commit and no other.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { createChildLogger } from "../../logger.js";
import { tryAcquireConnectorIngest } from "../ingest-guard.js";
import { legacyTmpCloneRoot, resolveRepoCloneRoot, resolveRepoClonePath } from "./clone-path.js";
import { readCloneHeadSha, restoreCloneAtCommit } from "./repo-service.js";

const log = createChildLogger("clone-health");

/** A walk that has seen this many directories without a file calls the clone hollow. */
const MAX_DIRS_TO_SCAN = 5_000;

export type CloneState = "missing" | "hollow" | "healthy";

export interface CloneInspection {
  state: CloneState;
  /** The commit HEAD names, when it can be read. */
  headSha: string | null;
}

/**
 * Whether `dir` holds a usable clone. `missing`: no directory. `hollow`: a
 * directory, but HEAD cannot be read or the working tree holds no file (the
 * purged shape). `healthy`: HEAD reads and at least one working-tree file exists.
 *
 * `requireHead: false` drops the HEAD condition, for a reader that only lists and
 * reads files (the analysis file tools) and never asks which commit it is on.
 */
export async function inspectClone(
  dir: string,
  options: { requireHead?: boolean } = {},
): Promise<CloneInspection> {
  try {
    if (!(await fs.stat(dir)).isDirectory()) return { state: "missing", headSha: null };
  } catch {
    return { state: "missing", headSha: null };
  }
  const headSha = await readCloneHeadSha(dir);
  if (!headSha && options.requireHead !== false) return { state: "hollow", headSha: null };
  return { state: (await hasWorkingTreeFile(dir)) ? "healthy" : "hollow", headSha };
}

/** Breadth-first, outside `.git`, stopping at the first regular file. */
async function hasWorkingTreeFile(root: string): Promise<boolean> {
  const queue = [root];
  for (let seen = 0; queue.length > 0 && seen < MAX_DIRS_TO_SCAN; seen++) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dir === root && entry.name === ".git") continue;
      if (entry.isFile()) return true;
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  return false;
}

export type EnsureCloneOutcome =
  | { status: "healthy"; path: string }
  | { status: "migrated"; path: string }
  | { status: "restored"; path: string }
  | {
      status: "unavailable";
      /** Why nothing could be done — for the server log, never shown verbatim. */
      reason: "no-recorded-commit" | "ingest-in-progress" | "restore-failed";
      state: Exclude<CloneState, "healthy">;
    };

export interface EnsureCloneDeps {
  restore: typeof restoreCloneAtCommit;
}

// Resolved at call time: a test that `vi.mock`s repo-service without this export
// must still be able to import this module.
const defaultDeps: EnsureCloneDeps = { restore: (...args) => restoreCloneAtCommit(...args) };

/**
 * Make connector `connectorId`'s clone usable at `commitSha` (the code graph's
 * commit), or say why it cannot be. Only for git connectors — the caller filters.
 * Never throws: a failure is an `unavailable` outcome the caller turns into a stop.
 */
export async function ensureConnectorClone(
  input: { projectId: string; connectorId: string; commitSha: string | null },
  deps: EnsureCloneDeps = defaultDeps,
): Promise<EnsureCloneOutcome> {
  const target = resolveRepoClonePath(input.connectorId);
  const current = await inspectClone(target);
  if (current.state === "healthy") return { status: "healthy", path: target };
  const state = current.state;

  const lease = tryAcquireConnectorIngest(input.connectorId, "clone-restore");
  // An ingest is writing this very clone right now; touching it would race it.
  if (!lease) return { status: "unavailable", reason: "ingest-in-progress", state };
  try {
    if (input.commitSha && (await migrateLegacyClone(input.connectorId, input.commitSha))) {
      return { status: "migrated", path: target };
    }
    if (!input.commitSha) return { status: "unavailable", reason: "no-recorded-commit", state };
    try {
      await deps.restore(input.projectId, input.connectorId, input.commitSha, "system");
    } catch (err) {
      log.warn("Could not restore a missing or hollow repository clone", {
        connectorId: input.connectorId,
        state,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "unavailable", reason: "restore-failed", state };
    }
    if ((await inspectClone(target)).state !== "healthy") {
      return { status: "unavailable", reason: "restore-failed", state };
    }
    log.info("Restored a missing or hollow repository clone at its graph's commit", {
      connectorId: input.connectorId,
      state,
      commitSha: input.commitSha,
    });
    return { status: "restored", path: target };
  } finally {
    lease.release();
  }
}

/**
 * Move a clone left at the pre-#1322 default (`<tmpdir>/metis-repo-clones/<id>`)
 * into the durable root — only when it is healthy AND at `commitSha`, so a stale
 * clone of another commit is never adopted. A rename where it can; a copy then a
 * delete across filesystems (`EXDEV`, the usual case: tmp is often its own mount).
 */
async function migrateLegacyClone(connectorId: string, commitSha: string): Promise<boolean> {
  const legacyRoot = legacyTmpCloneRoot();
  if (!legacyRoot || path.resolve(legacyRoot) === path.resolve(resolveRepoCloneRoot())) {
    return false;
  }
  const legacy = path.join(legacyRoot, connectorId);
  const found = await inspectClone(legacy);
  if (found.state !== "healthy" || found.headSha !== commitSha) return false;
  const target = resolveRepoClonePath(connectorId);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    try {
      await fs.rename(legacy, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await fs.cp(legacy, target, { recursive: true, verbatimSymlinks: true });
      await fs.rm(legacy, { recursive: true, force: true });
    }
  } catch (err) {
    log.warn("Could not move a repository clone out of the old temp location", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
    await fs.rm(target, { recursive: true, force: true });
    return false;
  }
  log.info("Moved a repository clone from the old temp location to the data directory", {
    connectorId,
    commitSha,
  });
  return (await inspectClone(target)).state === "healthy";
}
