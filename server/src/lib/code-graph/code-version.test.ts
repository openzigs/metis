/**
 * #2325 — the version a chat tool result states, and the permalink pinned to
 * it. Prisma is mocked: the reader is checked for its scoping and for what it
 * does with a deleted or foreign connector.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: { codeGraph: { findMany } } }));

import {
  buildCommitPermalink,
  buildCodePermalink,
  codeCitationRef,
  codeVersionIndexOf,
  formatCodeVersionLine,
  loadCodeVersions,
  NO_CODE_VERSIONS,
  versionOfGraph,
} from "./code-version.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const github = { provider: "github", ownerOrOrg: "acme", repoName: "app", apiBaseUrl: null };

describe("buildCommitPermalink (#2338) — a commit link per connector type", () => {
  it("github and github_enterprise: /commit/<sha> on the web origin", () => {
    expect(buildCommitPermalink(github, SHA)).toBe(`https://github.com/acme/app/commit/${SHA}`);
    expect(
      buildCommitPermalink(
        { ...github, provider: "github_enterprise", apiBaseUrl: "https://ghe.acme.test/api/v3" },
        SHA,
      ),
    ).toBe(`https://ghe.acme.test/acme/app/commit/${SHA}`);
  });

  it("gitlab: /-/commit/<sha>, on gitlab.com or the stored https origin without userinfo", () => {
    const gl = { ...github, provider: "gitlab" };
    expect(buildCommitPermalink(gl, SHA)).toBe(`https://gitlab.com/acme/app/-/commit/${SHA}`);
    expect(
      buildCommitPermalink({ ...gl, apiBaseUrl: "https://user:pw@gl.acme.test/api/v4" }, SHA),
    ).toBe(`https://gl.acme.test/acme/app/-/commit/${SHA}`);
    expect(buildCommitPermalink({ ...gl, apiBaseUrl: "http://gl.acme.test" }, SHA)).toBeNull();
    expect(buildCommitPermalink({ ...gl, apiBaseUrl: "not a url" }, SHA)).toBeNull();
  });

  it("no link for another type, an unsafe coordinate or a non-SHA", () => {
    expect(buildCommitPermalink({ ...github, provider: "local" }, SHA)).toBeNull();
    expect(buildCommitPermalink({ ...github, ownerOrOrg: "a/b" }, SHA)).toBeNull();
    expect(buildCommitPermalink({ ...github, repoName: null }, SHA)).toBeNull();
    expect(buildCommitPermalink(github, "HEAD")).toBeNull();
    expect(buildCommitPermalink(null, SHA)).toBeNull();
    expect(buildCommitPermalink({ ...github, provider: "github_enterprise" }, SHA)).toBeNull();
  });
});

describe("buildCodePermalink — one scheme per connector type", () => {
  it("github: a blob URL pinned to the commit, with the line range", () => {
    expect(buildCodePermalink(github, SHA, "src/a b.ts", 3, 9)).toBe(
      `https://github.com/acme/app/blob/${SHA}/src/a%20b.ts#L3-L9`,
    );
    expect(buildCodePermalink(github, SHA, "src/a.ts", 4, 4)).toBe(
      `https://github.com/acme/app/blob/${SHA}/src/a.ts#L4`,
    );
    expect(buildCodePermalink(github, SHA, "src/a.ts", null, null)).toBe(
      `https://github.com/acme/app/blob/${SHA}/src/a.ts`,
    );
  });

  it("github_enterprise: the same on the Enterprise web origin, never with the API path", () => {
    const ghe = {
      provider: "github_enterprise",
      ownerOrOrg: "acme",
      repoName: "app",
      apiBaseUrl: "https://ghe.example.com/api/v3",
    };
    expect(buildCodePermalink(ghe, SHA, "src/a.ts", 1, 2)).toBe(
      `https://ghe.example.com/acme/app/blob/${SHA}/src/a.ts#L1-L2`,
    );
    // Enterprise with no base URL has no knowable origin.
    expect(buildCodePermalink({ ...ghe, apiBaseUrl: null }, SHA, "src/a.ts", 1, 2)).toBeNull();
  });

  it("strips a credential embedded in the stored base URL (A01)", () => {
    const url = buildCodePermalink(
      {
        provider: "github_enterprise",
        ownerOrOrg: "acme",
        repoName: "app",
        apiBaseUrl: "https://user:s3cr3t-token@ghe.example.com/api/v3",
      },
      SHA,
      "src/a.ts",
      1,
      1,
    );
    expect(url).toBe(`https://ghe.example.com/acme/app/blob/${SHA}/src/a.ts#L1`);
    expect(url).not.toContain("s3cr3t");
    expect(url).not.toContain("@");
  });

  it.each(["gitlab", "local", "upload", "bitbucket"])(
    "%s: no link scheme, so null — never a guessed URL",
    (provider) => {
      expect(buildCodePermalink({ ...github, provider }, SHA, "src/a.ts", 1, 2)).toBeNull();
      // Even with an https base URL stored: a GitHub-shaped link on another
      // host's scheme would be a guess.
      const based = { ...github, provider, apiBaseUrl: "https://git.example.com/api/v4" };
      expect(buildCodePermalink(based, SHA, "src/a.ts", 1, 2)).toBeNull();
    },
  );

  it("is null without a commit (a link is pinned or not written) or with a non-SHA ref", () => {
    expect(buildCodePermalink(github, null, "src/a.ts", 1, 2)).toBeNull();
    expect(buildCodePermalink(github, "main", "src/a.ts", 1, 2)).toBeNull();
    expect(buildCodePermalink(null, SHA, "src/a.ts", 1, 2)).toBeNull();
  });

  it.each([
    "../etc/passwd",
    "src/../../x.ts",
    "/abs/x.ts",
    "javascript:alert(1)",
    "src\\x.ts",
    "src//x.ts",
    "a\u0000b",
    "",
  ])("refuses an unsafe path %j", (p) => {
    expect(buildCodePermalink(github, SHA, p, 1, 2)).toBeNull();
  });

  it("refuses owner or repository names that are not plain names", () => {
    expect(buildCodePermalink({ ...github, ownerOrOrg: "../x" }, SHA, "a.ts", 1, 1)).toBeNull();
    expect(buildCodePermalink({ ...github, repoName: null }, SHA, "a.ts", 1, 1)).toBeNull();
  });
});

describe("codeVersionIndexOf", () => {
  it("resolves each repository to its own graph's commit", () => {
    const idx = codeVersionIndexOf([
      { repoConnectionId: "r1", commitSha: SHA, repo: github },
      { repoConnectionId: "r2", commitSha: OTHER, repo: null },
    ]);
    expect(idx.forRepo("r1").commitSha).toBe(SHA);
    expect(idx.forRepo("r2").commitSha).toBe(OTHER);
    // Several graphs: an unknown or missing repository is not guessed.
    expect(idx.forRepo("r3").commitSha).toBeNull();
    expect(idx.forRepo(null).commitSha).toBeNull();
  });

  it("resolves a legacy graph with no connection when it is the project's only one", () => {
    const idx = codeVersionIndexOf([{ repoConnectionId: null, commitSha: SHA, repo: null }]);
    expect(idx.forRepo(null).commitSha).toBe(SHA);
    expect(idx.forRepo(undefined).commitSha).toBe(SHA);
  });

  it("does not lend the only graph's version to a repository the index does not hold", () => {
    // Repo A is indexed; repo B is still indexing (or its ingest failed).
    const idx = codeVersionIndexOf([{ repoConnectionId: "repoA", commitSha: SHA, repo: github }]);
    expect(idx.forRepo("repoA")).toEqual({ commitSha: SHA, repo: github });
    expect(idx.forRepo("repoB")).toEqual({ commitSha: null, repo: null });
    // So B's file gets no commit and no link into repo A.
    const ref = codeCitationRef({
      repoConnectionId: "repoB",
      path: "src/b-only.ts",
      startLine: 1,
      endLine: 5,
      version: idx.forRepo("repoB"),
    });
    expect(ref).toMatchObject({ repoConnectionId: "repoB", commitSha: null, permalink: null });
    // A hit whose repository was not read still resolves to the only graph.
    expect(idx.forRepo(null).commitSha).toBe(SHA);
  });

  it("knows nothing for a project with no index", () => {
    expect(NO_CODE_VERSIONS.forRepo("r1")).toEqual({ commitSha: null, repo: null });
  });
});

describe("versionOfGraph", () => {
  const conn = {
    provider: "github",
    ownerOrOrg: "acme",
    repoName: "app",
    apiBaseUrl: null,
    deletedAt: null,
    projectId: "p1",
  };

  it("lends the connector's coordinates only when it is live and in the project", () => {
    expect(versionOfGraph({ commitSha: SHA, repoConnection: conn }, "p1").repo).toEqual(github);
    expect(
      versionOfGraph({ commitSha: SHA, repoConnection: { ...conn, deletedAt: new Date() } }, "p1")
        .repo,
    ).toBeNull();
    expect(versionOfGraph({ commitSha: SHA, repoConnection: conn }, "p2").repo).toBeNull();
  });

  it("reads a commit that is not a SHA as unknown", () => {
    expect(versionOfGraph({ commitSha: "main" }, "p1").commitSha).toBeNull();
    expect(versionOfGraph({}, "p1")).toEqual({ commitSha: null, repo: null });
  });
});

describe("loadCodeVersions", () => {
  beforeEach(() => findMany.mockReset());

  it("reads the project's graphs only, newest first", async () => {
    findMany.mockResolvedValueOnce([
      {
        repoConnectionId: "r1",
        commitSha: SHA,
        repoConnection: { ...github, deletedAt: null, projectId: "p1" },
      },
    ]);
    const idx = await loadCodeVersions("p1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p1" }, orderBy: { lastIndexedAt: "desc" } }),
    );
    expect(idx.forRepo("r1")).toEqual({ commitSha: SHA, repo: github });
  });
});

describe("codeCitationRef", () => {
  it("builds the contract, with the permalink from the version", () => {
    expect(
      codeCitationRef({
        repoConnectionId: "r1",
        path: "src/a.ts",
        startLine: 1,
        endLine: 5,
        version: { commitSha: SHA, repo: github },
        matchedBy: ["lexical"],
      }),
    ).toEqual({
      repoConnectionId: "r1",
      path: "src/a.ts",
      startLine: 1,
      endLine: 5,
      commitSha: SHA,
      permalink: `https://github.com/acme/app/blob/${SHA}/src/a.ts#L1-L5`,
      matchedBy: ["lexical"],
      truncated: false,
      totalLines: null,
      stale: false,
    });
  });

  it("carries the working tree's commit only on a stale ref", () => {
    const v = { commitSha: SHA, repo: null };
    const base = {
      repoConnectionId: null,
      path: "a.ts",
      startLine: 1,
      endLine: 1,
      version: v,
      workingTreeSha: OTHER,
    };
    expect(codeCitationRef({ ...base, stale: true })).toMatchObject({
      stale: true,
      workingTreeSha: OTHER,
    });
    expect(codeCitationRef(base)).not.toHaveProperty("workingTreeSha");
  });
});

describe("formatCodeVersionLine", () => {
  const ref = (commitSha: string | null) =>
    codeCitationRef({
      repoConnectionId: null,
      path: "a.ts",
      startLine: 1,
      endLine: 1,
      version: { commitSha, repo: null },
    });

  it("names the commit once, however many locations share it", () => {
    expect(formatCodeVersionLine([ref(SHA), ref(SHA)])).toBe(
      "Code version: indexed commit 0123456789ab.",
    );
  });

  it("names every commit when the result spans repositories, and says when some are unknown", () => {
    expect(formatCodeVersionLine([ref(SHA), ref(OTHER), ref(null)])).toBe(
      "Code version: indexed commits 0123456789ab, fedcba987654 (some locations: unknown).",
    );
  });

  it("says the version is unknown when no commit is recorded, and is empty with no locations", () => {
    expect(formatCodeVersionLine([ref(null)])).toBe(
      "Code version: unknown (the index records no commit).",
    );
    expect(formatCodeVersionLine([])).toBe("");
  });
});
