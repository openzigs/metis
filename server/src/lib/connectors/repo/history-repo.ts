/**
 * #2338 — the commit-history repository of a git connector
 * (docs/decisions/0023-commit-history-from-a-blobless-history-repository.md).
 *
 * The working-tree clone is depth 1 and stays that way. History lives in a
 * SEPARATE bare, blobless repository per connector
 * (`resolveRepoHistoryPath`), fetched after a code-graph ingest has recorded
 * its commit:
 *
 *   1. the indexed commit is fetched with `--filter=blob:none` into
 *      `refs/metis/indexed`: every ancestor's commits and trees, no file
 *      contents;
 *   2. the blobs of every commit inside the window (the
 *      {@link resolveHistoryWindowDays} days before the indexed commit's
 *      committer date) are prefetched in ONE batched fetch, with those of the
 *      window's boundary parents: a line-range query diffs the oldest change
 *      in the window against its parent, and without the parent's blobs that
 *      change would be lost (measured while building #2338);
 *   3. the repository is measured against {@link resolveRepoHistoryMaxBytes};
 *      over it the repository is deleted and recorded as too large.
 *
 * The outcome is recorded beside it (`resolveRepoHistoryStatePath`) so the
 * chat tool can say WHY history is unavailable, never just return nothing.
 *
 * Git runs with argument arrays and no shell ({@link runGit}); every read
 * passes `--no-lazy-fetch` with `GIT_NO_LAZY_FETCH=1` and no credential in its
 * environment ({@link historyReadEnv}), so a chat call can never reach the
 * network. Global and system git config are ignored on every call.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveRepoCloneRoot,
  resolveRepoHistoryPath,
  resolveRepoHistoryStatePath,
} from "./clone-path.js";

/** The flag that offers `get_change_history` in chat AND makes an ingest fetch history for it. */
export const CHANGE_HISTORY_FLAG = "CHAT_CHANGE_HISTORY_TOOL";
/** The ref the indexed commit is fetched into. */
export const HISTORY_REF = "refs/metis/indexed";
/** ADR 0023's bound: 365 days, by committer date. */
export const DEFAULT_HISTORY_WINDOW_DAYS = 365;
/** A full commit SHA (SHA-1 or SHA-256). */
export const FULL_SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * `REPO_HISTORY_WINDOW_DAYS`: how far before the indexed commit history is
 * prefetched and answered. A blank or invalid value falls back to 365.
 */
export function resolveHistoryWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.REPO_HISTORY_WINDOW_DAYS?.trim() || NaN);
  return Number.isInteger(n) && n > 0 && n <= 36_500 ? n : DEFAULT_HISTORY_WINDOW_DAYS;
}

/**
 * `REPO_HISTORY_MAX_BYTES`: the history repository's own cap. Defaults to
 * twice the clone cap (ADR 0023: history measured at 1.1–1.2× the tree).
 */
export function resolveRepoHistoryMaxBytes(
  cloneMaxBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const n = Number(env.REPO_HISTORY_MAX_BYTES?.trim() || NaN);
  return Number.isInteger(n) && n > 0 ? n : cloneMaxBytes * 2;
}

// ---- running git -----------------------------------------------------------

export interface GitRun {
  /** The exit code; `null` when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the process was stopped early, if it was. */
  stopped: "timeout" | "output-cap" | "caller" | "spawn-error" | null;
}

export interface GitRunOptions {
  env: Record<string, string>;
  timeoutMs: number;
  /** Bytes of stdout kept at most; past it the process is killed (`output-cap`). */
  maxOutputBytes: number;
  /** Written to stdin, then stdin is closed. */
  input?: string;
  /**
   * Called with the stdout read so far after each chunk; returning `true`
   * stops the process (`caller`). Lets a reader stop a walk once it has
   * enough instead of reading the whole history.
   */
  enough?: (stdoutSoFar: string) => boolean;
}

export type GitRunner = (args: readonly string[], opts: GitRunOptions) => Promise<GitRun>;

/** `git <args>`: argument array, no shell, bounded in time and output. */
export const runGit: GitRunner = (args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stopped: GitRun["stopped"] = null;
    let settled = false;
    const child = spawn("git", [...args], {
      env: opts.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stop = (why: NonNullable<GitRun["stopped"]>): void => {
      if (stopped) return;
      stopped = why;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), opts.timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (stopped) return;
      stdout += chunk;
      if (Buffer.byteLength(stdout) > opts.maxOutputBytes) {
        stdout = stdout.slice(0, opts.maxOutputBytes);
        stop("output-cap");
      } else if (opts.enough?.(stdout)) stop("caller");
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, stopped });
    };
    child.on("error", (err) => {
      stopped ??= "spawn-error";
      stderr += err.message;
      finish(null);
    });
    child.on("close", (code) => finish(stopped ? null : code));
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => undefined); // the process may exit before reading it all
      child.stdin!.end(opts.input);
    }
  });

/** Variables a git subprocess needs to run at all (no credential, no proxy). */
function processBasics(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "SYSTEMROOT"]) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Ignore the system and the user's global git config: only the repository's own applies. */
export const ISOLATED_GIT_CONFIG: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_TERMINAL_PROMPT: "0",
});

/**
 * The environment of every READ of a history repository: no credential, no
 * proxy, no global config, and lazy fetching refused twice over (the
 * `--no-lazy-fetch` option is passed as well), so a chat call cannot reach
 * the network.
 */
export function historyReadEnv(): Record<string, string> {
  return {
    ...processBasics(),
    ...ISOLATED_GIT_CONFIG,
    GIT_NO_LAZY_FETCH: "1",
    // A path after `--` is a literal file name, never a glob or `:(magic)` pathspec.
    GIT_LITERAL_PATHSPECS: "1",
  };
}

/** The leading options of every read: the repository, and no network. */
export function historyReadArgs(gitDir: string): string[] {
  return ["--no-lazy-fetch", `--git-dir=${gitDir}`];
}

/** Git's message when an object a read needs is not on disk (ADR 0023, finding 5). */
export function isMissingObjectError(stderr: string): boolean {
  // Git 2.50 on a partial clone with lazy fetching refused says "could not
  // fetch <oid> from promisor remote"; a plain missing object, "unable to read".
  return /fatal: (unable to read|missing (blob|tree|object)|could not fetch \S+ from promisor remote)|could not read|bad object/i.test(
    stderr,
  );
}

// ---- state -----------------------------------------------------------------

export type HistoryState =
  | {
      status: "ready";
      /** The indexed commit the history was fetched at. */
      commitSha: string;
      /** The bound: ISO time `windowDays` before the commit's committer date. */
      windowStart: string;
      windowDays: number;
      fetchedAt: string;
      sizeBytes: number;
    }
  | {
      status: "too_large";
      commitSha: string;
      fetchedAt: string;
      sizeBytes: number;
      maxBytes: number;
    }
  | { status: "failed"; commitSha: string; fetchedAt: string; reason: string };

function isIso(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/** The recorded state of `connectorId`'s history, or `null` when none was ever fetched or it is unreadable. */
export async function readHistoryState(connectorId: string): Promise<HistoryState | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(resolveRepoHistoryStatePath(connectorId), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.commitSha !== "string" || !FULL_SHA_RE.test(s.commitSha) || !isIso(s.fetchedAt)) {
    return null;
  }
  if (s.status === "ready" && isIso(s.windowStart) && typeof s.windowDays === "number") {
    return s as HistoryState;
  }
  if (s.status === "too_large" || s.status === "failed") return s as HistoryState;
  return null;
}

async function writeHistoryState(connectorId: string, state: HistoryState): Promise<void> {
  const file = resolveRepoHistoryStatePath(connectorId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(state)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/**
 * Delete `connectorId`'s history repository and its state record (ADR 0023 /
 * #2389 review: on connector delete, on a URL or provider change, and when the
 * tool is turned off — commit text can carry secrets and personal data).
 */
export async function removeHistoryRepository(connectorId: string): Promise<void> {
  await fs.rm(resolveRepoHistoryPath(connectorId), { recursive: true, force: true });
  await fs.rm(resolveRepoHistoryStatePath(connectorId), { force: true });
}

/** Whether a history repository is on disk for `connectorId` (or a state record of one). */
export async function hasHistoryRepository(connectorId: string): Promise<boolean> {
  for (const p of [resolveRepoHistoryPath(connectorId), resolveRepoHistoryStatePath(connectorId)]) {
    try {
      await fs.access(p);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** Bytes under `dir`, stopping once past `cap`. */
async function treeSize(dir: string, cap: number): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
        if (total > cap) return total;
      }
    }
  }
  return total;
}

// ---- fetching --------------------------------------------------------------

export interface HistoryFetchInput {
  connectorId: string;
  /** The connector's clone URL; never carries a credential (`buildCloneUrl`). */
  remoteUrl: string;
  /** The indexed commit (full SHA). */
  commitSha: string;
  /** The fetch environment: the connector's auth header env, plus {@link ISOLATED_GIT_CONFIG}. */
  env: Record<string, string>;
  windowDays: number;
  maxBytes: number;
  run?: GitRunner;
  now?: () => Date;
  /** Per git call; a fetch of a large repository takes minutes (ADR 0023). */
  timeoutMs?: number;
}

export type HistoryFetchOutcome =
  | { status: "ready"; sizeBytes: number; windowStart: string; prefetchedObjects: number }
  | { status: "too_large"; sizeBytes: number }
  | { status: "failed"; reason: string };

const FETCH_TIMEOUT_MS = 15 * 60_000;
/** Bytes of `rev-list` output kept: about 1.5 million object ids. */
const LIST_MAX_BYTES = 64 * 1024 * 1024;

class HistoryFetchError extends Error {}

/**
 * Fetch (or refresh) `connectorId`'s history repository at `commitSha` and
 * record the outcome. Never throws: a failure removes the repository and is
 * recorded as `failed`, so the tool reads "history not fetched".
 */
export async function fetchHistoryRepository(
  input: HistoryFetchInput,
): Promise<HistoryFetchOutcome> {
  const run = input.run ?? runGit;
  const now = input.now ?? (() => new Date());
  const dir = resolveRepoHistoryPath(input.connectorId);
  const timeoutMs = input.timeoutMs ?? FETCH_TIMEOUT_MS;
  const fetchedAt = now().toISOString();
  const env = { ...input.env, ...ISOLATED_GIT_CONFIG };
  const git = async (args: string[], extra: Partial<GitRunOptions> = {}): Promise<string> => {
    const r = await run([`--git-dir=${dir}`, ...args], {
      env,
      timeoutMs,
      maxOutputBytes: LIST_MAX_BYTES,
      ...extra,
    });
    if (r.code !== 0) {
      const sub = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";
      throw new HistoryFetchError(
        `git ${sub} ${r.stopped ? `stopped (${r.stopped})` : `exited ${r.code}`}`,
      );
    }
    return r.stdout;
  };
  const readGit = (args: string[], extra: Partial<GitRunOptions> = {}): Promise<string> =>
    git(["--no-lazy-fetch", ...args], { env: { ...env, GIT_NO_LAZY_FETCH: "1" }, ...extra });
  try {
    if (!FULL_SHA_RE.test(input.commitSha)) throw new HistoryFetchError("not a full commit SHA");
    await fs.mkdir(resolveRepoCloneRoot(), { recursive: true });
    await ensureBareRepository(dir, run, env, timeoutMs);
    await git(["config", "remote.origin.url", input.remoteUrl]);
    // 1. The indexed commit with every ancestor's commits and trees; no blobs.
    await git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--recurse-submodules=no",
      "--filter=blob:none",
      "origin",
      `+${input.commitSha}:${HISTORY_REF}`,
    ]);
    // A shallow history would report its boundary as adding every file (ADR 0023, finding 1).
    if ((await readGit(["rev-parse", "--is-shallow-repository"])).trim() !== "false") {
      throw new HistoryFetchError("history repository is shallow");
    }
    const committed = Number(
      (await readGit(["log", "-1", "--format=%ct", input.commitSha])).trim(),
    );
    if (!Number.isFinite(committed)) throw new HistoryFetchError("unreadable commit date");
    const windowStart = new Date((committed - input.windowDays * 86_400) * 1000).toISOString();
    const since = `--since-as-filter=${windowStart}`;
    // 2. The blobs the window's commits, and their parents outside it, need.
    const missing = new Set<string>();
    const collect = (out: string): void => {
      for (const line of out.split("\n")) {
        if (line.startsWith("?") && FULL_SHA_RE.test(line.slice(1).trim())) {
          missing.add(line.slice(1).trim());
        }
      }
    };
    collect(await readGit(["rev-list", "--objects", "--missing=print", since, input.commitSha]));
    const inWindow = new Set<string>();
    const parents = new Set<string>();
    for (const line of (await readGit(["rev-list", "--parents", since, input.commitSha])).split(
      "\n",
    )) {
      const [c, ...ps] = line.trim().split(" ");
      if (!c) continue;
      inWindow.add(c);
      for (const p of ps) parents.add(p);
    }
    const boundary = [...parents].filter((p) => !inWindow.has(p) && FULL_SHA_RE.test(p));
    if (boundary.length > 0) {
      collect(
        await readGit(["rev-list", "--objects", "--missing=print", "--no-walk", "--stdin"], {
          input: `${boundary.join("\n")}\n`,
        }),
      );
    }
    if (missing.size > 0) {
      // As git's own lazy fetch does (promisor-remote.c): with the default
      // negotiation the client advertises the commits it has, and GitHub then
      // treats every blob reachable from them as already present and sends
      // none ("did not send all necessary objects", measured on miniflux/v2).
      await git(
        [
          "-c",
          "fetch.negotiationAlgorithm=noop",
          "fetch",
          "--quiet",
          "--no-tags",
          "--no-write-fetch-head",
          "--recurse-submodules=no",
          "--filter=blob:none",
          "--stdin",
          "origin",
        ],
        { input: `${[...missing].join("\n")}\n` },
      );
    }
    // 3. Its own cap: over it, the history goes and the connector reads "too large".
    const sizeBytes = await treeSize(dir, input.maxBytes);
    if (sizeBytes > input.maxBytes) {
      await fs.rm(dir, { recursive: true, force: true });
      await writeHistoryState(input.connectorId, {
        status: "too_large",
        commitSha: input.commitSha,
        fetchedAt,
        sizeBytes,
        maxBytes: input.maxBytes,
      });
      return { status: "too_large", sizeBytes };
    }
    await writeHistoryState(input.connectorId, {
      status: "ready",
      commitSha: input.commitSha,
      windowStart,
      windowDays: input.windowDays,
      fetchedAt,
      sizeBytes,
    });
    return { status: "ready", sizeBytes, windowStart, prefetchedObjects: missing.size };
  } catch (err) {
    // Git's own stderr can name the remote; the reason recorded is ours only.
    const reason = err instanceof HistoryFetchError ? err.message : "history fetch failed";
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await writeHistoryState(input.connectorId, {
      status: "failed",
      commitSha: FULL_SHA_RE.test(input.commitSha) ? input.commitSha : "0".repeat(40),
      fetchedAt,
      reason,
    }).catch(() => undefined);
    return { status: "failed", reason };
  }
}

/**
 * A bare partial-clone repository at `dir`: reused when it is one, otherwise
 * (absent, not a repository, or shallow) created afresh.
 */
async function ensureBareRepository(
  dir: string,
  run: GitRunner,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<void> {
  const usable =
    (await fs.access(path.join(dir, "HEAD")).then(
      () => true,
      () => false,
    )) &&
    !(await fs.access(path.join(dir, "shallow")).then(
      () => true,
      () => false,
    ));
  if (usable) return;
  await fs.rm(dir, { recursive: true, force: true });
  const opts: GitRunOptions = { env, timeoutMs, maxOutputBytes: 64 * 1024 };
  const steps: string[][] = [
    ["init", "--bare", "--quiet", dir],
    [`--git-dir=${dir}`, "config", "core.repositoryformatversion", "1"],
    [`--git-dir=${dir}`, "config", "extensions.partialClone", "origin"],
    [`--git-dir=${dir}`, "config", "remote.origin.promisor", "true"],
    [`--git-dir=${dir}`, "config", "remote.origin.partialclonefilter", "blob:none"],
    // The history is read with git log only; never let a gc prune the prefetched blobs.
    [`--git-dir=${dir}`, "config", "gc.auto", "0"],
  ];
  for (const args of steps) {
    const r = await run(args, opts);
    if (r.code !== 0) throw new HistoryFetchError("could not create the history repository");
  }
}
