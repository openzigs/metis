/**
 * #1322 — clone health and the restore-or-report decision, on a real filesystem
 * with real (local) git repositories. The network restore is injected: it copies
 * a template repository, so "restored" means a real clone at a known commit.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { restoreCloneAtCommit } from "./repo-service.js";

const roots = vi.hoisted(() => ({ current: "", legacy: null as string | null }));
vi.mock("./clone-path.js", () => ({
  resolveRepoCloneRoot: () => roots.current,
  resolveRepoClonePath: (id: string) => `${roots.current}/${id}`,
  legacyTmpCloneRoot: () => roots.legacy,
}));

import { tryAcquireConnectorIngest } from "../ingest-guard.js";
import { ensureConnectorClone, inspectClone, resolveLeaseWaitMs } from "./clone-health.js";

const base = mkdtempSync(path.join(os.tmpdir(), "metis-1322-health-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function makeRepo(dir: string, files = 1, content = "export const v = 1;\n"): string {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), content);
  for (let i = 1; i < files; i++) writeFileSync(path.join(dir, "src", `f${i}.ts`), `${i}\n`);
  const run = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
  run("add", ".");
  run("commit", "-qm", "c");
  return run("rev-parse", "HEAD");
}

/** What a macOS temp purge left behind: the tree's directories and no files. */
function makeHollow(dir: string): void {
  mkdirSync(path.join(dir, "src", "a", "b"), { recursive: true });
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  mkdirSync(path.join(dir, ".git", "objects", "pack"), { recursive: true });
}

// One real repository every injected "restore" copies, so its commit is known.
const template = path.join(base, "template");
const SHA = makeRepo(template, 3, "restored\n");
const OTHER_SHA = "f".repeat(40);

let n = 0;
beforeEach(() => {
  n += 1;
  roots.current = path.join(base, `root-${n}`);
  roots.legacy = path.join(base, `legacy-${n}`);
  mkdirSync(roots.current, { recursive: true });
});

describe("inspectClone", () => {
  it("missing: no directory, or a file where the directory should be", async () => {
    expect(await inspectClone(path.join(base, "nope"))).toEqual({
      state: "missing",
      headSha: null,
    });
    const file = path.join(base, `file-${n}`);
    writeFileSync(file, "x");
    expect((await inspectClone(file)).state).toBe("missing");
  });

  it("hollow: directories and no files (the purged shape)", async () => {
    const dir = path.join(base, `hollow-${n}`);
    makeHollow(dir);
    expect(await inspectClone(dir)).toEqual({ state: "hollow", headSha: null });
    expect((await inspectClone(dir, { requireHead: false })).state).toBe("hollow");
  });

  it("hollow: HEAD still readable but every working-tree file gone", async () => {
    const dir = path.join(base, `headonly-${n}`);
    const sha = makeRepo(dir);
    rmSync(path.join(dir, "src"), { recursive: true });
    expect(await inspectClone(dir)).toEqual({ state: "hollow", headSha: sha });
  });

  it("hollow: a PARTIAL purge — most files gone, a few left — against the index count", async () => {
    const dir = path.join(base, `partial-${n}`);
    const sha = makeRepo(dir, 40);
    for (let i = 1; i < 30; i++) rmSync(path.join(dir, "src", `f${i}.ts`));
    expect(await inspectClone(dir)).toEqual({ state: "hollow", headSha: sha });
  });

  it("healthy within the tolerance: one file of forty missing is not a purge", async () => {
    const dir = path.join(base, `nearly-${n}`);
    makeRepo(dir, 40);
    rmSync(path.join(dir, "src", "f1.ts"));
    expect((await inspectClone(dir)).state).toBe("healthy");
  });

  it("healthy: HEAD reads and the working tree matches the index", async () => {
    const dir = path.join(base, `healthy-${n}`);
    const sha = makeRepo(dir, 5);
    expect(await inspectClone(dir)).toEqual({ state: "healthy", headSha: sha });
  });

  it("hollow when HEAD reads but the index is gone", async () => {
    const dir = path.join(base, `noindex-${n}`);
    makeRepo(dir);
    rmSync(path.join(dir, ".git", "index"));
    expect((await inspectClone(dir)).state).toBe("hollow");
  });

  it("files without git metadata are healthy only when HEAD is not required", async () => {
    const dir = path.join(base, `plain-${n}`);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a.ts"), "x");
    expect((await inspectClone(dir)).state).toBe("hollow");
    expect((await inspectClone(dir, { requireHead: false })).state).toBe("healthy");
  });
});

describe("resolveLeaseWaitMs", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("defaults to two minutes and honours CLONE_RESTORE_LEASE_WAIT_MS", () => {
    vi.stubEnv("CLONE_RESTORE_LEASE_WAIT_MS", "");
    expect(resolveLeaseWaitMs()).toBe(120_000);
    vi.stubEnv("CLONE_RESTORE_LEASE_WAIT_MS", "0");
    expect(resolveLeaseWaitMs()).toBe(0);
    vi.stubEnv("CLONE_RESTORE_LEASE_WAIT_MS", "nonsense");
    expect(resolveLeaseWaitMs()).toBe(120_000);
    vi.stubEnv("CLONE_RESTORE_LEASE_WAIT_MS", "5000");
    expect(resolveLeaseWaitMs()).toBe(5000);
  });
});

describe("ensureConnectorClone", () => {
  let restore: Mock<typeof restoreCloneAtCommit>;
  const input = (commit: string | null = SHA, connectorId = "c1") => ({
    projectId: "p",
    connectorId,
    loadCommitSha: vi.fn(async () => commit),
  });
  const deps = () => ({ restore, leaseWaitMs: 2_000 });

  beforeEach(() => {
    restore = vi.fn<typeof restoreCloneAtCommit>(async (_p, id) => {
      const target = path.join(roots.current, id);
      rmSync(target, { recursive: true, force: true });
      cpSync(template, target, { recursive: true });
      return { path: target, sizeBytes: 1 };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses a healthy clone at the recorded commit as it is", async () => {
    cpSync(template, path.join(roots.current, "c1"), { recursive: true });
    const out = await ensureConnectorClone(input(), deps());
    expect(out).toEqual({ status: "healthy", path: path.join(roots.current, "c1") });
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores a healthy clone at ANOTHER commit to the recorded one (L5)", async () => {
    makeRepo(path.join(roots.current, "c1"));
    const out = await ensureConnectorClone(input(), deps());
    expect(out.status).toBe("restored");
    expect(restore).toHaveBeenCalledWith("p", "c1", SHA, "system");
    expect((await inspectClone(path.join(roots.current, "c1"))).headSha).toBe(SHA);
  });

  it("restores a hollow clone at the recorded commit", async () => {
    makeHollow(path.join(roots.current, "c1"));
    const out = await ensureConnectorClone(input(), deps());
    expect(out.status).toBe("restored");
    expect(restore).toHaveBeenCalledWith("p", "c1", SHA, "system");
  });

  it("restores a missing clone at the recorded commit", async () => {
    const out = await ensureConnectorClone(input(), deps());
    expect(out.status).toBe("restored");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("reports a failed restore as unavailable, without throwing", async () => {
    makeHollow(path.join(roots.current, "c1"));
    restore.mockRejectedValueOnce(new Error("host unreachable"));
    const out = await ensureConnectorClone(input(), deps());
    expect(out).toEqual({ status: "unavailable", reason: "restore-failed", state: "hollow" });
  });

  it("reports a restore that leaves the wrong commit or no files as unavailable", async () => {
    restore.mockImplementationOnce(async (_p, id) => {
      makeRepo(path.join(roots.current, id)); // a different commit
      return { path: "", sizeBytes: 0 };
    });
    const out = await ensureConnectorClone(input(), deps());
    expect(out).toEqual({ status: "unavailable", reason: "restore-failed", state: "missing" });
  });

  it("never guesses a commit: no recorded commit means unavailable", async () => {
    const out = await ensureConnectorClone(input(null), deps());
    expect(out).toEqual({ status: "unavailable", reason: "no-recorded-commit", state: "missing" });
    expect(restore).not.toHaveBeenCalled();
  });

  describe("another job holding the connector (B1)", () => {
    it("two concurrent calls restore once; the second finds the first's clone", async () => {
      makeHollow(path.join(roots.current, "c1"));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      restore.mockImplementationOnce(async (_p, id) => {
        await gate;
        cpSync(template, path.join(roots.current, id), { recursive: true });
        return { path: "", sizeBytes: 1 };
      });
      const first = ensureConnectorClone(input(), deps());
      await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
      const second = ensureConnectorClone(input(), deps());
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe("restored");
      expect(b).toEqual({ status: "healthy", path: path.join(roots.current, "c1") });
      expect(restore).toHaveBeenCalledOnce();
    });

    it("waits out an ingest that deletes and re-clones, then uses the ingest's NEW commit", async () => {
      // The ingest holds the connector and has deleted the clone…
      const lease = tryAcquireConnectorIngest("c1", "deep-ingest")!;
      let graphCommit: string = OTHER_SHA;
      const run = ensureConnectorClone(
        { projectId: "p", connectorId: "c1", loadCommitSha: async () => graphCommit },
        deps(),
      );
      // …then writes the new clone and moves the graph to its commit, and lets go.
      await new Promise((resolve) => setTimeout(resolve, 400));
      cpSync(template, path.join(roots.current, "c1"), { recursive: true });
      graphCommit = SHA;
      lease.release();
      expect(await run).toEqual({ status: "healthy", path: path.join(roots.current, "c1") });
      // The commit was re-read after the wait: nothing restored over the ingest.
      expect(restore).not.toHaveBeenCalled();
    });

    it("says busy — not re-ingest — when the hold outlasts the wait", async () => {
      const lease = tryAcquireConnectorIngest("c1", "deep-ingest")!;
      try {
        const started = Date.now();
        const out = await ensureConnectorClone(input(), { restore, leaseWaitMs: 300 });
        expect(out).toEqual({ status: "unavailable", reason: "busy", state: "missing" });
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        expect(restore).not.toHaveBeenCalled();
      } finally {
        lease.release();
      }
    });

    it("releases its own hold when done", async () => {
      await ensureConnectorClone(input(), deps());
      const after = tryAcquireConnectorIngest("c1", "after");
      expect(after).not.toBeNull();
      after?.release();
    });
  });

  describe("an install upgraded from the old tmp default", () => {
    it("moves a healthy clone at the SAME commit across instead of re-fetching it", async () => {
      const legacy = path.join(roots.legacy!, "c1");
      const sha = makeRepo(legacy, 1, "legacy\n");
      const out = await ensureConnectorClone(input(sha), deps());
      expect(out).toEqual({ status: "migrated", path: path.join(roots.current, "c1") });
      expect(restore).not.toHaveBeenCalled();
      expect(readFileSync(path.join(roots.current, "c1", "src", "app.ts"), "utf8")).toBe(
        "legacy\n",
      );
      expect(existsSync(legacy)).toBe(false);
    });

    it("never adopts an old clone at a different commit; re-fetches the recorded one", async () => {
      makeRepo(path.join(roots.legacy!, "c1"));
      const out = await ensureConnectorClone(input(), deps());
      expect(out.status).toBe("restored");
      expect(restore).toHaveBeenCalledWith("p", "c1", SHA, "system");
      expect(existsSync(path.join(roots.legacy!, "c1"))).toBe(true);
    });

    it("never adopts a PARTLY purged old clone", async () => {
      const legacy = path.join(roots.legacy!, "c1");
      const sha = makeRepo(legacy, 20);
      for (let i = 1; i < 15; i++) rmSync(path.join(legacy, "src", `f${i}.ts`));
      const out = await ensureConnectorClone(input(sha), deps());
      expect(out.status).not.toBe("migrated");
      expect(restore).toHaveBeenCalledOnce();
    });

    it("never follows a symlink planted at the old location (L2)", async () => {
      const elsewhere = path.join(base, `elsewhere-${n}`);
      const sha = makeRepo(elsewhere);
      mkdirSync(roots.legacy!, { recursive: true });
      symlinkSync(elsewhere, path.join(roots.legacy!, "c1"));
      const out = await ensureConnectorClone(input(sha), deps());
      expect(out.status).not.toBe("migrated");
      expect(existsSync(elsewhere)).toBe(true);
    });

    it("never follows a symlinked old ROOT either", async () => {
      const elsewhere = path.join(base, `elsewhere-root-${n}`);
      const sha = makeRepo(path.join(elsewhere, "c1"));
      symlinkSync(elsewhere, roots.legacy!);
      const out = await ensureConnectorClone(input(sha), deps());
      expect(out.status).not.toBe("migrated");
      expect(existsSync(path.join(elsewhere, "c1"))).toBe(true);
    });

    it("ignores a hollow old clone", async () => {
      makeHollow(path.join(roots.legacy!, "c1"));
      const out = await ensureConnectorClone(input(), deps());
      expect(out.status).toBe("restored");
    });

    it("is skipped when REPO_CLONE_DIR names the root (no legacy location)", async () => {
      roots.legacy = null;
      const out = await ensureConnectorClone(input(), deps());
      expect(out.status).toBe("restored");
    });

    it("copies across filesystems when a rename is refused (EXDEV)", async () => {
      const legacy = path.join(roots.legacy!, "c1");
      const sha = makeRepo(legacy);
      const fs = (await import("node:fs")).promises;
      const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
      const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(exdev);
      const out = await ensureConnectorClone(input(sha), deps());
      expect(rename).toHaveBeenCalledOnce();
      expect(out.status).toBe("migrated");
      expect(existsSync(legacy)).toBe(false);
      expect((await inspectClone(path.join(roots.current, "c1"))).state).toBe("healthy");
    });

    it("falls back to a re-fetch when the move fails for another reason", async () => {
      const sha = makeRepo(path.join(roots.legacy!, "c1"));
      const fs = (await import("node:fs")).promises;
      vi.spyOn(fs, "rename").mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );
      const out = await ensureConnectorClone(input(sha), deps());
      // The re-fetch copies the template, whose commit is not `sha`: unavailable,
      // and above all never the old clone.
      expect(restore).toHaveBeenCalledWith("p", "c1", sha, "system");
      expect(out.status).not.toBe("migrated");
    });
  });
});
