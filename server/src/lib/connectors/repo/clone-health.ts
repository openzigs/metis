/**
 * #1322 — is a connector's clone actually there, and if not, put it back.
 *
 * Clones used to default to the OS temp dir. macOS purged one down to 145 empty
 * directories, and a paid BRD was then generated from no source: "100 of 100 code
 * module(s) could not be read … effectively 0% grounded". Nothing noticed the
 * clone was hollow before the model calls started, and nothing put it back.
 *
 * {@link inspectClone} is the cheap check — HEAD readable, and the working tree
 * holding (nearly) as many files as the git index lists, counted by a walk that
 * stops as soon as it has seen enough — and {@link ensureConnectorClone} is what a
 * reader calls before it relies on source:
 *
 *   1. healthy where it should be, at the recorded commit → use it;
 *   2. healthy at the pre-#1322 tmp location, at the SAME commit → move it across;
 *   3. otherwise, a recorded commit to restore → re-fetch exactly that commit;
 *   4. otherwise → report why, so the caller can stop before any model spend.
 *
 * It never produces a clone at a commit other than the one it was asked for: the
 * code graph's symbols and line numbers describe that commit and no other.
 */
import { SYSTEM_ACTOR_ID } from "../../audit/system-actor.js";
import { promises as fs } from "node:fs";
import path from "node:path";

import { createChildLogger } from "../../logger.js";
import { tryAcquireConnectorIngest, type ConnectorIngestLease } from "../ingest-guard.js";
import { legacyTmpCloneRoot, resolveRepoCloneRoot, resolveRepoClonePath } from "./clone-path.js";
import { readCloneHeadSha, restoreCloneAtCommit } from "./repo-service.js";

const log = createChildLogger("clone-health");

/**
 * The working tree must hold at least this share of the files the git index lists.
 * A purge removes files by age, so a damaged clone is far below it; the slack is
 * for gitlinks (submodule directories, not files) and the odd file a tool removed.
 */
const MIN_PRESENT_RATIO = 0.95;
/** A walk that has read this many directories without reaching the bar stops: unknown. */
const MAX_DIRS_TO_SCAN = 20_000;

export type CloneState = "missing" | "hollow" | "healthy";

export interface CloneInspection {
  state: CloneState;
  /** The commit HEAD names, when it can be read. */
  headSha: string | null;
}

/**
 * Entry count from `.git/index` (header: "DIRC", version, entry count — bytes
 * 8-11, big-endian). Null when there is no readable index.
 */
async function readIndexEntryCount(dir: string): Promise<number | null> {
  let handle;
  try {
    handle = await fs.open(path.join(dir, ".git", "index"), "r");
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    if (bytesRead < 12 || header.toString("latin1", 0, 4) !== "DIRC") return null;
    return header.readUInt32BE(8);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Whether `dir` holds a usable clone.
 * - `missing`: no directory.
 * - `hollow`: a directory, but HEAD cannot be read, or the working tree holds fewer
 *   than {@link MIN_PRESENT_RATIO} of the files the index lists (a full or PARTIAL
 *   purge), or — with no index — no file at all.
 * - `healthy`: otherwise. A walk that hits its directory budget before it can tell
 *   counts as healthy when HEAD and the index read: unknown is not evidence of a purge.
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
  const indexed = headSha ? await readIndexEntryCount(dir) : null;
  if (indexed === null && options.requireHead !== false) return { state: "hollow", headSha };
  // No index (a plain directory, analysis only): one file is all that can be asked.
  const needed = indexed === null ? 1 : Math.max(1, Math.ceil(indexed * MIN_PRESENT_RATIO));
  if (indexed === 0) return { state: "healthy", headSha };
  const seen = await countWorkingTreeFiles(dir, needed);
  const healthy = seen === "unknown" ? indexed !== null : seen >= needed;
  return { state: healthy ? "healthy" : "hollow", headSha };
}

/**
 * Breadth-first, outside `.git`, counting non-directory entries (files and
 * symlinks, as the index does) and stopping once `enough` are seen.
 */
async function countWorkingTreeFiles(root: string, enough: number): Promise<number | "unknown"> {
  const queue = [root];
  let count = 0;
  for (let next = 0; next < queue.length; next++) {
    if (next >= MAX_DIRS_TO_SCAN) return "unknown";
    const dir = queue[next]!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (dir === root && entry.name === ".git") continue;
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
      else if (++count >= enough) return count;
    }
  }
  return count;
}

export type UnavailableReason =
  /** Nothing to restore to: the graph records no commit. */
  | "no-recorded-commit"
  /** Another job held the connector for longer than the wait: try again, not re-ingest. */
  | "busy"
  | "restore-failed";

export type EnsureCloneOutcome =
  | { status: "healthy"; path: string }
  | { status: "migrated"; path: string }
  | { status: "restored"; path: string }
  | {
      status: "unavailable";
      /** Why nothing could be done — for the server log, never shown verbatim. */
      reason: UnavailableReason;
      state: CloneState;
    };

export interface EnsureCloneDeps {
  restore: typeof restoreCloneAtCommit;
  /** How long to wait for another job's hold on the connector (ms). */
  leaseWaitMs?: number;
}

const DEFAULT_LEASE_WAIT_MS = 120_000;
const LEASE_POLL_MS = 250;

/** `CLONE_RESTORE_LEASE_WAIT_MS` — how long a reader waits for a busy connector. */
export function resolveLeaseWaitMs(): number {
  const text = process.env.CLONE_RESTORE_LEASE_WAIT_MS?.trim();
  const raw = text ? Number(text) : NaN;
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_LEASE_WAIT_MS;
}

// Resolved at call time: a test that `vi.mock`s repo-service without this export
// must still be able to import this module.
const defaultDeps: EnsureCloneDeps = { restore: (...args) => restoreCloneAtCommit(...args) };

async function isUsable(target: string, commitSha: string | null): Promise<boolean> {
  const found = await inspectClone(target);
  // #1322 L5 — healthy at ANOTHER commit is not this graph's source.
  return found.state === "healthy" && (commitSha === null || found.headSha === commitSha);
}

/**
 * Make connector `connectorId`'s clone usable at the commit `loadCommitSha` names
 * (the code graph's), or say why it cannot be. Only for git connectors — the
 * caller filters. Never throws: a failure is an `unavailable` outcome.
 *
 * The commit is read through a callback, and read AGAIN once this holds the
 * connector: an ingest that held it may have moved the graph to a new commit, and
 * restoring the old one over it would be wrong.
 *
 * A connector another job holds (an ingest, another run restoring it) is waited
 * for, up to {@link resolveLeaseWaitMs}, re-checking the clone meanwhile; if the
 * wait runs out the outcome is `busy` — try again — never "re-ingest".
 */
export async function ensureConnectorClone(
  input: { projectId: string; connectorId: string; loadCommitSha: () => Promise<string | null> },
  deps: EnsureCloneDeps = defaultDeps,
): Promise<EnsureCloneOutcome> {
  const target = resolveRepoClonePath(input.connectorId);
  if (await isUsable(target, await input.loadCommitSha())) {
    return { status: "healthy", path: target };
  }

  const waitMs = deps.leaseWaitMs ?? resolveLeaseWaitMs();
  const deadline = Date.now() + waitMs;
  let lease: ConnectorIngestLease | null = null;
  for (;;) {
    lease = tryAcquireConnectorIngest(input.connectorId, "clone-restore");
    if (lease) break;
    if (Date.now() >= deadline) {
      return { status: "unavailable", reason: "busy", state: (await inspectClone(target)).state };
    }
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
  try {
    // Whoever held it may have restored or re-ingested it meanwhile.
    const commitSha = await input.loadCommitSha();
    if (await isUsable(target, commitSha)) return { status: "healthy", path: target };
    const state = (await inspectClone(target)).state;
    if (!commitSha) return { status: "unavailable", reason: "no-recorded-commit", state };
    if (await migrateLegacyClone(input.connectorId, commitSha)) {
      return { status: "migrated", path: target };
    }
    try {
      await deps.restore(input.projectId, input.connectorId, commitSha, SYSTEM_ACTOR_ID);
    } catch (err) {
      log.warn("Could not restore a missing or hollow repository clone", {
        connectorId: input.connectorId,
        state,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "unavailable", reason: "restore-failed", state };
    }
    if (!(await isUsable(target, commitSha))) {
      return { status: "unavailable", reason: "restore-failed", state };
    }
    log.info("Restored a repository clone at its graph's commit", {
      connectorId: input.connectorId,
      state,
      commitSha,
    });
    return { status: "restored", path: target };
  } finally {
    lease.release();
  }
}

/** A real directory (not a symlink) owned by this process's user. */
async function isOwnDirectory(dir: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    const uid = process.getuid?.();
    return uid === undefined || stats.uid === uid;
  } catch {
    return false;
  }
}

/**
 * Move a clone left at the pre-#1322 default (`<tmpdir>/metis-repo-clones/<id>`)
 * into the durable root — only when it is healthy (index-complete), at `commitSha`,
 * and both it and its root are real directories this process owns (the shared
 * temp dir is writable by every local user: no symlink, no one else's tree).
 * A rename where it can; a copy then a delete across filesystems (`EXDEV`).
 */
async function migrateLegacyClone(connectorId: string, commitSha: string): Promise<boolean> {
  const legacyRoot = legacyTmpCloneRoot();
  if (!legacyRoot || path.resolve(legacyRoot) === path.resolve(resolveRepoCloneRoot())) {
    return false;
  }
  const legacy = path.join(legacyRoot, connectorId);
  if (!(await isOwnDirectory(legacyRoot)) || !(await isOwnDirectory(legacy))) return false;
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
  return isUsable(target, commitSha);
}
