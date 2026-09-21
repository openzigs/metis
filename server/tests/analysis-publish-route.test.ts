/**
 * Integration tests for the finding publish HTTP endpoint (Issue #179).
 *
 *   POST /api/projects/:projectId/analyses/:id/findings/:findingId/publish
 *
 * Prisma is mocked in-memory and the adapter's `publishAnalysisFinding` is
 * stubbed so the route's orchestration (authz, Zod validation, destination
 * resolution, Jira preflight, error mapping, audit) is exercised without
 * Octokit / Jira / vault. The adapter itself is covered by
 * analysis-finding-publish.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FindingRow {
  id: string;
  analysisId: string;
  projectId: string;
  agentKey: string;
  title: string;
  body: string;
  category: string;
  severity: string;
  evidence: string | null;
  projectName: string;
}

interface ProjectRow {
  id: string;
  name: string;
  deletedAt: Date | null;
  publishDestination: string;
  jiraConnectionId: string | null;
  jiraProjectKey: string | null;
}

const projects = new Map<string, ProjectRow>();
const analyses = new Map<string, { id: string; projectId: string; deletedAt: Date | null }>();
const findings = new Map<string, FindingRow>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: `user_${create.username}`,
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    analysis: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return null;
        const a = analyses.get(where.id);
        return a && !a.deletedAt ? a : null;
      }),
    },
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return null;
        const p = projects.get(where.id);
        return p && !p.deletedAt ? p : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) => {
        if (!where.id) return null;
        const p = projects.get(where.id);
        if (!p) return null;
        return {
          publishDestination: p.publishDestination,
          jiraConnectionId: p.jiraConnectionId,
          jiraProjectKey: p.jiraProjectKey,
        };
      }),
    },
    finding: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            id: string;
            agentResult?: { analysis?: { id?: string; project?: { id?: string } } };
          };
        }) => {
          const f = findings.get(where.id);
          if (!f) return null;
          const wantAnalysis = where.agentResult?.analysis?.id;
          const wantProject = where.agentResult?.analysis?.project?.id;
          if (wantAnalysis !== undefined && f.analysisId !== wantAnalysis) return null;
          if (wantProject !== undefined && f.projectId !== wantProject) return null;
          return {
            id: f.id,
            title: f.title,
            body: f.body,
            category: f.category,
            severity: f.severity,
            evidence: f.evidence,
            agentResult: {
              agentKey: f.agentKey,
              analysis: { project: { name: f.projectName } },
            },
          };
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: vi.fn(),
}));

// Stub the adapter's publish path; assert the route hands it the right args.
const publishAnalysisFindingMock = vi.fn();
vi.mock("../src/lib/scanner/prisma-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/scanner/prisma-adapter.js")>();
  return {
    ...actual,
    publishAnalysisFinding: (...args: unknown[]) => publishAnalysisFindingMock(...args),
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { PublishError } from "../src/lib/scanner/finding-publisher.js";

let app: ReturnType<typeof createApp>;
let adminToken: string;
let readerToken: string;

async function loginAs(username: string, password: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

const VALID_DRAFT = {
  title: "Add audit logging to all mutations",
  problemStatement: "Mutations are not audited, which fails the compliance requirement.",
  affected: { files: ["src/routes/users.ts"], requirementIds: ["REQ-12"] },
  acceptanceCriteria: ["Every mutation writes an AuditLog row"],
  suggestedLabels: ["security"],
};

const PROJECT_ID = "proj-abcdefghij";
const ANALYSIS_ID = "ana_1";
const FINDING_ID = "find_1";
const url = `/api/projects/${PROJECT_ID}/analyses/${ANALYSIS_ID}/findings/${FINDING_ID}/publish`;

function seedFinding(): void {
  findings.set(FINDING_ID, {
    id: FINDING_ID,
    analysisId: ANALYSIS_ID,
    projectId: PROJECT_ID,
    agentKey: "code",
    title: "No audit logging",
    body: "User mutations are not recorded.",
    category: "security",
    severity: "high",
    evidence: JSON.stringify({ citations: [], tags: [], requirementId: "REQ-12" }),
    projectName: "Acme",
  });
}

function linkFor(provider: string): { externalId: string; externalUrl: string; provider: string } {
  return {
    externalId: provider === "jira" ? "ACME-7" : "42",
    externalUrl:
      provider === "jira"
        ? "https://acme.atlassian.net/browse/ACME-7"
        : "https://github.com/acme/app/issues/42",
    provider,
  };
}

beforeEach(async () => {
  projects.clear();
  analyses.clear();
  findings.clear();
  publishAnalysisFindingMock.mockReset();
  publishAnalysisFindingMock.mockImplementation(async ({ provider }: { provider: string }) =>
    linkFor(provider),
  );

  projects.set(PROJECT_ID, {
    id: PROJECT_ID,
    name: "Acme",
    deletedAt: null,
    publishDestination: "github",
    jiraConnectionId: null,
    jiraProjectKey: null,
  });
  analyses.set(ANALYSIS_ID, { id: ANALYSIS_ID, projectId: PROJECT_ID, deletedAt: null });
  seedFinding();

  app = createApp();
  adminToken = await loginAs("admin", "password");
  readerToken = await loginAs("reader", "password");
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/projects/:projectId/analyses/:id/findings/:findingId/publish", () => {
  it("publishes to the project's default destination (github, 200)", async () => {
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT });

    expect(res.status).toBe(200);
    expect(res.body.data.links).toHaveLength(1);
    expect(res.body.data.links[0]).toMatchObject({
      provider: "github",
      issueKey: "42",
      url: "https://github.com/acme/app/issues/42",
    });
    expect(publishAnalysisFindingMock).toHaveBeenCalledTimes(1);
    const arg = publishAnalysisFindingMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      projectId: PROJECT_ID,
      analysisId: ANALYSIS_ID,
      findingId: FINDING_ID,
      provider: "github",
      agentKey: "code",
      severity: "high",
    });
  });

  it("honours an explicit provider override", async () => {
    projects.get(PROJECT_ID)!.jiraConnectionId = "jc_1";
    projects.get(PROJECT_ID)!.jiraProjectKey = "ACME";
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT, provider: "jira" });

    expect(res.status).toBe(200);
    expect(res.body.data.links[0].provider).toBe("jira");
    expect(publishAnalysisFindingMock.mock.calls[0][0].provider).toBe("jira");
  });

  it("publishes to both destinations when configured (200, two links)", async () => {
    const p = projects.get(PROJECT_ID)!;
    p.publishDestination = "both";
    p.jiraConnectionId = "jc_1";
    p.jiraProjectKey = "ACME";

    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT });

    expect(res.status).toBe(200);
    expect(res.body.data.links).toHaveLength(2);
    expect(res.body.data.links.map((l: { provider: string }) => l.provider)).toEqual([
      "github",
      "jira",
    ]);
  });

  it("forwards caller-supplied extra labels", async () => {
    await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT, extraLabels: ["triaged"] });
    expect(publishAnalysisFindingMock.mock.calls[0][0].extraLabels).toEqual(["triaged"]);
  });

  it("rejects publishing to Jira when no connection is configured (400)", async () => {
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT, provider: "jira" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("JIRA_NOT_CONFIGURED");
    expect(publishAnalysisFindingMock).not.toHaveBeenCalled();
  });

  it("maps ERR_NOT_IMPLEMENTED to 400 (missing repo connection)", async () => {
    publishAnalysisFindingMock.mockRejectedValue(
      new PublishError("ERR_NOT_IMPLEMENTED", "no repo connected"),
    );
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("ERR_NOT_IMPLEMENTED");
  });

  it("maps ERR_STALE_COMMIT to 409", async () => {
    publishAnalysisFindingMock.mockRejectedValue(new PublishError("ERR_STALE_COMMIT", "stale"));
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT });
    expect(res.status).toBe(409);
  });

  it("maps an unexpected publisher failure to 502", async () => {
    publishAnalysisFindingMock.mockRejectedValue(new PublishError("ERR_GITHUB", "boom"));
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT });
    expect(res.status).toBe(502);
  });

  it("rejects a payload missing the draft (400)", async () => {
    const res = await request(app).post(url).set("Authorization", `Bearer ${adminToken}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(publishAnalysisFindingMock).not.toHaveBeenCalled();
  });

  it("rejects unknown fields (strict schema, 400)", async () => {
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT, bogus: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires authentication (401)", async () => {
    const res = await request(app).post(url).send({ draft: VALID_DRAFT });
    expect(res.status).toBe(401);
  });

  it("forbids users without issue.publish (403)", async () => {
    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${readerToken}`)
      .send({ draft: VALID_DRAFT });
    expect(res.status).toBe(403);
    expect(publishAnalysisFindingMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the finding does not exist", async () => {
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/analyses/${ANALYSIS_ID}/findings/missing/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("FINDING_NOT_FOUND");
  });

  it("returns 404 when the finding belongs to a different analysis (IDOR)", async () => {
    const res = await request(app)
      .post(`/api/projects/${PROJECT_ID}/analyses/ana_other/findings/${FINDING_ID}/publish`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ draft: VALID_DRAFT });
    expect(res.status).toBe(404);
    expect(publishAnalysisFindingMock).not.toHaveBeenCalled();
  });
});
