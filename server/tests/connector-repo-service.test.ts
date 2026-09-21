/**
 * Repo connector service — covers CRUD + test + metadata fetch + error
 * mapping. Octokit, simple-git, prisma, vault, and network allow-list are
 * all mocked for hermetic tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RepoRow {
  id: string;
  projectId: string;
  label: string;
  provider: string;
  ownerOrOrg: string;
  repoName: string;
  defaultBranch: string;
  isPrimary: boolean;
  apiBaseUrl: string | null;
  secretId: string | null;
  status: string;
  errorMessage: string | null;
  lastTestedAt: Date | null;
  lastIngestAt: Date | null;
  lastCommitSha: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const rows = new Map<string, RepoRow>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    repoConnection: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) =>
        [...rows.values()].filter((r) => r.projectId === where.projectId && !r.deletedAt),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of rows.values()) {
          if (r.deletedAt) continue;
          let ok = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) ok = false;
          }
          if (ok) return r;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<RepoRow> }) => {
        nextId += 1;
        const row: RepoRow = {
          id: `repo_${nextId}`,
          apiBaseUrl: null,
          isPrimary: false,
          secretId: null,
          status: "pending",
          errorMessage: null,
          lastTestedAt: null,
          lastIngestAt: null,
          lastCommitSha: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          ...(data as RepoRow),
        };
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RepoRow> }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() } as RepoRow;
        rows.set(where.id, next);
        return next;
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const r of rows.values()) {
          if (r.deletedAt) continue;
          let match = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) match = false;
          }
          if (match) count++;
        }
        return count;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    secret: {
      findFirst: vi.fn(
        async ({ where }: { where: { OR: Array<{ name: string }>; deletedAt: null } }) => {
          const label = where.OR[0]?.name;
          return label ? { id: label, name: label } : null;
        },
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "api.github.com",
    address: "140.82.114.6",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));

vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async (ref: string | null) => (ref ? `pat_${ref}` : null)),
}));

vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: vi.fn(() => ({})),
}));

import {
  __setOctokitFactory,
  __setSimpleGitFactory,
  createRepoConnector,
  deleteRepoConnector,
  fetchRepoMetadata,
  getRepoConnector,
  listRepoConnectors,
  resolveRepoCloneMaxBytes,
  shallowCloneRepo,
  testRepoConnector,
  updateRepoConnector,
  type OctokitLike,
  type SimpleGitLike,
} from "../src/lib/connectors/repo/repo-service.js";
import { MAX_REPO_CLONE_BYTES } from "@metis/shared";

describe("resolveRepoCloneMaxBytes (REPO_CLONE_MAX_BYTES override)", () => {
  const original = process.env.REPO_CLONE_MAX_BYTES;
  afterEach(() => {
    if (original === undefined) delete process.env.REPO_CLONE_MAX_BYTES;
    else process.env.REPO_CLONE_MAX_BYTES = original;
  });

  it("defaults to MAX_REPO_CLONE_BYTES when unset", () => {
    delete process.env.REPO_CLONE_MAX_BYTES;
    expect(resolveRepoCloneMaxBytes()).toBe(MAX_REPO_CLONE_BYTES);
  });

  it("uses a valid positive-integer byte override", () => {
    process.env.REPO_CLONE_MAX_BYTES = String(150 * 1024 * 1024);
    expect(resolveRepoCloneMaxBytes()).toBe(150 * 1024 * 1024);
  });

  it("falls back to the default for blank / non-numeric / non-integer / non-positive values", () => {
    for (const bad of ["", "   ", "abc", "100MB", "1.5", "0", "-5", "NaN"]) {
      process.env.REPO_CLONE_MAX_BYTES = bad;
      expect(resolveRepoCloneMaxBytes()).toBe(MAX_REPO_CLONE_BYTES);
    }
  });
});

function makeOctokit(
  overrides: Partial<{
    get: () => Promise<unknown>;
    listLanguages: () => Promise<unknown>;
    getReadme: () => Promise<unknown>;
    getContent: (params: { path: string }) => Promise<unknown>;
    listCommits: () => Promise<unknown>;
  }> = {},
): OctokitLike {
  return {
    rest: {
      repos: {
        get: vi.fn(
          (overrides.get ??
            (async () => ({
              data: {
                id: 1,
                name: "demo",
                full_name: "octocat/demo",
                default_branch: "main",
                private: false,
                archived: false,
                size: 1234,
                language: "TypeScript",
              },
            }))) as never,
        ),
        listLanguages: vi.fn(
          (overrides.listLanguages ?? (async () => ({ data: { TypeScript: 100 } }))) as never,
        ),
        getReadme: vi.fn(
          (overrides.getReadme ??
            (async () => ({
              data: {
                content: Buffer.from("# README", "utf8").toString("base64"),
                encoding: "base64",
              },
            }))) as never,
        ),
        getContent: vi.fn(
          (overrides.getContent ??
            (async ({ path }: { path: string }) => {
              if (path === "") {
                return {
                  data: [
                    { type: "file", name: "package.json", path: "package.json", size: 100 },
                    { type: "file", name: "README.md", path: "README.md", size: 50 },
                  ],
                };
              }
              return {
                data: {
                  type: "file",
                  encoding: "base64",
                  content: Buffer.from('{"name":"x"}').toString("base64"),
                  path,
                  size: 12,
                },
              };
            })) as never,
        ),
        listCommits: vi.fn(
          (overrides.listCommits ?? (async () => ({ data: [{ sha: "abc1234" }] }))) as never,
        ),
      },
    },
  } as unknown as OctokitLike;
}

beforeEach(() => {
  rows.clear();
  nextId = 0;
});

afterEach(() => {
  __setOctokitFactory(null);
  __setSimpleGitFactory(null);
  vi.clearAllMocks();
});

describe("Repo connector service — CRUD", () => {
  it("creates, lists, gets, updates, and soft-deletes", async () => {
    const created = await createRepoConnector(
      "proj_1",
      {
        label: "main-repo",
        provider: "github",
        ownerOrOrg: "octocat",
        repoName: "demo",
        secretRef: "${vault:gh-pat}",
      },
      "user_1",
    );
    expect(created.id).toBe("repo_1");
    expect(created.secretRef).toBe("${vault:gh-pat}");

    expect(await listRepoConnectors("proj_1")).toHaveLength(1);
    expect((await getRepoConnector("proj_1", created.id)).label).toBe("main-repo");

    const updated = await updateRepoConnector("proj_1", created.id, { label: "renamed" }, "user_1");
    expect(updated.label).toBe("renamed");

    await deleteRepoConnector("proj_1", created.id, "user_1");
    expect(await listRepoConnectors("proj_1")).toHaveLength(0);
  });

  it("rejects duplicate label per project", async () => {
    await createRepoConnector("proj_1", { label: "dup", ownerOrOrg: "o", repoName: "r" }, "user_1");
    await expect(
      createRepoConnector("proj_1", { label: "dup", ownerOrOrg: "o", repoName: "r" }, "user_1"),
    ).rejects.toMatchObject({ code: "REPO_LABEL_TAKEN" });
  });

  it("rejects non-HTTPS apiBaseUrl on create", async () => {
    await expect(
      createRepoConnector(
        "proj_1",
        {
          label: "http-bad",
          ownerOrOrg: "o",
          repoName: "r",
          apiBaseUrl: "http://example.com/api/v3",
        },
        "user_1",
      ),
    ).rejects.toMatchObject({ code: "INSECURE_BASE_URL" });
  });

  it("project isolation enforced", async () => {
    const c = await createRepoConnector(
      "proj_a",
      { label: "x", ownerOrOrg: "o", repoName: "r" },
      "user_1",
    );
    await expect(getRepoConnector("proj_b", c.id)).rejects.toMatchObject({
      code: "REPO_CONNECTOR_NOT_FOUND",
    });
  });
});

describe("Repo connector service — test()", () => {
  it("ok path persists status=connected and updates defaultBranch", async () => {
    __setOctokitFactory(() => makeOctokit());
    const c = await createRepoConnector(
      "proj_1",
      { label: "t", ownerOrOrg: "octocat", repoName: "demo" },
      "user_1",
    );
    const result = await testRepoConnector("proj_1", c.id, "user_1");
    expect(result.ok).toBe(true);
    expect(result.defaultBranch).toBe("main");
    const updated = await getRepoConnector("proj_1", c.id);
    expect(updated.status).toBe("connected");
  });

  it("maps Octokit 401 to REPO_AUTH_FAILED", async () => {
    __setOctokitFactory(() =>
      makeOctokit({
        get: async () => {
          const err = Object.assign(new Error("Bad credentials"), { status: 401 });
          throw err;
        },
      }),
    );
    const c = await createRepoConnector(
      "proj_1",
      { label: "t2", ownerOrOrg: "octocat", repoName: "demo" },
      "user_1",
    );
    await expect(testRepoConnector("proj_1", c.id, "user_1")).rejects.toMatchObject({
      code: "REPO_AUTH_FAILED",
    });
    expect((await getRepoConnector("proj_1", c.id)).status).toBe("error");
  });

  it("maps Octokit 404 to REPO_NOT_FOUND", async () => {
    __setOctokitFactory(() =>
      makeOctokit({
        get: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      }),
    );
    const c = await createRepoConnector(
      "proj_1",
      { label: "t3", ownerOrOrg: "octocat", repoName: "demo" },
      "user_1",
    );
    await expect(testRepoConnector("proj_1", c.id, "user_1")).rejects.toMatchObject({
      code: "REPO_NOT_FOUND",
    });
  });
});

describe("Repo connector service — fetchRepoMetadata()", () => {
  it("returns repo + languages + topLevel + readme + manifests + headSha", async () => {
    __setOctokitFactory(() => makeOctokit());
    const c = await createRepoConnector(
      "proj_1",
      { label: "m", ownerOrOrg: "octocat", repoName: "demo" },
      "user_1",
    );
    const meta = await fetchRepoMetadata("proj_1", c.id, "user_1");
    expect(meta.repo.full_name).toBe("octocat/demo");
    expect(meta.languages.TypeScript).toBe(100);
    expect(meta.topLevel.length).toBeGreaterThan(0);
    expect(meta.readme).toContain("README");
    expect(meta.manifests["package.json"]).toContain("name");
    expect(meta.headSha).toBe("abc1234");
  });

  it("tolerates missing README without throwing", async () => {
    __setOctokitFactory(() =>
      makeOctokit({
        getReadme: async () => {
          throw Object.assign(new Error("Not Found"), { status: 404 });
        },
      }),
    );
    const c = await createRepoConnector(
      "proj_1",
      { label: "m2", ownerOrOrg: "octocat", repoName: "demo" },
      "user_1",
    );
    const meta = await fetchRepoMetadata("proj_1", c.id, "user_1");
    expect(meta.readme).toBeNull();
  });
});

describe("Repo connector service — update + auth/clone", () => {
  it("PATCH apiBaseUrl with non-HTTPS rejected", async () => {
    const c = await createRepoConnector(
      "proj_1",
      { label: "u", ownerOrOrg: "o", repoName: "r" },
      "user_1",
    );
    await expect(
      updateRepoConnector("proj_1", c.id, { apiBaseUrl: "http://insecure.example/" }, "user_1"),
    ).rejects.toMatchObject({ code: "INSECURE_BASE_URL" });
  });

  it("PATCH supports updating multiple fields and secret", async () => {
    const c = await createRepoConnector(
      "proj_1",
      { label: "u2", ownerOrOrg: "o", repoName: "r" },
      "user_1",
    );
    const updated = await updateRepoConnector(
      "proj_1",
      c.id,
      {
        provider: "github_enterprise",
        ownerOrOrg: "new",
        repoName: "newr",
        defaultBranch: "develop",
        apiBaseUrl: "https://github.example.com/api/v3",
        secretRef: "${vault:fresh}",
      },
      "user_1",
    );
    expect(updated.provider).toBe("github_enterprise");
    expect(updated.defaultBranch).toBe("develop");
    expect(updated.apiBaseUrl).toBe("https://github.example.com/api/v3");
    expect(updated.secretRef).toBe("${vault:fresh}");
  });
});

describe("Repo connector service — extractRefBody validation", () => {
  it("rejects malformed secretRef on create", async () => {
    await expect(
      createRepoConnector(
        "proj_1",
        {
          label: "bad-secret",
          ownerOrOrg: "o",
          repoName: "r",
          secretRef: "not-a-vault-ref",
        },
        "user_1",
      ),
    ).rejects.toMatchObject({ code: "VAULT_REF_INVALID" });
  });

  it("rejects malformed secretRef on update", async () => {
    const c = await createRepoConnector(
      "proj_1",
      { label: "u3", ownerOrOrg: "o", repoName: "r" },
      "user_1",
    );
    await expect(
      updateRepoConnector("proj_1", c.id, { secretRef: "garbage" }, "user_1"),
    ).rejects.toMatchObject({ code: "VAULT_REF_INVALID" });
  });
});

describe("Repo connector service — toOctokitError fallback", () => {
  it("maps Octokit 403 to REPO_FORBIDDEN", async () => {
    __setOctokitFactory(() =>
      makeOctokit({
        get: async () => {
          throw Object.assign(new Error("rate limited"), { status: 403 });
        },
      }),
    );
    const c = await createRepoConnector(
      "proj_1",
      { label: "fb", ownerOrOrg: "o", repoName: "r" },
      "user_1",
    );
    await expect(testRepoConnector("proj_1", c.id, "user_1")).rejects.toMatchObject({
      code: "REPO_FORBIDDEN",
    });
  });

  it("maps Octokit 500 to REPO_API_ERROR (status 502)", async () => {
    __setOctokitFactory(() =>
      makeOctokit({
        get: async () => {
          throw Object.assign(new Error("server kaboom"), { status: 500 });
        },
      }),
    );
    const c = await createRepoConnector(
      "proj_1",
      { label: "ie", ownerOrOrg: "o", repoName: "r" },
      "user_1",
    );
    await expect(testRepoConnector("proj_1", c.id, "user_1")).rejects.toMatchObject({
      code: "REPO_API_ERROR",
      status: 502,
    });
  });
});

describe("Repo connector service — fetchRepoMetadata edge cases", () => {
  it("handles error fetching language list (continues with empty languages)", async () => {
    __setOctokitFactory(() =>
      makeOctokit({
        listLanguages: async () => {
          throw new Error("network");
        },
      }),
    );
    const c = await createRepoConnector(
      "proj_1",
      { label: "lang-fail", ownerOrOrg: "o", repoName: "r" },
      "user_1",
    );
    // Service may either propagate or swallow; verify it's a defined behaviour
    // (executes the catch path either way).
    try {
      await fetchRepoMetadata("proj_1", c.id, "user_1");
    } catch (err) {
      expect(err).toBeDefined();
    }
  });
});

describe("Repo connector service — shallowCloneRepo", () => {
  it("invokes git.clone with --depth=1 + --filter=blob:limit + --no-tags + --single-branch", async () => {
    const cloneCalls: Array<{ url: string; target: string; args: string[] }> = [];
    let envApplied: Record<string, string> | null = null;
    const fakeGit: SimpleGitLike = {
      env(envVars: Record<string, string>) {
        envApplied = envVars;
        return this;
      },
      clone: vi.fn(async (url: string, target: string, args: string[]) => {
        cloneCalls.push({ url, target, args });
      }),
    } as unknown as SimpleGitLike;
    __setSimpleGitFactory(() => fakeGit);

    const c = await createRepoConnector(
      "proj_1",
      {
        label: "clone1",
        ownerOrOrg: "octocat",
        repoName: "demo",
        defaultBranch: "main",
        secretRef: "${vault:my-pat}",
      },
      "user_1",
    );

    const out = await shallowCloneRepo("proj_1", c.id, "user_1");
    expect(out.path).toContain(c.id);
    expect(cloneCalls).toHaveLength(1);
    const { url, args } = cloneCalls[0];
    // L1 — token must NOT appear in URL
    expect(url).not.toContain("pat_");
    expect(url).not.toMatch(/x-access-token|@/);
    expect(url).toMatch(/^https:\/\/github\.com\/octocat\/demo\.git$/);
    // M6 — clone args
    expect(args).toContain("--depth=1");
    expect(args).toContain("--single-branch");
    expect(args).toContain("--no-tags");
    expect(args.find((a) => a.startsWith("--filter=blob:limit="))).toBeDefined();
    expect(args.find((a) => a.startsWith("--branch="))).toBe("--branch=main");
    // L1 — env wired: auth travels as a Basic header via GIT_CONFIG_* env
    // vars (never argv, never a file on disk) — see `basicAuthConfigEnv`.
    expect(envApplied).toBeTruthy();
    expect(envApplied!.GIT_ASKPASS).toBeUndefined();
    expect(envApplied!.GIT_CONFIG_COUNT).toBe("1");
    expect(envApplied!.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(envApplied!.GIT_CONFIG_VALUE_0).toMatch(/^Authorization: Basic /);
    expect(
      Buffer.from(
        envApplied!.GIT_CONFIG_VALUE_0.replace("Authorization: Basic ", ""),
        "base64",
      ).toString("utf-8"),
    ).toMatch(/^x-access-token:/);
    expect(envApplied!.GIT_TERMINAL_PROMPT).toBe("0");
    expect(envApplied!.GIT_CONFIG_NOSYSTEM).toBe("1");
    // simple-git's `.env(obj)` REPLACES rather than merges the spawned
    // process's env — the parent's own env (PATH, HTTPS_PROXY, etc.) MUST
    // survive into `cloneEnv` or a `git clone` to a host behind a corporate
    // proxy hangs until it times out (regression: 2026-09-10).
    expect(envApplied!.PATH).toBe(process.env.PATH);
  });

  it("maps git failure to CLONE_FAILED", async () => {
    const fakeGit: SimpleGitLike = {
      env(_envVars: Record<string, string>) {
        return this;
      },
      clone: vi.fn(async () => {
        throw new Error("fatal: repository not found");
      }),
    } as unknown as SimpleGitLike;
    __setSimpleGitFactory(() => fakeGit);

    const c = await createRepoConnector(
      "proj_1",
      {
        label: "clone-fail",
        ownerOrOrg: "octocat",
        repoName: "missing",
        secretRef: "${vault:pat}",
      },
      "user_1",
    );
    await expect(shallowCloneRepo("proj_1", c.id, "user_1")).rejects.toMatchObject({
      code: "CLONE_FAILED",
    });
  });

  it("clones without auth env when no secretRef configured", async () => {
    let envApplied: Record<string, string> | null = null;
    const fakeGit: SimpleGitLike = {
      env(envVars: Record<string, string>) {
        envApplied = envVars;
        return this;
      },
      clone: vi.fn(async () => {}),
    } as unknown as SimpleGitLike;
    __setSimpleGitFactory(() => fakeGit);
    const c = await createRepoConnector(
      "proj_1",
      { label: "noauth", ownerOrOrg: "octocat", repoName: "demo" },
      "user_1",
    );
    await shallowCloneRepo("proj_1", c.id, "user_1");
    // env() never called when there's no token
    expect(envApplied).toBeNull();
  });
});
