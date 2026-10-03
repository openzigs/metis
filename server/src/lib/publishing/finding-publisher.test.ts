/** Epic #708 / Issue #715 / #804 — finding-publisher tests. */
import { describe, expect, it, vi } from "vitest";
import {
  type FindingPayload,
  type PublisherPorts,
  buildFindingMarker,
  injectFindingMarker,
  parseFindingMarker,
  publishFinding,
} from "./finding-publisher.js";

const FP = "a".repeat(64);

function payload(overrides: Partial<FindingPayload> = {}): FindingPayload {
  return {
    fingerprint: FP,
    sourceId: "sf-1",
    projectId: "p1",
    repoConnectionId: "r1",
    title: "raw SQL",
    body: "uses concat\n\nMore detail.",
    severity: "high",
    category: "security",
    ...overrides,
  };
}

function ports(overrides: Partial<PublisherPorts> = {}): PublisherPorts {
  return {
    findExistingLink: vi.fn().mockResolvedValue(null),
    createGitHubIssue: vi
      .fn()
      .mockResolvedValue({ externalId: "123", externalUrl: "https://gh/1" }),
    createJiraIssue: vi
      .fn()
      .mockResolvedValue({ externalId: "PROJ-1", externalUrl: "https://jira/PROJ-1" }),
    saveLink: vi.fn().mockImplementation(async (args) => ({
      id: "link-1",
      sourceId: args.sourceId,
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
  it("#733 — hands an explicit target to createGitHubIssue", async () => {
    const p = ports();
    await publishFinding(p, {
      finding: payload({ target: { owner: "openzigs", repo: "flux-v2" } }),
      provider: "github",
      sourceLabel: "metis-analysis",
    });
    const args = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.target).toEqual({ owner: "openzigs", repo: "flux-v2" });
  });

  it("#733 — passes no target when the finding carries none", async () => {
    const p = ports();
    await publishFinding(p, {
      finding: payload(),
      provider: "github",
      sourceLabel: "metis-analysis",
    });
    const args = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect("target" in args).toBe(false);
  });

  it("creates a GitHub issue and saves IssueLink", async () => {
    const p = ports();
    const out = await publishFinding(p, {
      finding: payload(),
      provider: "github",
      sourceLabel: "metis-analysis",
    });
    expect(out.reused).toBe(false);
    expect(out.link.externalUrl).toBe("https://gh/1");
    expect(p.createGitHubIssue).toHaveBeenCalledTimes(1);
    const body = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].body;
    expect(body).toContain("metis-finding");
    expect(body).toContain(FP);
    const labels = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    expect(labels).toContain("metis");
    expect(labels).toContain("metis-analysis");
    expect(labels).toContain("severity:high");
    expect(labels.some((l: string) => l.startsWith("rule:"))).toBe(false);
  });

  it("creates a Jira issue when provider=jira", async () => {
    const p = ports();
    const out = await publishFinding(p, {
      finding: payload(),
      provider: "jira",
      sourceLabel: "metis-analysis",
    });
    expect(out.link.externalUrl).toBe("https://jira/PROJ-1");
    expect(p.createJiraIssue).toHaveBeenCalledTimes(1);
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
  });

  it("returns existing link without calling the provider (idempotent)", async () => {
    const p = ports({
      findExistingLink: vi.fn().mockResolvedValue({
        id: "L1",
        sourceId: "sf-1",
        provider: "github",
        externalId: "999",
        externalUrl: "https://gh/999",
      }),
    });
    const out = await publishFinding(p, {
      finding: payload(),
      provider: "github",
      sourceLabel: "metis-analysis",
    });
    expect(out.reused).toBe(true);
    expect(out.link.externalUrl).toBe("https://gh/999");
    expect(p.createGitHubIssue).not.toHaveBeenCalled();
    expect(p.saveLink).not.toHaveBeenCalled();
  });

  it("#804 — has no stale-commit gate: an unanchored finding publishes", async () => {
    const p = ports();
    const out = await publishFinding(p, {
      finding: payload(),
      provider: "github",
      sourceLabel: "metis-analysis",
    });
    expect(out).toEqual({
      link: expect.objectContaining({ externalUrl: "https://gh/1" }),
      reused: false,
    });
    expect(p.createGitHubIssue).toHaveBeenCalledTimes(1);
  });

  it("#802 — the source label comes from the caller, not a hard-coded default", async () => {
    const p = ports();
    await publishFinding(p, {
      finding: payload(),
      provider: "github",
      sourceLabel: "metis-analysis",
    });
    const labels = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    expect(labels).toContain("metis-analysis");
    expect(labels).not.toContain("metis-impact-analysis");
  });

  it("dedupes labels and accepts extras", async () => {
    const p = ports();
    await publishFinding(p, {
      finding: payload(),
      provider: "github",
      sourceLabel: "metis-analysis",
      extraLabels: ["bug", "metis-analysis", " "],
    });
    const labels = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    const count = labels.filter((l: string) => l === "metis-analysis").length;
    expect(count).toBe(1);
    expect(labels).toContain("bug");
  });

  it("#802 — always adds the umbrella metis label next to the source label, once", async () => {
    const p = ports();
    await publishFinding(p, {
      finding: payload(),
      provider: "jira",
      sourceLabel: "metis-impact-analysis",
      extraLabels: ["metis", " metis ", "METIS"],
    });
    const labels = (p.createJiraIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    expect(labels.filter((l: string) => l.toLowerCase() === "metis")).toEqual(["metis"]);
    expect(labels.slice(0, 2)).toEqual(["metis", "metis-impact-analysis"]);
  });

  it("#802 — drops reserved source labels from extras: only the caller's own survives", async () => {
    const p = ports();
    await publishFinding(p, {
      finding: payload(),
      provider: "github",
      sourceLabel: "metis-analysis",
      extraLabels: ["metis-scanner", "metis-impact-analysis", " METIS-Scanner ", "bug"],
    });
    const labels = (p.createGitHubIssue as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
    expect(labels).toEqual([
      "metis",
      "metis-analysis",
      "severity:high",
      "category:security",
      "bug",
    ]);
  });

  it.each(["github", "jira"] as const)(
    "#804 — audits a %s create and reuse under source-neutral action names",
    async (provider) => {
      const reusePorts = ports({
        findExistingLink: vi.fn().mockResolvedValue({
          id: "L1",
          sourceId: "sf-1",
          provider,
          externalId: "9",
          externalUrl: "u",
        }),
      });
      await publishFinding(reusePorts, {
        finding: payload(),
        provider,
        sourceLabel: "metis-analysis",
      });
      expect(reusePorts.audit).toHaveBeenCalledExactlyOnceWith(
        `publish.${provider}.reused`,
        "sf-1",
        { provider, externalUrl: "u" },
      );

      const createPorts = ports();
      await publishFinding(createPorts, {
        finding: payload(),
        provider,
        sourceLabel: "metis-analysis",
      });
      const created = provider === "github" ? "https://gh/1" : "https://jira/PROJ-1";
      expect(createPorts.audit).toHaveBeenCalledExactlyOnceWith(
        `publish.${provider}.created`,
        "sf-1",
        expect.objectContaining({ provider, externalUrl: created }),
      );
      expect(createPorts.saveLink).toHaveBeenCalledWith(
        expect.objectContaining({ sourceId: "sf-1", provider, fingerprint: FP }),
      );
    },
  );
});
