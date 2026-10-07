/**
 * #728 — link a finding's code citation to its GitHub blob at the connector ref.
 */
import { describe, expect, it } from "vitest";
import {
  buildCodeCitationBlobUrl,
  githubWebOrigin,
  selectCodeCitationRepo,
  type CodeCitationRepo,
  type CodeCitationRepoSource,
} from "./code-citation-blob-url";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function connector(over: Partial<CodeCitationRepoSource> = {}): CodeCitationRepoSource {
  return {
    provider: "github",
    ownerOrOrg: "miniflux",
    repoName: "v2",
    defaultBranch: "v2.3.3",
    apiBaseUrl: null,
    lastCommitSha: null,
    deletedAt: null,
    ...over,
  };
}

const repo: CodeCitationRepo = {
  origin: "https://github.com",
  owner: "miniflux",
  repo: "v2",
  ref: "v2.3.3",
};

describe("githubWebOrigin", () => {
  it("is github.com for a github connector without a base URL", () => {
    expect(githubWebOrigin("github", null)).toBe("https://github.com");
  });

  it("maps the public API host back to github.com", () => {
    expect(githubWebOrigin("github", "https://api.github.com")).toBe("https://github.com");
  });

  it("uses the GitHub Enterprise origin, dropping /api/v3 and credentials", () => {
    expect(githubWebOrigin("github_enterprise", "https://ghe.example.com/api/v3")).toBe(
      "https://ghe.example.com",
    );
    expect(githubWebOrigin("github_enterprise", "https://u:p@ghe.example.com:8443/api/v3")).toBe(
      "https://ghe.example.com:8443",
    );
  });

  it("is null for an enterprise connector with no base URL, a non-https URL or junk", () => {
    expect(githubWebOrigin("github_enterprise", null)).toBeNull();
    expect(githubWebOrigin("github_enterprise", "http://ghe.example.com")).toBeNull();
    expect(githubWebOrigin("github_enterprise", "javascript:alert(1)")).toBeNull();
    expect(githubWebOrigin("github_enterprise", "not a url")).toBeNull();
  });

  it("is null for a non-GitHub provider", () => {
    expect(githubWebOrigin("gitlab", null)).toBeNull();
    expect(githubWebOrigin("local", null)).toBeNull();
  });
});

describe("selectCodeCitationRepo", () => {
  it("picks the project's single GitHub connector, at its branch/ref", () => {
    expect(selectCodeCitationRepo([connector()])).toEqual(repo);
  });

  it("prefers the recorded commit SHA over the branch", () => {
    expect(selectCodeCitationRepo([connector({ lastCommitSha: SHA })])?.ref).toBe(SHA);
  });

  it("ignores a malformed SHA and falls back to the branch", () => {
    expect(selectCodeCitationRepo([connector({ lastCommitSha: "not-a-sha" })])?.ref).toBe("v2.3.3");
  });

  it("supports GitHub Enterprise connectors", () => {
    expect(
      selectCodeCitationRepo([
        connector({ provider: "github_enterprise", apiBaseUrl: "https://ghe.example.com/api/v3" }),
      ])?.origin,
    ).toBe("https://ghe.example.com");
  });

  it("ignores non-GitHub and deleted connectors", () => {
    expect(
      selectCodeCitationRepo([
        connector(),
        connector({ provider: "local", ownerOrOrg: null, repoName: null }),
        connector({ provider: "gitlab", repoName: "other" }),
        connector({ repoName: "gone", deletedAt: "2026-01-01T00:00:00.000Z" }),
      ]),
    ).toEqual(repo);
  });

  it("is null when the project has zero or several GitHub repos (ambiguous)", () => {
    expect(selectCodeCitationRepo([])).toBeNull();
    expect(selectCodeCitationRepo(undefined)).toBeNull();
    expect(selectCodeCitationRepo([connector(), connector({ repoName: "other" })])).toBeNull();
  });

  it("is null when owner or repo name is missing", () => {
    expect(selectCodeCitationRepo([connector({ ownerOrOrg: null })])).toBeNull();
    expect(selectCodeCitationRepo([connector({ repoName: null })])).toBeNull();
  });
});

describe("buildCodeCitationBlobUrl", () => {
  it("links a line range", () => {
    expect(
      buildCodeCitationBlobUrl(repo, {
        filePath: "internal/reader/feed.go",
        startLine: 10,
        endLine: 42,
      }),
    ).toBe("https://github.com/miniflux/v2/blob/v2.3.3/internal/reader/feed.go#L10-L42");
  });

  it("links a single line as #L<n>", () => {
    expect(buildCodeCitationBlobUrl(repo, { filePath: "a.go", startLine: 7, endLine: 7 })).toBe(
      "https://github.com/miniflux/v2/blob/v2.3.3/a.go#L7",
    );
  });

  it("omits the fragment for unusable line numbers", () => {
    expect(buildCodeCitationBlobUrl(repo, { filePath: "a.go", startLine: 0, endLine: 0 })).toBe(
      "https://github.com/miniflux/v2/blob/v2.3.3/a.go",
    );
    expect(buildCodeCitationBlobUrl(repo, { filePath: "a.go", startLine: 9, endLine: 3 })).toBe(
      "https://github.com/miniflux/v2/blob/v2.3.3/a.go#L9",
    );
  });

  it("URL-encodes each path and ref segment but keeps the slashes", () => {
    expect(
      buildCodeCitationBlobUrl(
        { ...repo, ref: "release/1.0" },
        { filePath: "docs/my file#1?.md", startLine: 1, endLine: 2 },
      ),
    ).toBe("https://github.com/miniflux/v2/blob/release/1.0/docs/my%20file%231%3F.md#L1-L2");
  });

  it("leaves a leading src/ in place (it is a real directory here)", () => {
    expect(buildCodeCitationBlobUrl(repo, { filePath: "src/a.ts", startLine: 1, endLine: 1 })).toBe(
      "https://github.com/miniflux/v2/blob/v2.3.3/src/a.ts#L1",
    );
  });

  it.each([
    "../etc/passwd",
    "a/../../b",
    "./a.go",
    "/abs/path.go",
    "\\\\server\\share",
    "a\\b.go",
    "https://evil.example.com/x",
    "javascript:alert(1)",
    "//evil.example.com/x",
    "a//b.go",
    "",
    "a\u0000b",
  ])("refuses to link the unsafe path %j", (filePath) => {
    expect(buildCodeCitationBlobUrl(repo, { filePath, startLine: 1, endLine: 1 })).toBeNull();
  });

  it("is null without a repo", () => {
    expect(
      buildCodeCitationBlobUrl(null, { filePath: "a.go", startLine: 1, endLine: 1 }),
    ).toBeNull();
  });
});
