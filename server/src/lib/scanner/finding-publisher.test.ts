/** Epic #708 / Issue #715 — finding-publisher tests. */
import { describe, expect, it, vi } from "vitest";
import {
  type FindingPayload,
  type PublisherPorts,
  PublishError,
  buildFindingMarker,
  injectFindingMarker,
  parseFindingMarker,
  publishFinding,
} from "./finding-publisher.js";

const FP = "a".repeat(64);

function payload(overrides: Partial<FindingPayload> = {}): FindingPayload {
  return {
    fingerprint: FP,
    scanFindingId: "sf-1",
    scanId: "scan-1",
    projectId: "p1",
    repoConnectionId: "r1",
    title: "raw SQL",
    body: "uses concat\n\nMore detail.",
    severity: "high",
    category: "security",
    filePath: "src/foo.ts",
    evidenceLines: [12, 13],
    qualifiedName: "src/foo.ts::bar",
    ruleId: "rule-1",
    commitSha: "abc123",
    ...overrides,
  };
}

function ports(overrides: Partial<PublisherPorts> = {}): PublisherPorts {
  return {
    currentRepoCommitSha: vi.fn().mockResolvedValue("abc123"),
    findExistingLink: vi.fn().mockResolvedValue(null),
    createGitHubIssue: vi
      .fn()
      .mockResolvedValue({ externalId: "123", externalUrl: "https://gh/1" }),
    createJiraIssue: vi
      .fn()
      .mockResolvedValue({ externalId: "PROJ-1", externalUrl: "https://jira/PROJ-1" }),
    saveLink: vi.fn().mockImplementation(async (args) => ({
      id: "link-1",
      scanFindingId: args.scanFindingId,
      provider: args.provider,
      externalId: args.externalId,
      externalUrl: args.externalUrl,
    })),
    audit: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("marker helpers", () => {
  it("builds and parses a fingerprint marker", () => {
    const m = buildFindingMarker(FP);
    expect(m).toContain("metis-finding");
    expect(m).toContain(FP);
    expect(parseFindingMarker(m)?.fingerprint).toBe(FP);
  });
  it("returns null for missing or malformed marker", () => {
    expect(parseFindingMarker(null)).toBeNull();
    expect(parseFindingMarker("no marker here")).toBeNull();
    expect(parseFindingMarker("<!-- metis-finding: fingerprint=bad -->")).toBeNull();
  });
  it("injectFindingMarker replaces existing markers (no duplication)", () => {
    const body = injectFindingMarker("Body text.", FP);
    const doubled = injectFindingMarker(body, FP);
    const occurrences = doubled.split("metis-finding").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("publishFinding", () => {
  it("creates a GitHub issue and saves IssueLink", async () => {
    const p = ports();
    const out = await publishFinding(p, { finding: payload(), provider: "github" });
    expect(out.reused).toBe(false);
    expect(out.link.externalUrl).toBe("https://gh/1");
    expect(p.createGitHubIssue).toHaveBeenCalledTimes(1);
    const body = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(body).toContain("metis-finding");
    expect(body).toContain(FP);
    const labels = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    expect(labels).toContain("metis-scanner");
    expect(labels).toContain("severity:high");
    expect(labels).toContain("rule:rule-1");
  });

  it("creates a Jira issue when provider=jira", async () => {
    const p = ports();
    const out = await publishFinding(p, { finding: payload(), provider: "jira" });
    expect(out.link.externalUrl).toBe("https://jira/PROJ-1");
    expect(p.createJiraIssue).toHaveBeenCalledTimes(1);
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
  });

  it("returns existing link without calling the provider (idempotent)", async () => {
    const p = ports({
      findExistingLink: vi.fn().mockResolvedValue({
        id: "L1",
        scanFindingId: "sf-1",
        provider: "github",
        externalId: "999",
        externalUrl: "https://gh/999",
      }),
    });
    const out = await publishFinding(p, { finding: payload(), provider: "github" });
    expect(out.reused).toBe(true);
    expect(out.link.externalUrl).toBe("https://gh/999");
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
    expect(p.saveLink).not.toHaveBeenCalled();
  });

  it("vetoes on stale commit and throws ERR_STALE_COMMIT", async () => {
    const p = ports({ currentRepoCommitSha: vi.fn().mockResolvedValue("deadbeef") });
    await expect(
      publishFinding(p, { finding: payload(), provider: "github" }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
  });

  it("rejects when the scan has no captured commit SHA (empty string)", async () => {
    const p = ports({ currentRepoCommitSha: vi.fn().mockResolvedValue("abc123") });
    await expect(
      publishFinding(p, { finding: payload({ commitSha: "" }), provider: "github" }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
  });

  it("rejects when the repo currently has no commit SHA (null)", async () => {
    const p = ports({ currentRepoCommitSha: vi.fn().mockResolvedValue(null) });
    await expect(
      publishFinding(p, { finding: payload(), provider: "github" }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
  });

  it("does NOT bypass the gate when both sides are empty strings", async () => {
    // Regression: an empty-vs-empty comparison must NOT publish — that would
    // let an unanchored scan create issues with no provenance.
    const p = ports({ currentRepoCommitSha: vi.fn().mockResolvedValue("") });
    await expect(
      publishFinding(p, { finding: payload({ commitSha: "" }), provider: "github" }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
  });

  it("dedupes labels and accepts extras", async () => {
    const p = ports();
    await publishFinding(p, {
      finding: payload(),
      provider: "github",
      extraLabels: ["bug", "metis-scanner", " "],
    });
    const labels = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    const count = labels.filter((l: string) => l === "metis-scanner").length;
    expect(count).toBe(1);
    expect(labels).toContain("bug");
  });

  it("audits create + reuse paths", async () => {
    const reusePorts = ports({
      findExistingLink: vi.fn().mockResolvedValue({
        id: "L1",
        scanFindingId: "sf-1",
        provider: "github",
        externalId: "9",
        externalUrl: "u",
      }),
    });
    await publishFinding(reusePorts, { finding: payload(), provider: "github" });
    expect(reusePorts.audit).toHaveBeenCalledWith(
      "scanner.publish.reused",
      "sf-1",
      expect.objectContaining({ provider: "github" }),
    );

    const createPorts = ports();
    await publishFinding(createPorts, { finding: payload(), provider: "github" });
    expect(createPorts.audit).toHaveBeenCalledWith(
      "scanner.publish.created",
      "sf-1",
      expect.objectContaining({ provider: "github" }),
    );
  });
});
