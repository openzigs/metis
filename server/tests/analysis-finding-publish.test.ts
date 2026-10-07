/**
 * Unit tests for the analysis-finding publishing adapter (Epic #176 / #179).
 *
 *   - buildAnalysisFindingBody: deterministic markdown + persona attribution.
 *   - publishAnalysisFinding: destination resolution (GitHub repo connection /
 *     Jira), payload construction, label merge, and the analysis-specific
 *     PublisherPorts (idempotency keyed on IssueLink.findingId).
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
} from "../src/lib/publishing/finding-publisher.js";

const issueLink = {
  findFirst: vi.fn(),
  upsert: vi.fn(),
};
const repoConnection = {
  findFirst: vi.fn(),
};
const project = {
  findUnique: vi.fn(),
};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    get issueLink() {
      return issueLink;
    },
    get repoConnection() {
      return repoConnection;
    },
    get project() {
      return project;
    },
  },
}));

// Capture the (ports, input) the adapter passes to the generic engine.
let captured: { ports: PublisherPorts; input: PublishInput } | null = null;
const fakeLink: ExistingIssueLink = {
  id: "link_1",
  sourceId: "find_1",
  provider: "github",
  externalId: "42",
  externalUrl: "https://github.com/acme/app/issues/42",
};

vi.mock("../src/lib/publishing/finding-publisher.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/publishing/finding-publisher.js")>();
  return {
    ...actual,
    publishFinding: vi.fn(async (ports: PublisherPorts, input: PublishInput) => {
      captured = { ports, input };
      return { link: fakeLink, reused: false };
    }),
  };
});

import {
  buildAnalysisFindingBody,
  publishAnalysisFinding,
} from "../src/lib/publishing/analysis-finding-publish.js";

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
  project.findUnique.mockReset();
  // #733 — a configured GitHub publish target, unless a test says otherwise.
  project.findUnique.mockResolvedValue({
    publishGithubOwner: "openzigs",
    publishGithubRepo: "flux-v2",
  });
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

  it("#338 — attributes an agent-phase finding to its agent, not the code persona", () => {
    const body = buildAnalysisFindingBody({
      analysisId: "ana_3",
      agentKey: "code",
      agentSource: { kind: "custom", ref: "custom:c1", name: "Threat Modeller" },
      draft: DRAFT,
    });
    expect(body).toContain(
      "From METIS analysis `ana_3` · reported by **Threat Modeller** (custom agent `custom:c1`).",
    );
    expect(body).not.toContain("Winston");
  });

  it("#338 — names a library agent as one", () => {
    const body = buildAnalysisFindingBody({
      analysisId: "ana_4",
      agentKey: "code",
      agentSource: { kind: "library", ref: "library:owasp", name: "OWASP Auditor" },
      draft: DRAFT,
    });
    expect(body).toContain("reported by **OWASP Auditor** (library agent `library:owasp`).");
  });

  it("#338 — neutralises markdown in the operator-authored agent name", () => {
    const body = buildAnalysisFindingBody({
      analysisId: "ana_5",
      agentKey: "code",
      agentSource: {
        kind: "custom",
        ref: "custom:c9",
        name: "Evil** [click](https://x.example) @team\n# Heading <img src=x>",
      },
      draft: DRAFT,
    });
    const footer = body.split("\n").at(-1)!;
    // Every metacharacter is backslash-escaped, so none survives unescaped.
    expect(footer).not.toMatch(/(^|[^\\])\[click\]/);
    expect(footer).not.toMatch(/(^|[^\\])<img/);
    expect(footer).not.toMatch(/(^|[^\\])@team/);
    expect(body).not.toContain("\n# Heading");
    expect(footer).toContain("\\*\\*");
  });

  it("#338 — escapes & so an HTML entity cannot spell a mention", () => {
    const body = buildAnalysisFindingBody({
      analysisId: "ana_6",
      agentKey: "code",
      agentSource: { kind: "custom", ref: "custom:c9", name: "&#64;org/team" },
      draft: DRAFT,
    });
    const footer = body.split("\n").at(-1)!;
    // GitHub decodes entities before mention parsing: &#64; would become @.
    expect(footer).not.toMatch(/(^|[^\\])&#64;/);
    expect(footer).toContain("\\&\\#64;");
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
    expect(input.finding.sourceId).toBe("find_1");
    expect(input.finding.title).toBe(DRAFT.title);
    // Suggested labels + caller extras are merged.
    expect(input.extraLabels).toEqual(["security", "compliance", "triaged"]);
    // #733 — filed into the configured target, not the connector's repo.
    expect(input.finding.target).toEqual({ owner: "openzigs", repo: "flux-v2" });
    expect(project.findUnique.mock.calls[0][0].where).toEqual({ id: "proj_1" });
  });

  it("#733 — an explicit target wins over the configured one", async () => {
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
      target: { owner: "me", repo: "sandbox" },
    });
    expect(captured!.input.finding.target).toEqual({ owner: "me", repo: "sandbox" });
    expect(project.findUnique).not.toHaveBeenCalled();
  });

  // The refusal itself happens in createGitHubIssue, AFTER the engine's existing-link
  // check, so a re-publish still gets its link back. This suite mocks the engine, so
  // it pins what reaches it: no target at all — never the connector's repository.
  // End-to-end refusal + re-publish: prisma-adapter.test.ts.
  it("#733 — with no explicit or configured target, hands the engine NO target (no connector fallback)", async () => {
    repoConnection.findFirst.mockResolvedValue({ id: "repo_1" });
    project.findUnique.mockResolvedValue({ publishGithubOwner: null, publishGithubRepo: null });
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
    expect(captured!.input.finding.target).toBeUndefined();
  });

  it("#733 — a half-configured target is no target", async () => {
    project.findUnique.mockResolvedValue({
      publishGithubOwner: "openzigs",
      publishGithubRepo: null,
    });
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
    expect(captured!.input.finding.target).toBeUndefined();
  });

  it("#338 — carries an agent-phase finding's agent into the published body", async () => {
    await publishAnalysisFinding({
      projectId: "proj_1",
      analysisId: "ana_1",
      findingId: "find_1",
      agentKey: "code",
      agentSource: { kind: "library", ref: "library:owasp", name: "OWASP Auditor" },
      severity: "high",
      category: "security",
      draft: DRAFT,
      provider: "jira",
    });
    expect(captured!.input.finding.body).toContain("reported by **OWASP Auditor**");
    expect(captured!.input.finding.body).not.toContain("Winston");
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
    expect(project.findUnique).not.toHaveBeenCalled();
    expect(captured!.input.finding.target).toBeUndefined();
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

    // #804 — the engine has no stale-commit port any more.
    expect("currentRepoCommitSha" in ports).toBe(false);

    // findExistingLink queries by findingId.
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
    expect(found?.sourceId).toBe("find_1");

    // saveLink upserts on the findingId_provider composite.
    issueLink.upsert.mockResolvedValue({
      id: "link_2",
      findingId: "find_1",
      provider: "github",
      externalId: "7",
      externalUrl: "v",
    });
    const saved = await ports.saveLink({
      sourceId: "find_1",
      provider: "github",
      externalId: "7",
      externalUrl: "v",
      fingerprint: "fp",
    });
    expect(saved.sourceId).toBe("find_1");
    const upsertArg = issueLink.upsert.mock.calls[0][0];
    expect(upsertArg.where.findingId_provider).toEqual({
      findingId: "find_1",
      provider: "github",
    });
    expect(upsertArg.create.findingId).toBe("find_1");
  });
});
