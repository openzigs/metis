/**
 * #2338 — the history repository and its reads, against REAL git and a local
 * `file://` upstream (ADR 0023). The upstream's history, by committer date,
 * with a 365-day window ending at the tip (2026-10-01, so the window starts
 * 2025-10-01):
 *
 *   2020-01-01  add f.txt (a b c d e)                      outside
 *   2021-01-01  f.txt line 2 b → B1                        outside
 *   2026-06-01  f.txt line 4 d → D1                        inside (its parent's blob is outside)
 *   2026-07-01  f.txt line 2 B1 → B2                       inside
 *   2026-08-01  add g.txt                                  inside
 *   2026-08-15  add n.txt                                  inside
 *   2019-03-01  n.txt changed (committer date out of order) outside, but a child of the line above
 *   2026-09-01  rename f.txt → h.txt                       inside
 *   2026-10-01  h.txt line 5 e → E1 (tip)                  inside
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRepoHistoryPath, resolveRepoHistoryStatePath } from "./clone-path.js";
import {
  fetchHistoryRepository,
  hasHistoryRepository,
  historyReadEnv,
  isMissingObjectError,
  readHistoryState,
  removeHistoryRepository,
  resolveHistoryWindowDays,
  resolveRepoHistoryMaxBytes,
  runGit,
  type GitRunner,
} from "./history-repo.js";
import { historyLogArgs, parseHistoryRecord, readHistoryLog } from "./history-log.js";
import { createChangeHistoryTool } from "../../analysis/tools/change-history.js";
import { codeVersionIndexOf } from "../../code-graph/code-version.js";

let base: string;
let upstream: string;
let tip: string;
const shas: Record<string, string> = {};
const originalCloneDir = process.env.REPO_CLONE_DIR;

function commit(msg: string, date: string, author = "Ann Author"): string {
  execFileSync(
    "git",
    ["-c", `user.name=${author}`, "-c", "user.email=ann@example.com", "commit", "-qam", msg],
    {
      cwd: upstream,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim();
}
const add = (): void => {
  execFileSync("git", ["add", "-A"], { cwd: upstream });
};
const write = (name: string, body: string): void => writeFileSync(path.join(upstream, name), body);

const fetchInput = (
  connectorId: string,
  extra: Partial<Parameters<typeof fetchHistoryRepository>[0]> = {},
) => ({
  connectorId,
  remoteUrl: `file://${upstream}`,
  commitSha: tip,
  env: { PATH: process.env.PATH ?? "" },
  windowDays: 365,
  maxBytes: 50 * 1024 * 1024,
  ...extra,
});

beforeAll(async () => {
  base = mkdtempSync(path.join(os.tmpdir(), "metis-2338-"));
  process.env.REPO_CLONE_DIR = path.join(base, "clones");
  upstream = path.join(base, "upstream");
  execFileSync("git", ["init", "-q", "-b", "main", upstream]);
  execFileSync("git", ["config", "uploadpack.allowFilter", "true"], { cwd: upstream });
  execFileSync("git", ["config", "uploadpack.allowAnySHA1InWant", "true"], { cwd: upstream });
  write("f.txt", "a\nb\nc\nd\ne\n");
  add();
  shas.oldAdd = commit("old add", "2020-01-01T00:00:00Z");
  write("f.txt", "a\nB1\nc\nd\ne\n");
  shas.oldB = commit("old change b", "2021-01-01T00:00:00Z");
  write("f.txt", "a\nB1\nc\nD1\ne\n");
  shas.newD = commit("new change d", "2026-06-01T00:00:00Z");
  write("f.txt", "a\nB2\nc\nD1\ne\n");
  shas.newB = commit(
    "new change b\n\nWhy: B1 was wrong. token ghp_0123456789abcdefghijABCDEFGHIJ012345 leaked.\nContact bob@example.com.\n\nSigned-off-by: Bob <bob@example.com>",
    "2026-07-01T00:00:00Z",
  );
  write("g.txt", "z\n");
  add();
  shas.addG = commit("add g", "2026-08-01T00:00:00Z");
  write("n.txt", "1\n");
  add();
  shas.addN = commit("add n", "2026-08-15T00:00:00Z");
  write("n.txt", "2\n");
  shas.skewN = commit("skewed n", "2019-03-01T00:00:00Z");
  renameSync(path.join(upstream, "f.txt"), path.join(upstream, "h.txt"));
  add();
  shas.rename = commit("rename f to h", "2026-09-01T00:00:00Z");
  write("h.txt", "a\nB2\nc\nD1\nE1\n");
  shas.newE = commit("change e in h", "2026-10-01T00:00:00Z");
  tip = shas.newE;
}, 60_000);

afterAll(() => {
  if (originalCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
  else process.env.REPO_CLONE_DIR = originalCloneDir;
  rmSync(base, { recursive: true, force: true });
});

describe("configuration", () => {
  it("reads REPO_HISTORY_WINDOW_DAYS, falling back to 365", () => {
    expect(resolveHistoryWindowDays({})).toBe(365);
    expect(resolveHistoryWindowDays({ REPO_HISTORY_WINDOW_DAYS: "90" })).toBe(90);
    for (const bad of ["", "0", "-1", "1.5", "abc", "99999999"]) {
      expect(resolveHistoryWindowDays({ REPO_HISTORY_WINDOW_DAYS: bad })).toBe(365);
    }
  });

  it("reads REPO_HISTORY_MAX_BYTES, defaulting to twice the clone cap", () => {
    expect(resolveRepoHistoryMaxBytes(100, {})).toBe(200);
    expect(resolveRepoHistoryMaxBytes(100, { REPO_HISTORY_MAX_BYTES: "5000" })).toBe(5000);
    expect(resolveRepoHistoryMaxBytes(100, { REPO_HISTORY_MAX_BYTES: "lots" })).toBe(200);
  });

  it("reads with no credential, no global config, no lazy fetch and literal pathspecs", () => {
    const env = historyReadEnv();
    expect(env).toMatchObject({
      GIT_NO_LAZY_FETCH: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(Object.keys(env).filter((k) => /CONFIG_(COUNT|KEY|VALUE)|PROXY|HOME/i.test(k))).toEqual(
      [],
    );
  });
});

describe("fetchHistoryRepository", () => {
  it("fetches a bare, blobless, non-shallow repository at the commit and records the window", async () => {
    const out = await fetchHistoryRepository(fetchInput("c-ready"));
    expect(out).toMatchObject({ status: "ready", windowStart: "2025-10-01T00:00:00.000Z" });
    const dir = resolveRepoHistoryPath("c-ready");
    expect(
      execFileSync("git", [`--git-dir=${dir}`, "rev-parse", "--is-bare-repository"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("true");
    expect(
      execFileSync("git", [`--git-dir=${dir}`, "rev-parse", "--is-shallow-repository"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("false");
    // Blobs outside the window were never fetched: the root commit's file is missing.
    const r = await runGit(
      ["--no-lazy-fetch", `--git-dir=${dir}`, "cat-file", "-p", `${shas.oldAdd}:f.txt`],
      { env: historyReadEnv(), timeoutMs: 10_000, maxOutputBytes: 1024 },
    );
    expect(r.code).not.toBe(0);
    expect(await readHistoryState("c-ready")).toMatchObject({
      status: "ready",
      commitSha: tip,
      windowStart: "2025-10-01T00:00:00.000Z",
      windowDays: 365,
    });
  });

  it("prefetches the window's blobs in one batch with no-op negotiation, as git's lazy fetch does", async () => {
    const calls: string[][] = [];
    const run: GitRunner = async (args, opts) => {
      calls.push([...args]);
      return runGit(args, opts);
    };
    expect((await fetchHistoryRepository(fetchInput("c-batch", { run }))).status).toBe("ready");
    const fetches = calls.filter((a) => a.includes("fetch"));
    expect(fetches).toHaveLength(2);
    // Without it GitHub sends none of the blobs (they are reachable from commits the client has).
    expect(fetches[1]).toEqual(
      expect.arrayContaining([
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "--stdin",
        "--filter=blob:none",
      ]),
    );
    // Every call names the repository; none carries a credential or a shell.
    for (const a of calls.slice(1)) expect(a.some((x) => x.startsWith("--git-dir="))).toBe(true);
  });

  it("is refreshed in place: a second fetch reuses the repository", async () => {
    expect((await fetchHistoryRepository(fetchInput("c-ready"))).status).toBe("ready");
  });

  it("is deleted and recorded as too large past its cap", async () => {
    const out = await fetchHistoryRepository(fetchInput("c-big", { maxBytes: 1000 }));
    expect(out.status).toBe("too_large");
    expect(await hasHistoryRepository("c-big")).toBe(true); // the state record
    await expect(fs.access(resolveRepoHistoryPath("c-big"))).rejects.toThrow();
    expect(await readHistoryState("c-big")).toMatchObject({ status: "too_large", maxBytes: 1000 });
  });

  it("records a failure (and keeps nothing) for a commit the remote does not have", async () => {
    const out = await fetchHistoryRepository(fetchInput("c-fail", { commitSha: "a".repeat(40) }));
    expect(out).toEqual({ status: "failed", reason: "git fetch exited 128" });
    await expect(fs.access(resolveRepoHistoryPath("c-fail"))).rejects.toThrow();
    expect((await readHistoryState("c-fail"))?.status).toBe("failed");
  });

  it("refuses a commit that is not a full SHA before running git", async () => {
    let ran = 0;
    const run: GitRunner = async (args, opts) => {
      ran++;
      return runGit(args, opts);
    };
    const out = await fetchHistoryRepository(fetchInput("c-bad", { commitSha: "HEAD", run }));
    expect(out).toEqual({ status: "failed", reason: "not a full commit SHA" });
    expect(ran).toBe(0);
  });

  it("replaces a shallow repository rather than reading one", async () => {
    const dir = resolveRepoHistoryPath("c-shallow");
    await fs.mkdir(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", dir]);
    await fs.writeFile(path.join(dir, "shallow"), `${tip}\n`);
    expect((await fetchHistoryRepository(fetchInput("c-shallow"))).status).toBe("ready");
    await expect(fs.access(path.join(dir, "shallow"))).rejects.toThrow();
  });

  it("removeHistoryRepository deletes the repository and its state record", async () => {
    await fetchHistoryRepository(fetchInput("c-gone"));
    expect(await hasHistoryRepository("c-gone")).toBe(true);
    await removeHistoryRepository("c-gone");
    expect(await hasHistoryRepository("c-gone")).toBe(false);
    await expect(fs.access(resolveRepoHistoryStatePath("c-gone"))).rejects.toThrow();
  });

  it("stops a download once the repository passes its cap, before the fetch ends (#2484 review, A04)", async () => {
    // A fetch that keeps writing until something stops it: without the
    // watchdog it would run to its timeout and fill the volume.
    const started = Date.now();
    const run: GitRunner = async (args, opts) => {
      if (!args.includes("fetch")) return runGit(args, opts);
      const dir = resolveRepoHistoryPath("c-watch");
      await fs.mkdir(path.join(dir, "objects", "pack"), { recursive: true });
      await fs.writeFile(path.join(dir, "objects", "pack", "tmp_pack_x"), Buffer.alloc(4096));
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10_000);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      return {
        code: opts.signal?.aborted ? null : 0,
        stdout: "",
        stderr: "",
        stopped: opts.signal?.aborted ? "aborted" : null,
      };
    };
    const out = await fetchHistoryRepository(
      fetchInput("c-watch", { run, maxBytes: 1000, sizePollMs: 10 }),
    );
    expect(out.status).toBe("too_large");
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(fs.access(resolveRepoHistoryPath("c-watch"))).rejects.toThrow();
    expect(await readHistoryState("c-watch")).toMatchObject({
      status: "too_large",
      maxBytes: 1000,
      windowDays: 365,
    });
  });

  it("fetches nothing when the volume has no room for the cap", async () => {
    const calls: string[][] = [];
    const run: GitRunner = async (args, opts) => {
      calls.push([...args]);
      return runGit(args, opts);
    };
    const out = await fetchHistoryRepository(
      fetchInput("c-full", { run, freeBytes: async () => 10 }),
    );
    expect(out).toEqual({
      status: "failed",
      reason: "not enough free disk space for the history size cap",
    });
    expect(calls.filter((a) => a.includes("fetch"))).toHaveLength(0);
  });

  it("stops at the ingest's cancellation", async () => {
    const gone = new AbortController();
    gone.abort();
    expect(await fetchHistoryRepository(fetchInput("c-abort", { signal: gone.signal }))).toEqual({
      status: "failed",
      reason: "aborted",
    });
    const live = new AbortController();
    const run: GitRunner = async (args, opts) => {
      if (args.includes("fetch")) live.abort();
      return runGit(args, opts);
    };
    expect(
      await fetchHistoryRepository(fetchInput("c-abort2", { run, signal: live.signal })),
    ).toEqual({ status: "failed", reason: "aborted" });
  });

  it("records no cuts when committer dates are skewed, and the window's cuts when they are not", async () => {
    // The fixture's 2019-dated child of an in-window commit: nothing is safe to cut.
    expect(await readHistoryState("c-ready")).toMatchObject({ cuts: null });
    const out = await fetchHistoryRepository(fetchInput("c-cut", { commitSha: shas.addG! }));
    expect(out.status).toBe("ready");
    // At `add g` the window starts 2025-08-01: its one boundary parent is `old change b`.
    expect(await readHistoryState("c-cut")).toMatchObject({ cuts: [shas.oldB] });
  });

  it("reads no state from a missing or malformed record", async () => {
    expect(await readHistoryState("never")).toBeNull();
    await fs.writeFile(resolveRepoHistoryStatePath("c-junk"), '{"status":"ready","commitSha":"x"}');
    expect(await readHistoryState("c-junk")).toBeNull();
    await fs.writeFile(resolveRepoHistoryStatePath("c-junk"), "not json");
    expect(await readHistoryState("c-junk")).toBeNull();
  });
});

describe("readHistoryLog (offline, against the fetched repository)", () => {
  const dir = () => resolveRepoHistoryPath("c-ready");
  const q = (p: string, extra: Partial<Parameters<typeof readHistoryLog>[0]> = {}) =>
    readHistoryLog({
      gitDir: dir(),
      commitSha: tip,
      path: p,
      windowStart: "2025-10-01T00:00:00.000Z",
      skip: 0,
      cap: 20,
      ...extra,
    });
  const subjects = (r: Awaited<ReturnType<typeof readHistoryLog>>): string[] =>
    r.ok ? r.commits.map((c) => c.subject) : [`error:${r.reason}`];

  it("follows a file through its rename, keeps the window, and says older history exists", async () => {
    const r = await q("h.txt");
    expect(subjects(r)).toEqual(["change e in h", "rename f to h", "new change b", "new change d"]);
    expect(r).toMatchObject({ more: "bound" });
  });

  it("says `none` for a file added inside the window", async () => {
    const r = await q("g.txt");
    expect(subjects(r)).toEqual(["add g"]);
    expect(r).toMatchObject({ more: "none" });
  });

  it("filters by committer date without stopping: an in-window commit behind an older-dated one is kept", async () => {
    const r = await q("n.txt");
    expect(subjects(r)).toEqual(["add n"]);
    // The out-of-order commit is outside the window, so history beyond it is not shown.
    expect(r).toMatchObject({ more: "bound" });
  });

  it("pages with a cap and a cursor", async () => {
    const first = await q("h.txt", { cap: 2 });
    expect(subjects(first)).toEqual(["change e in h", "rename f to h"]);
    expect(first).toMatchObject({ more: "cap" });
    const second = await q("h.txt", { cap: 2, skip: 2 });
    expect(subjects(second)).toEqual(["new change b", "new change d"]);
    expect(second).toMatchObject({ more: "bound" });
  });

  it("finds the OLDEST in-window change to a line range (its parent's blobs were prefetched)", async () => {
    const r = await q("h.txt", { lines: { start: 4, end: 4 } });
    expect(subjects(r)).toEqual(["new change d"]);
    expect(r).toMatchObject({ more: "bound" });
  });

  it("reads a line range locally and stops at the window with `bound`", async () => {
    expect(subjects(await q("h.txt", { lines: { start: 2, end: 2 } }))).toEqual(["new change b"]);
    expect(subjects(await q("h.txt", { lines: { start: 5, end: 5 } }))).toEqual(["change e in h"]);
    expect(subjects(await q("h.txt", { lines: { start: 1, end: 5 } }))).toEqual([
      "change e in h",
      "new change b",
      "new change d",
    ]);
  });

  it("says `none` for a line range whose whole history is inside the window", async () => {
    const r = await q("g.txt", { lines: { start: 1, end: 1 } });
    expect(subjects(r)).toEqual(["add g"]);
    expect(r).toMatchObject({ more: "none" });
  });

  it("reports a range past the end of the file as a bad range", async () => {
    expect(await q("g.txt", { lines: { start: 40, end: 50 } })).toEqual({
      ok: false,
      reason: "line-range",
    });
  });

  it("never requests an e-mail and keeps the -L path in one argument with no `--`", () => {
    const file = historyLogArgs({ gitDir: "/h", commitSha: tip, path: "a b.txt" });
    expect(file.slice(-3)).toEqual([tip, "--", "a b.txt"]);
    expect(file).toContain("--follow");
    const range = historyLogArgs({
      gitDir: "/h",
      commitSha: tip,
      path: "a:b.txt",
      lines: { start: 3, end: 9 },
    });
    expect(range).not.toContain("--");
    expect(range.slice(-2)).toEqual(["-L3,9:a:b.txt", tip]);
    expect(range.join(" ")).not.toMatch(/%a[eE]|%c[eE]/);
    expect(range.slice(0, 2)).toEqual(["--no-lazy-fetch", "--git-dir=/h"]);
  });

  it("returns a timeout and an unexpected failure as errors, never as an empty history", async () => {
    const stub =
      (r: Partial<Awaited<ReturnType<GitRunner>>>): GitRunner =>
      async () => ({ code: 1, stdout: "", stderr: "", stopped: null, ...r });
    expect(await q("h.txt", { run: stub({ code: null, stopped: "timeout" }) })).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(await q("h.txt", { run: stub({ code: 128, stderr: "fatal: bad revision" }) })).toEqual({
      ok: false,
      reason: "failed",
    });
    // An output cap with nothing parsed says nothing about the history.
    expect(await q("h.txt", { run: stub({ code: null, stopped: "output-cap" }) })).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("reports an output cap hit inside the window as a page with a cursor, not as `bound`", async () => {
    const rec = (sha: string, subject: string): string =>
      [sha, "", "1790000000", "Ann", subject, ""].join("\u001f");
    const stdout = `${rec("e".repeat(40), "one")}\0${rec("f".repeat(40), "two")}\0`;
    const run: GitRunner = async () => ({ code: null, stdout, stderr: "", stopped: "output-cap" });
    const r = await q("h.txt", { run });
    expect(subjects(r)).toEqual(["one", "two"]);
    expect(r).toMatchObject({ more: "cap", outputLimited: true });
  });
});

describe("readHistoryLog bounded by the window's cuts (#2484 review)", () => {
  // Fetched at `add g`: window from 2025-08-01, one cut (`old change b`).
  const cutQuery = async (p: string, run: GitRunner) => {
    const state = await readHistoryState("c-cut");
    if (state?.status !== "ready") throw new Error("c-cut not fetched");
    return readHistoryLog({
      gitDir: resolveRepoHistoryPath("c-cut"),
      commitSha: shas.addG!,
      path: p,
      windowStart: state.windowStart,
      skip: 0,
      cap: 20,
      cuts: state.cuts ?? null,
      run,
    });
  };
  const spy = () => {
    const outputs: string[] = [];
    const run: GitRunner = async (args, opts) => {
      const r = await runGit(args, opts);
      outputs.push(r.stdout);
      return r;
    };
    return { run, outputs };
  };

  it("never walks past the window for a file that is older than it, and says `bound`", async () => {
    const { run, outputs } = spy();
    const r = await cutQuery("f.txt", run);
    expect(r.ok && r.commits.map((c) => c.subject)).toEqual(["new change b", "new change d"]);
    expect(r).toMatchObject({ more: "bound" });
    // Neither pre-window commit was ever printed: the walk stopped at the cut.
    expect(outputs.join("")).not.toMatch(/old change b|old add/);
  });

  it("still says `none` for a file the window added", async () => {
    const { run } = spy();
    const r = await cutQuery("g.txt", run);
    expect(r.ok && r.commits.map((c) => c.subject)).toEqual(["add g"]);
    expect(r).toMatchObject({ more: "none" });
  });

  it("passes the cuts on stdin, never as arguments", () => {
    const args = historyLogArgs({
      gitDir: "/h",
      commitSha: tip,
      path: "f.txt",
      cuts: [shas.oldB!],
    });
    expect(args).toContain("--stdin");
    expect(args.join(" ")).not.toContain(shas.oldB!);
    // A line-range query is bounded by the missing blobs instead.
    expect(
      historyLogArgs({
        gitDir: "/h",
        commitSha: tip,
        path: "f.txt",
        lines: { start: 1, end: 2 },
        cuts: [shas.oldB!],
      }),
    ).not.toContain("--stdin");
  });
});

describe("runGit", () => {
  it("caps output in BYTES, never splitting the count by UTF-16 units", async () => {
    const cfg = path.join(base, "multibyte.cfg");
    writeFileSync(cfg, `[a]\n\tb = ${"é".repeat(50)}\n`);
    const r = await runGit(["config", "--file", cfg, "--get", "a.b"], {
      env: historyReadEnv(),
      timeoutMs: 10_000,
      maxOutputBytes: 9,
    });
    expect(r.stopped).toBe("output-cap");
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(9);
    expect(r.stdout.startsWith("éééé")).toBe(true);
  });

  it("kills the process when its signal aborts", async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    const r = await runGit(["-c", "alias.wait=!sleep 5", "wait"], {
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
      signal: ac.signal,
    });
    expect(r.stopped).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("parsing", () => {
  it("drops a malformed record and keeps a well-formed one", () => {
    const sha = "b".repeat(40);
    expect(parseHistoryRecord("junk")).toBeNull();
    expect(parseHistoryRecord(`${"z".repeat(40)}\u001f\u001f1\u001fA\u001fs\u001f`)).toBeNull();
    expect(parseHistoryRecord(`${sha}\u001fnope\u001f1\u001fA\u001fs\u001f`)).toBeNull();
    expect(
      parseHistoryRecord(`\n${sha}\u001f\u001f86400\u001fA\u001fsubj\u001fbody\u001fmore\n`),
    ).toEqual({
      sha,
      parents: [],
      committedAt: "1970-01-02T00:00:00.000Z",
      authorName: "A",
      subject: "subj",
      body: "body\u001fmore",
    });
  });

  it("recognises git's missing-object errors", () => {
    expect(isMissingObjectError("fatal: unable to read 94235ab")).toBe(true);
    // What git 2.50 printed walking miniflux/v2's feed.go past the window.
    expect(
      isMissingObjectError(
        "warning: lazy fetching disabled; some objects may not be available\nfatal: could not fetch 4add53b676ffec036222c397ded958f985907aaa from promisor remote\n",
      ),
    ).toBe(true);
    expect(isMissingObjectError("fatal: ambiguous argument")).toBe(false);
  });
});

describe("get_change_history over the real history repository", () => {
  const repo = {
    id: "c-ready",
    label: "acme",
    provider: "github",
    ownerOrOrg: "acme",
    repoName: "reader",
    apiBaseUrl: null,
  };
  const tool = () =>
    createChangeHistoryTool({
      listRepos: async () => [repo],
      isIndexedFile: async (_p, _r, f) => ["h.txt", "g.txt"].includes(f),
      loadVersions: async () =>
        codeVersionIndexOf([{ repoConnectionId: "c-ready", commitSha: tip, repo }]),
    });

  it("lists commits with links, redacted text, no e-mail, and the coverage line", async () => {
    const r = await tool().execute(
      { filePath: "h.txt", startLine: 2, endLine: 2 },
      { projectId: "p1" },
    );
    expect(r.isError).toBeUndefined();
    expect(r.resultCount).toBe(1);
    expect(r.content).toContain(`https://github.com/acme/reader/commit/${shas.newB}`);
    expect(r.content).toContain("Why: B1 was wrong.");
    expect(r.content).toContain("Author: Ann Author");
    expect(r.content).not.toMatch(/@example\.com/);
    expect(r.content).not.toContain("ghp_0123456789");
    expect(r.content).not.toContain("Signed-off-by");
    expect(r.content).toContain("[more: bound — no history before 2025-10-01");
    expect(r.citations).toEqual([
      expect.objectContaining({ path: "h.txt", startLine: 2, endLine: 2, commitSha: tip }),
    ]);
  });

  it("refuses a file that is not at the indexed commit with the missing-file reply", async () => {
    const t = createChangeHistoryTool({
      listRepos: async () => [repo],
      isIndexedFile: async () => true,
      loadVersions: async () =>
        codeVersionIndexOf([{ repoConnectionId: "c-ready", commitSha: tip, repo }]),
    });
    const r = await t.execute({ filePath: "f.txt" }, { projectId: "p1" });
    expect(r).toEqual({ content: "Error: File not found or not accessible: f.txt", isError: true });
  });
});
