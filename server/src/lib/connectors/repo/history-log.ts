/**
 * #2338 — read the commits that touched a file or a line range from a
 * connector's history repository (`history-repo.ts`), locally and bounded.
 *
 * One `git log` walk, newest first, through the same argument array every
 * time (no shell):
 *
 *   - a FILE query follows renames (`--follow`) and puts the path after `--`;
 *   - a LINE-RANGE query passes `-L<a>,<b>:<path>` as one argument and no `--`
 *     (git rejects a pathspec beside `-L`; #2389 review, point 2).
 *
 * The window is applied to each commit's COMMITTER date as a filter, never as
 * a stop: `--since` (and `rev-list --since`) stops at the first older commit,
 * and committer dates are not monotonic (ADR 0023, finding 4), so in-window
 * commits behind an older one would be dropped silently. Reading the dates in
 * the walk itself (rather than passing `--since-as-filter`, which filters the
 * same way) is what lets the result say whether the walk went PAST the window:
 *
 *   - `cap`: more in-window commits exist than were asked for;
 *   - `bound`: the walk met a commit older than the window, or stopped on an
 *     object that is not on disk (blobs are prefetched for the window only,
 *     ADR 0023 finding 5): history before the window exists or may exist;
 *   - `none`: the walk ended inside the window, so the whole history of the
 *     path (or range) is in the result.
 *
 * A FILE query is bounded by the window's cut commits when the fetch could
 * compute them (`HistoryState.cuts`: commits outside the window with nothing
 * in the window behind them). The walk excludes them (`^cut` on stdin), so it
 * never walks to the root (#2484 review) and still loses no in-window commit,
 * skewed dates or not. It then cannot see an older commit, so `none` is
 * decided by a second bounded walk instead: the file's oldest commit in the
 * window must be the one that ADDED it (`--diff-filter=A`), else `bound`.
 * Without cuts (skewed dates) the walk is unbounded, as before.
 */
import {
  FULL_SHA_RE,
  historyReadArgs,
  historyReadEnv,
  isMissingObjectError,
  runGit,
  type GitRunner,
} from "./history-repo.js";

export interface HistoryCommit {
  sha: string;
  parents: string[];
  /** Committer date, ISO. */
  committedAt: string;
  authorName: string;
  subject: string;
  body: string;
}

export interface HistoryQuery {
  gitDir: string;
  /** The indexed commit the walk starts from. */
  commitSha: string;
  /** Repository-relative path, already validated. */
  path: string;
  lines?: { start: number; end: number };
  /** The window's start (ISO): commits committed before it are outside. */
  windowStart: string;
  /** In-window commits to pass over first (the cursor). */
  skip: number;
  /** In-window commits returned at most. */
  cap: number;
  /** The window's cut commits (`HistoryState.cuts`); `null`/absent: walk the whole history. */
  cuts?: readonly string[] | null;
  run?: GitRunner;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type HistoryLogResult =
  | {
      ok: true;
      commits: HistoryCommit[];
      more: "cap" | "bound" | "none";
      /** With `bound`: the oldest in-window commit date the walk reached (null: none). */
      reached: string | null;
      /** With `cap`: the walk stopped on its output limit, so no cursor can go further. */
      outputLimited?: true;
    }
  | { ok: false; reason: "timeout" | "line-range" | "failed" };

const FIELD = "\u001f";
/** Hash, parents, committer time, author name, subject, body. No e-mail is ever requested. */
const FORMAT = "%H%x1f%P%x1f%ct%x1f%an%x1f%s%x1f%b";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The `git` arguments of a query; exported so tests can pin the argument array. */
export function historyLogArgs(
  q: Pick<HistoryQuery, "gitDir" | "commitSha" | "path" | "lines" | "cuts">,
): string[] {
  const head = [
    ...historyReadArgs(q.gitDir),
    "log",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "-z",
    `--format=${FORMAT}`,
  ];
  if (q.lines) {
    return [...head, "--no-patch", `-L${q.lines.start},${q.lines.end}:${q.path}`, q.commitSha];
  }
  // The cuts, when any, arrive on stdin as `^<sha>` ({@link cutInput}).
  const stdin = q.cuts && q.cuts.length > 0 ? ["--stdin"] : [];
  return [...head, "--follow", ...stdin, q.commitSha, "--", q.path];
}

/** The `^<cut>` lines a bounded file query reads on stdin; `undefined` when it has none. */
function cutInput(q: Pick<HistoryQuery, "lines" | "cuts">): string | undefined {
  if (q.lines || !q.cuts || q.cuts.length === 0) return undefined;
  return q.cuts
    .filter((c) => FULL_SHA_RE.test(c))
    .map((c) => `^${c}\n`)
    .join("");
}

/** One `-z` record, or `null` when it is not a well-formed commit. */
export function parseHistoryRecord(record: string): HistoryCommit | null {
  const r = record.replace(/^\n+/, "");
  const parts = r.split(FIELD);
  if (parts.length < 6) return null;
  const [sha, parents, ct, authorName, subject] = parts as [string, string, string, string, string];
  const body = parts.slice(5).join(FIELD);
  const time = Number(ct);
  if (!FULL_SHA_RE.test(sha) || !Number.isInteger(time)) return null;
  const parentList = parents.trim() === "" ? [] : parents.trim().split(" ");
  if (parentList.some((p) => !FULL_SHA_RE.test(p))) return null;
  return {
    sha,
    parents: parentList,
    committedAt: new Date(time * 1000).toISOString(),
    authorName,
    subject,
    body: body.trim(),
  };
}

/** Run one history query. Never throws. */
export async function readHistoryLog(q: HistoryQuery): Promise<HistoryLogResult> {
  const run = q.run ?? runGit;
  const bound = Date.parse(q.windowStart);
  const want = q.skip + q.cap + 1;
  const inWindow: HistoryCommit[] = [];
  let sawOlder = false;
  let consumed = 0;
  const take = (text: string, final: boolean): void => {
    let end = text.indexOf("\0", consumed);
    while (end >= 0 || (final && consumed < text.length)) {
      const record = end >= 0 ? text.slice(consumed, end) : text.slice(consumed);
      consumed = end >= 0 ? end + 1 : text.length;
      const c = parseHistoryRecord(record);
      if (c && inWindow.length < want) {
        if (Date.parse(c.committedAt) >= bound) inWindow.push(c);
        else sawOlder = true;
      }
      end = text.indexOf("\0", consumed);
    }
  };
  const input = cutInput(q);
  const timeoutMs = q.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await run(historyLogArgs(q), {
    env: historyReadEnv(),
    timeoutMs,
    maxOutputBytes: q.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    ...(input !== undefined ? { input } : {}),
    enough: (out) => {
      take(out, false);
      return inWindow.length >= want;
    },
  });
  take(result.stdout, result.code === 0);
  const page = inWindow.slice(q.skip, q.skip + q.cap);
  const reached = inWindow.at(-1)?.committedAt ?? null;
  if (inWindow.length >= want) return { ok: true, commits: page, more: "cap", reached };
  if (result.stopped === "timeout") return { ok: false, reason: "timeout" };
  if (result.stopped === "output-cap") {
    // Stopped mid-walk on output, not on the window: more in-window commits
    // may exist, but no cursor can reach them — a later call re-reads the same
    // output and stops at the same byte (#2484 panel). So `cap`, flagged as
    // the output's limit, and the tool offers no cursor. Only a walk already
    // past the window with nothing to show is `bound`; one that showed nothing
    // yet failed.
    if (page.length > 0) {
      return { ok: true, commits: page, more: "cap", reached, outputLimited: true };
    }
    if (sawOlder) return { ok: true, commits: page, more: "bound", reached };
    return { ok: false, reason: "failed" };
  }
  if (result.code !== 0) {
    if (isMissingObjectError(result.stderr)) {
      return { ok: true, commits: page, more: "bound", reached };
    }
    // `-L` past the end of the file, or a range git cannot place.
    if (q.lines && /has only \d+ lines?|invalid -L|-L argument/i.test(result.stderr)) {
      return { ok: false, reason: "line-range" };
    }
    return { ok: false, reason: "failed" };
  }
  if (sawOlder) return { ok: true, commits: page, more: "bound", reached };
  if (input === undefined) return { ok: true, commits: page, more: "none", reached };
  // Bounded by the cuts, the walk cannot see an older commit: the history is
  // whole only if the oldest commit it found is the one that added the file.
  const oldest = inWindow.at(-1);
  if (!oldest) return { ok: true, commits: page, more: "bound", reached };
  const added = await run(
    [
      ...historyReadArgs(q.gitDir),
      "log",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--follow",
      "--diff-filter=A",
      "-n1",
      "--format=%H",
      "--stdin",
      q.commitSha,
      "--",
      q.path,
    ],
    { env: historyReadEnv(), timeoutMs, maxOutputBytes: 1024, input },
  );
  const createdHere = added.code === 0 && added.stdout.trim() === oldest.sha;
  return { ok: true, commits: page, more: createdHere ? "none" : "bound", reached };
}
