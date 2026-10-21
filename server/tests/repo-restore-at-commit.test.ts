/**
 * #1322 — restoring a purged clone at the code graph's commit, against a REAL
 * local bare repository (no network): `fetchCommitInto` with the real simple-git
 * client, and `restoreCloneAtCommit` end to end with only the remote URL
 * redirected from the connector's https host to the local fixture.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    repoConnection: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) => {
        const row = rows.get(where.id);
        return row && row.projectId === where.projectId ? row : null;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));
const audit = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit }));
vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "github.com",
    address: "140.82.114.4",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));
vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async () => null),
  readBoundSecret: vi.fn(async () => "pat-1322"),
}));
vi.mock("../src/lib/vault/bound-secret.js", () => ({
  VAULT_REF_UNRESOLVED: "VAULT_REF_UNRESOLVED",
  bindSecretRef: vi.fn(async (ref: string) => ref),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn(() => ({})) }));

import {
  __defaultGitForTest as defaultGit,
  __setSimpleGitFactory,
  authenticatedGitEnv,
  fetchCommitInto,
  restoreCloneAtCommit,
  sweepStaleRestoreDirs,
  type SimpleGitLike,
} from "../src/lib/connectors/repo/repo-service.js";
import { inspectClone } from "../src/lib/connectors/repo/clone-health.js";

let base: string;
let bare: string;
let firstSha: string;
let tipSha: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "metis-1322-git-"));
  const work = join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src", "app.ts"), "export const v = 1;\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one");
  firstSha = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "src", "app.ts"), "export const v = 2;\n");
  git(work, "commit", "-qam", "two");
  tipSha = git(work, "rev-parse", "HEAD");
  bare = join(base, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  // What github.com serves: any commit reachable from a ref can be fetched by id.
  git(bare, "config", "uploadpack.allowReachableSHA1InWant", "true");
  // …and honours a partial-clone filter (M6: no oversized blob is downloaded).
  git(bare, "config", "uploadpack.allowFilter", "true");
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("fetchCommitInto — the real git client", () => {
  it("checks out exactly the requested commit, not the branch tip", async () => {
    const dir = mkdtempSync(join(base, "fetch-"));
    const client = await defaultGit(dir);
    // Through the authenticated env, so simple-git's env guard is exercised too (#903).
    await fetchCommitInto(dir, bare, firstSha, client.env!(authenticatedGitEnv("t")));
    expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("export const v = 1;\n");
    expect(await inspectClone(dir)).toEqual({ state: "healthy", headSha: firstSha });
    expect(firstSha).not.toBe(tipSha);
  });

  it("fetches with the clone's blob-size filter (L1), and still checks out", async () => {
    const dir = mkdtempSync(join(base, "fetch-filter-"));
    const real = (await defaultGit(dir)) as SimpleGitLike;
    const calls: string[][] = [];
    const spy: SimpleGitLike = {
      clone: real.clone.bind(real),
      raw: async (args) => {
        calls.push(args);
        return real.raw!(args);
      },
    };
    await fetchCommitInto(dir, bare, firstSha, spy, 12345);
    expect(calls.find((a) => a[0] === "fetch")).toContain("--filter=blob:limit=12345");
    expect(await inspectClone(dir)).toEqual({ state: "healthy", headSha: firstSha });
  });

  it("refuses anything that is not a full commit SHA, before running git", async () => {
    const raw = vi.fn(async () => "");
    await expect(
      fetchCommitInto("/nowhere", bare, "main", { clone: vi.fn(), raw }),
    ).rejects.toThrow(/full commit SHA/);
    expect(raw).not.toHaveBeenCalled();
  });

  it("refuses a client that cannot run raw commands", async () => {
    await expect(fetchCommitInto("/nowhere", bare, firstSha, { clone: vi.fn() })).rejects.toThrow(
      /raw/,
    );
  });

  it("throws when the remote does not have the commit", async () => {
    const dir = mkdtempSync(join(base, "fetch-missing-"));
    await expect(
      fetchCommitInto(dir, bare, "0".repeat(40), await defaultGit(dir)),
    ).rejects.toThrow();
  });
});

describe("restoreCloneAtCommit", () => {
  let cloneRoot: string;
  const original = process.env.REPO_CLONE_DIR;
  const originalCap = process.env.REPO_CLONE_MAX_BYTES;

  beforeEach(() => {
    cloneRoot = mkdtempSync(join(base, "clones-"));
    process.env.REPO_CLONE_DIR = cloneRoot;
    rows.clear();
    rows.set("conn_1", {
      id: "conn_1",
      projectId: "proj_1",
      label: "miniflux",
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "miniflux",
      defaultBranch: "main",
      isPrimary: true,
      apiBaseUrl: null,
      secretId: "sec_1",
      status: "connected",
      errorMessage: null,
      lastTestedAt: null,
      lastIngestAt: null,
      lastCommitSha: firstSha,
      createdById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    audit.mockClear();
    // The real client, with the connector's https remote pointed at the local fixture.
    __setSimpleGitFactory((cwd) => {
      let real: SimpleGitLike | null = null;
      let env: Record<string, string> | null = null;
      const client = async () => {
        real ??= await defaultGit(cwd);
        return env && real.env ? real.env(env) : real;
      };
      const wrapped: SimpleGitLike = {
        clone: async () => undefined,
        env(vars) {
          env = vars;
          return wrapped;
        },
        async raw(args) {
          const redirected =
            args[0] === "remote" && args[1] === "add" ? [...args.slice(0, 3), bare] : args;
          return (await client()).raw!(redirected);
        },
      };
      return wrapped;
    });
  });

  afterEach(() => {
    __setSimpleGitFactory(null);
    if (original === undefined) delete process.env.REPO_CLONE_DIR;
    else process.env.REPO_CLONE_DIR = original;
    if (originalCap === undefined) delete process.env.REPO_CLONE_MAX_BYTES;
    else process.env.REPO_CLONE_MAX_BYTES = originalCap;
  });

  it("replaces a hollow clone (directories, no files) with the recorded commit", async () => {
    const target = join(cloneRoot, "conn_1");
    mkdirSync(join(target, "src", "deep"), { recursive: true });
    mkdirSync(join(target, ".git", "objects"), { recursive: true });
    expect((await inspectClone(target)).state).toBe("hollow");

    const out = await restoreCloneAtCommit("proj_1", "conn_1", firstSha, "system");

    expect(out).toMatchObject({ path: target, commitSha: firstSha });
    expect(await inspectClone(target)).toEqual({ state: "healthy", headSha: firstSha });
    expect(readFileSync(join(target, "src", "app.ts"), "utf8")).toBe("export const v = 1;\n");
    // The staging directory was renamed into place, never left beside it.
    expect(readdirSync(cloneRoot)).toEqual(["conn_1"]);
    // The PAT went in a header, never into the remote URL on disk.
    expect(readFileSync(join(target, ".git", "config"), "utf8")).not.toContain("pat-1322");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "connector.repo.restore" }),
    );
  });

  it("leaves the existing directory alone and no staging behind when the commit is unknown", async () => {
    const target = join(cloneRoot, "conn_1");
    mkdirSync(join(target, "src"), { recursive: true });

    await expect(
      restoreCloneAtCommit("proj_1", "conn_1", "1".repeat(40), "system"),
    ).rejects.toMatchObject({ code: "RESTORE_FAILED", status: 502 });

    expect(existsSync(join(target, "src"))).toBe(true);
    expect(readdirSync(cloneRoot)).toEqual(["conn_1"]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "connector.repo.restore.failed" }),
    );
  });

  it("enforces the clone-size cap on what it fetched", async () => {
    process.env.REPO_CLONE_MAX_BYTES = "1";
    await expect(
      restoreCloneAtCommit("proj_1", "conn_1", firstSha, "system"),
    ).rejects.toMatchObject({ code: "CLONE_TOO_LARGE" });
    expect(readdirSync(cloneRoot)).toEqual([]);
  });

  it("refuses a recorded commit that is not a full SHA", async () => {
    await expect(restoreCloneAtCommit("proj_1", "conn_1", "sha", "system")).rejects.toMatchObject({
      code: "RESTORE_COMMIT_INVALID",
    });
  });

  it("refuses a non-git connector before touching disk", async () => {
    rows.set("conn_1", { ...rows.get("conn_1")!, provider: "upload" });
    await expect(restoreCloneAtCommit("proj_1", "conn_1", firstSha, "system")).rejects.toThrow();
    expect(readdirSync(cloneRoot)).toEqual([]);
  });

  it("sweeps a dead restore's staging directory, but not a live one (L3)", async () => {
    const stale = join(cloneRoot, ".restore-conn_9-OLD");
    const live = join(cloneRoot, ".restore-conn_8-NEW");
    mkdirSync(stale);
    mkdirSync(live);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    await restoreCloneAtCommit("proj_1", "conn_1", firstSha, "system");

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(readdirSync(cloneRoot).sort()).toEqual([".restore-conn_8-NEW", "conn_1"]);
  });
});

describe("sweepStaleRestoreDirs", () => {
  it("leaves clones and other entries alone, and tolerates a missing root", async () => {
    const root = mkdtempSync(join(base, "sweep-"));
    mkdirSync(join(root, "conn_1"));
    mkdirSync(join(root, ".restore-x"));
    writeFileSync(join(root, ".restore-file"), "x");
    const later = Date.now() + 2 * 60 * 60 * 1000;
    expect(await sweepStaleRestoreDirs(root, later)).toBe(1);
    expect(readdirSync(root).sort()).toEqual([".restore-file", "conn_1"]);
    expect(await sweepStaleRestoreDirs(join(base, "no-such-root"))).toBe(0);
  });
});
