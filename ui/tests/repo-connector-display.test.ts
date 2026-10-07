/**
 * Issue #364 — list wording for repository connectors.
 */
import { describe, expect, it } from "vitest";
import {
  isNonGitRepoProvider,
  isRepoRefOrEmpty,
  shortCommitSha,
  repoLocationLabel,
  repoStatusLabel,
  repoStatusTone,
} from "@/lib/repo-connector-display";
import { NON_GIT_REPO_PROVIDERS, REPO_PROVIDERS } from "@metis/shared";

const git = { provider: "github" as const, ownerOrOrg: "octocat", repoName: "hello" };

describe("isNonGitRepoProvider", () => {
  it.each([
    ["local", true],
    ["upload", true],
    ["github", false],
    ["github_enterprise", false],
    ["gitlab", false],
  ])("%s → %s", (provider, expected) => {
    expect(isNonGitRepoProvider(provider)).toBe(expected);
  });
});

describe("repoLocationLabel", () => {
  it("names a Git connector by owner/repo", () => {
    expect(repoLocationLabel({ ...git, hasLocalSource: false })).toBe("octocat/hello");
  });

  it("never prints null for a Git connector missing a part", () => {
    expect(
      repoLocationLabel({ ...git, ownerOrOrg: null, repoName: null, hasLocalSource: false }),
    ).toBe("—/—");
  });

  it("names a local directory, and says when its source is missing", () => {
    const local = { provider: "local" as const, ownerOrOrg: null, repoName: null };
    expect(repoLocationLabel({ ...local, hasLocalSource: true })).toBe("Local directory");
    expect(repoLocationLabel({ ...local, hasLocalSource: false })).toBe(
      "Local directory (no source)",
    );
  });

  it("names an uploaded archive", () => {
    expect(
      repoLocationLabel({
        provider: "upload",
        ownerOrOrg: null,
        repoName: null,
        hasLocalSource: false,
      }),
    ).toBe("Uploaded archive");
  });
});

describe("repoStatusLabel", () => {
  it("passes a Git connector's connection status through", () => {
    expect(repoStatusLabel({ provider: "github", status: "pending", lastIngestAt: null })).toBe(
      "pending",
    );
    expect(repoStatusLabel({ provider: "gitlab", status: "connected", lastIngestAt: null })).toBe(
      "connected",
    );
  });

  it.each([
    ["running", "ingesting"],
    ["completed", "ingested"],
    ["partial", "partially ingested"],
    ["failed", "ingest failed"],
    ["interrupted", "ingest interrupted"],
  ] as const)("reports a non-Git connector's %s source ingest as %s", (effectiveStatus, label) => {
    expect(
      repoStatusLabel({
        provider: "local",
        status: "pending",
        lastIngestAt: null,
        sourceIngest: { effectiveStatus },
      }),
    ).toBe(label);
  });

  it("falls back to lastIngestAt when no ingest outcome was recorded", () => {
    expect(
      repoStatusLabel({ provider: "upload", status: "pending", lastIngestAt: new Date() }),
    ).toBe("ingested");
    expect(repoStatusLabel({ provider: "upload", status: "pending", lastIngestAt: null })).toBe(
      "not ingested",
    );
  });

  it("keeps an error or disabled status for a non-Git connector", () => {
    const base = { provider: "local" as const, lastIngestAt: null, sourceIngest: null };
    expect(repoStatusLabel({ ...base, status: "error" })).toBe("error");
    expect(repoStatusLabel({ ...base, status: "disabled" })).toBe("disabled");
  });
});

describe("isNonGitRepoProvider follows the shared list", () => {
  it("agrees with NON_GIT_REPO_PROVIDERS for every provider", () => {
    for (const p of REPO_PROVIDERS) {
      expect(isNonGitRepoProvider(p)).toBe(
        (NON_GIT_REPO_PROVIDERS as readonly string[]).includes(p),
      );
    }
  });
});

describe("repoStatusTone", () => {
  it("leaves a Git connector to its connection status", () => {
    expect(repoStatusTone({ provider: "github", status: "error", lastIngestAt: null })).toBeNull();
  });

  it.each([
    ["running", "warning"],
    ["completed", "success"],
    ["partial", "warning"],
    ["failed", "destructive"],
    ["interrupted", "warning"],
  ] as const)("colours a non-Git %s ingest %s", (effectiveStatus, tone) => {
    expect(
      repoStatusTone({
        provider: "local",
        status: "pending",
        lastIngestAt: null,
        sourceIngest: { effectiveStatus },
      }),
    ).toBe(tone);
  });

  it("falls back like the label does", () => {
    const base = { provider: "upload" as const, sourceIngest: null };
    expect(repoStatusTone({ ...base, status: "pending", lastIngestAt: new Date() })).toBe(
      "success",
    );
    expect(repoStatusTone({ ...base, status: "pending", lastIngestAt: null })).toBe("neutral");
    expect(repoStatusTone({ ...base, status: "error", lastIngestAt: null })).toBe("destructive");
    expect(repoStatusTone({ ...base, status: "disabled", lastIngestAt: null })).toBe("neutral");
  });
});

describe("#714 — ref and commit display helpers", () => {
  it("accepts an empty ref, a branch, a slashed branch and a tag", () => {
    for (const v of ["", "  ", "main", "release/1.x", "v2.3.3"]) {
      expect(isRepoRefOrEmpty(v)).toBe(true);
    }
  });

  it("rejects refs the server would reject", () => {
    for (const v of ["-x", "has space", "a;rm", "x".repeat(129)]) {
      expect(isRepoRefOrEmpty(v)).toBe(false);
    }
  });

  it("shortens a commit SHA to 7 characters", () => {
    expect(shortCommitSha("c4d54f87a81b30aa173fddf05d7ff83ae7da5796")).toBe("c4d54f8");
  });
});
