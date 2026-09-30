/**
 * Issue #364 — list wording for repository connectors.
 */
import { describe, expect, it } from "vitest";
import {
  isNonGitRepoProvider,
  repoLocationLabel,
  repoStatusLabel,
} from "@/lib/repo-connector-display";

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
