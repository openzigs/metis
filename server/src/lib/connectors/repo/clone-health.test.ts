/**
 * #1322 — clone health and the restore-or-report decision, on a real filesystem
 * with real (local) git repositories. The network restore is injected.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { ensureConnectorClone, inspectClone } from "./clone-health.js";

const base = mkdtempSync(path.join(os.tmpdir(), "metis-1322-health-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function makeRepo(dir: string, content = "export const v = 1;\n"): string {
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "app.ts"), content);
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

  it("healthy: HEAD reads and a file exists", async () => {
    const dir = path.join(base, `healthy-${n}`);
    const sha = makeRepo(dir);
    expect(await inspectClone(dir)).toEqual({ state: "healthy", headSha: sha });
  });

  it("files without git metadata are healthy only when HEAD is not required", async () => {
    const dir = path.join(base, `plain-${n}`);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "a.ts"), "x");
    expect((await inspectClone(dir)).state).toBe("hollow");
    expect((await inspectClone(dir, { requireHead: false })).state).toBe("healthy");
  });
});

describe("ensureConnectorClone", () => {
  const SHA = "a".repeat(40);
  let restore: Mock<typeof restoreCloneAtCommit>;

  beforeEach(() => {
    restore = vi.fn<typeof restoreCloneAtCommit>(async (_p: string, id: string) => {
      makeRepo(path.join(roots.current, id));
      return { path: path.join(roots.current, id), sizeBytes: 1 };
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses a healthy clone as it is", async () => {
    makeRepo(path.join(roots.current, "c1"));
    const out = await ensureConnectorClone(
      { projectId: "p", connectorId: "c1", commitSha: SHA },
      { restore },
    );
    expect(out).toEqual({ status: "healthy", path: path.join(roots.current, "c1") });
    expect(restore).not.toHaveBeenCalled();
  });

  it("restores a hollow clone at the recorded commit", async () => {
    makeHollow(path.join(roots.current, "c1"));
    const out = await ensureConnectorClone(
      { projectId: "p", connectorId: "c1", commitSha: SHA },
      { restore },
    );
    expect(out.status).toBe("restored");
    expect(restore).toHaveBeenCalledWith("p", "c1", SHA, "system");
  });

  it("restores a missing clone at the recorded commit", async () => {
    const out = await ensureConnectorClone(
      { projectId: "p", connectorId: "c1", commitSha: SHA },
      { restore },
    );
    expect(out.status).toBe("restored");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("reports a failed restore as unavailable, without throwing", async () => {
    makeHollow(path.join(roots.current, "c1"));
    restore.mockRejectedValueOnce(new Error("host unreachable"));
    const out = await ensureConnectorClone(
      { projectId: "p", connectorId: "c1", commitSha: SHA },
      { restore },
    );
    expect(out).toEqual({ status: "unavailable", reason: "restore-failed", state: "hollow" });
  });

  it("reports a restore that still leaves no files as unavailable", async () => {
    restore.mockResolvedValueOnce({ path: "", sizeBytes: 0 });
    const out = await ensureConnectorClone(
      { projectId: "p", connectorId: "c1", commitSha: SHA },
      { restore },
    );
    expect(out).toEqual({ status: "unavailable", reason: "restore-failed", state: "missing" });
  });

  it("never guesses a commit: no recorded commit means unavailable", async () => {
    const out = await ensureConnectorClone(
      { projectId: "p", connectorId: "c1", commitSha: null },
      { restore },
    );
    expect(out).toEqual({ status: "unavailable", reason: "no-recorded-commit", state: "missing" });
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not touch a clone an ingest is writing right now", async () => {
    const lease = tryAcquireConnectorIngest("c1", "test-ingest")!;
    try {
      const out = await ensureConnectorClone(
        { projectId: "p", connectorId: "c1", commitSha: SHA },
        { restore },
      );
      expect(out).toMatchObject({ status: "unavailable", reason: "ingest-in-progress" });
      expect(restore).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }
    // And it releases its own lease when done.
    await ensureConnectorClone({ projectId: "p", connectorId: "c1", commitSha: SHA }, { restore });
    const after = tryAcquireConnectorIngest("c1", "after");
    expect(after).not.toBeNull();
    after?.release();
  });

  describe("an install upgraded from the old tmp default", () => {
    it("moves a healthy clone at the SAME commit across instead of re-fetching it", async () => {
      const legacy = path.join(roots.legacy!, "c1");
      const sha = makeRepo(legacy, "legacy\n");
      const out = await ensureConnectorClone(
        { projectId: "p", connectorId: "c1", commitSha: sha },
        { restore },
      );
      expect(out).toEqual({ status: "migrated", path: path.join(roots.current, "c1") });
      expect(restore).not.toHaveBeenCalled();
      expect(readFileSync(path.join(roots.current, "c1", "src", "app.ts"), "utf8")).toBe(
        "legacy\n",
      );
      expect(existsSync(legacy)).toBe(false);
    });

    it("never adopts an old clone at a different commit; re-fetches the recorded one", async () => {
      makeRepo(path.join(roots.legacy!, "c1"));
      const out = await ensureConnectorClone(
        { projectId: "p", connectorId: "c1", commitSha: SHA },
        { restore },
      );
      expect(out.status).toBe("restored");
      expect(restore).toHaveBeenCalledWith("p", "c1", SHA, "system");
      expect(existsSync(path.join(roots.legacy!, "c1"))).toBe(true);
    });

    it("ignores a hollow old clone", async () => {
      makeHollow(path.join(roots.legacy!, "c1"));
      const out = await ensureConnectorClone(
        { projectId: "p", connectorId: "c1", commitSha: SHA },
        { restore },
      );
      expect(out.status).toBe("restored");
    });

    it("is skipped when REPO_CLONE_DIR names the root (no legacy location)", async () => {
      roots.legacy = null;
      const out = await ensureConnectorClone(
        { projectId: "p", connectorId: "c1", commitSha: SHA },
        { restore },
      );
      expect(out.status).toBe("restored");
    });

    it("copies across filesystems when a rename is refused (EXDEV)", async () => {
      const legacy = path.join(roots.legacy!, "c1");
      const sha = makeRepo(legacy);
      const fs = (await import("node:fs")).promises;
      const exdev = Object.assign(new Error("cross-device"), { code: "EXDEV" });
      const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(exdev);
      const out = await ensureConnectorClone(
        { projectId: "p", connectorId: "c1", commitSha: sha },
        { restore },
      );
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
      const out = await ensureConnectorClone(
        { projectId: "p", connectorId: "c1", commitSha: sha },
        { restore },
      );
      expect(out.status).toBe("restored");
      expect(restore).toHaveBeenCalledWith("p", "c1", sha, "system");
    });
  });
});
