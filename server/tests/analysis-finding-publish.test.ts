/**
 * Unit tests for the analysis-finding publishing adapter (Epic #176 / #179).
 *
 *   - buildAnalysisFindingBody: deterministic markdown + persona attribution.
 *   - publishAnalysisFinding: destination resolution (GitHub repo connection /
 *     Jira), payload construction, label merge, and the analysis-specific
 *     PublisherPorts (idempotency keyed on IssueLink.findingId, stale-commit
 *     anchor no-op).
 *
 * The generic finding-publisher engine is mocked so we can assert exactly what
 * the adapter hands it (ports + payload) without booting Octokit / Jira / vault.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FindingIssueDraft } from "@metis/shared";
import type {
  ExistingIssueLink,
  PublisherPorts,
  PublishInput,
} from "../src/lib/scanner/finding-publisher.js";

const issueLink = {
  findFirst: vi.fn(),
  upsert: vi.fn(),
};
const repoConnection = {
  findFirst: vi.fn(),
};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    get issueLink() {
      return issueLink;
    },
    get repoConnection() {
      return repoConnection;
    },
  },
}));

// Capture the (ports, input) the adapter passes to the generic engine.
let captured: { ports: PublisherPorts; input: PublishInput } | null = null;
const fakeLink: ExistingIssueLink = {
  id: "link_1",
  scanFindingId: "find_1",
  provider: "github",
  externalId: "42",
  externalUrl: "https://github.com/acme/app/issues/42",
};

vi.mock("../src/lib/scanner/finding-publisher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/scanner/finding-publisher.js")>();
  return {
    ...actual,
    publishFinding: vi.fn(async (ports: PublisherPorts, input: PublishInput) => {
      captured = { ports, input };
      return { link: fakeLink, reused: false, staleCommit: false };
    }),
  };
});

import {
  buildAnalysisFindingBody,
  publishAnalysisFinding,
} from "../src/lib/scanner/prisma-adapter.js";

const DRAFT: FindingIssueDraft = {
  title: "Add audit logging to all mutations",
  problemStatement: "Mutations are not audited, which fails the compliance requirement.",
  affected: { files: ["src/routes/users.ts", "src/lib/db.ts"], requirementIds: ["REQ-12"] },
  acceptanceCriteria: ["Every mutation writes an AuditLog row", "Logs are queryable"],
  suggestedLabels: ["security", "compliance"],
};

beforeEach(() => {
  captured = null;
  issueLink.findFirst.mockReset();
  issueLink.upsert.mockReset();
  repoConnection.findFirst.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("buildAnalysisFindingBody", () => {
  it("renders sections, checkbox acceptance criteria, and persona attribution", () => {
    const body = buildAnalysisFindingBody({
      analysisId: "ana_1",
      agentKey: "code",
      draft: DRAFT,
    });
    expect(body).toContain("Mutations are not audited");
    expect(body).toContain("### Affected files");
    expect(body).toContain("- `src/routes/users.ts`");
    expect(body).toContain("### Related requirements");
    expect(body).toContain("- REQ-12");
    expect(body).toContain("### Acceptance criteria");
    expect(body).toContain("- [ ] Every mutation writes an AuditLog row");
    // Persona footer (code → Winston / Solution Architect) + analysis back-link.
    expect(body).toContain("From METIS analysis `ana_1`");
    expect(body).toContain("Winston");
  });

  it("omits empty sections", () => {
    const body = buildAnalysisFindingBody({
      analysisId: "ana_2",
      agentKey: "database",
      draft: {
        title: "t",
        problemStatement: "just a statement",
        affected: { files: [], requirementIds: [] },
        acceptanceCriteria: [],
        suggestedLabels: [],
      },
    });
    expect(body).not.toContain("### Affected files");
    expect(body).not.toContain("### Acceptance criteria");
    expect(body).toContain("just a statement");
  });
});

describe("publishAnalysisFinding", () => {
  it("resolves the project's primary repo connection and delegates to publishFinding (github)", async () => {
    repoConnection.findFirst.mockResolvedValue({ id: "repo_1" });

    const link = await publishAnalysisFinding({
      projectId: "proj_1",
      analysisId: "ana_1",
      findingId: "find_1",
      agentKey: "code",
      severity: "high",
      category: "security",
      draft: DRAFT,
      provider: "github",
      extraLabels: ["triaged"],
    });

    expect(link).toEqual(fakeLink);
    expect(repoConnection.findFirst).toHaveBeenCalledTimes(1);
    const where = repoConnection.findFirst.mock.calls[0][0].where;
    expect(where.projectId).toBe("proj_1");
    expect(where.status.in).toContain("connected");

    expect(captured).not.toBeNull();
    const { input } = captured!;
    expect(input.provider).toBe("github");
    expect(input.finding.repoConnectionId).toBe("repo_1");
    expect(input.finding.scanFindingId).toBe("find_1");
    expect(input.finding.title).toBe(DRAFT.title);
    // Suggested labels + caller extras are merged.
    expect(input.extraLabels).toEqual(["security", "compliance", "triaged"]);
  });

  it("throws ERR_NOT_IMPLEMENTED when the project has no connected repo (github)", async () => {
    repoConnection.findFirst.mockResolvedValue(null);
    await expect(
      publishAnalysisFinding({
        projectId: "proj_1",
        analysisId: "ana_1",
        findingId: "find_1",
        agentKey: "code",
        severity: "high",
        category: "security",
        draft: DRAFT,
        provider: "github",
      }),
    ).rejects.toMatchObject({ code: "ERR_NOT_IMPLEMENTED" });
    expect(captured).toBeNull();
  });

  it("does not require a repo connection for jira", async () => {
    await publishAnalysisFinding({
      projectId: "proj_1",
      analysisId: "ana_1",
      findingId: "find_1",
      agentKey: "code",
      severity: "low",
      category: "quality",
      draft: DRAFT,
      provider: "jira",
    });
    expect(repoConnection.findFirst).not.toHaveBeenCalled();
    expect(captured!.input.finding.repoConnectionId).toBe("");
    expect(captured!.input.provider).toBe("jira");
  });

  it("uses analysis-specific PublisherPorts keyed on IssueLink.findingId", async () => {
    repoConnection.findFirst.mockResolvedValue({ id: "repo_1" });
    await publishAnalysisFinding({
      projectId: "proj_1",
      analysisId: "ana_1",
      findingId: "find_1",
      agentKey: "code",
      severity: "high",
      category: "security",
      draft: DRAFT,
      provider: "github",
    });
    const { ports } = captured!;

    // Stale-commit gate is a no-op: anchor equals payload commitSha.
    expect(await ports.currentRepoCommitSha("proj_1", "repo_1")).toBe(
      captured!.input.finding.commitSha,
    );

    // findExistingLink queries by findingId (not scanFindingId).
    issueLink.findFirst.mockResolvedValue(null);
    const none = await ports.findExistingLink("find_1", "github");
    expect(none).toBeNull();
    expect(issueLink.findFirst).toHaveBeenCalledWith({
      where: { findingId: "find_1", provider: "github" },
    });

    issueLink.findFirst.mockResolvedValue({
      id: "link_9",
      findingId: "find_1",
      provider: "github",
      externalId: "9",
      externalUrl: "u",
    });
    const found = await ports.findExistingLink("find_1", "github");
    expect(found?.scanFindingId).toBe("find_1");

    // saveLink upserts on the findingId_provider composite.
    issueLink.upsert.mockResolvedValue({
      id: "link_2",
      findingId: "find_1",
      provider: "github",
      externalId: "7",
      externalUrl: "v",
    });
    const saved = await ports.saveLink({
      scanFindingId: "find_1",
      provider: "github",
      externalId: "7",
      externalUrl: "v",
      fingerprint: "fp",
    });
    expect(saved.scanFindingId).toBe("find_1");
    const upsertArg = issueLink.upsert.mock.calls[0][0];
    expect(upsertArg.where.findingId_provider).toEqual({
      findingId: "find_1",
      provider: "github",
    });
    expect(upsertArg.create.findingId).toBe("find_1");
  });
});
