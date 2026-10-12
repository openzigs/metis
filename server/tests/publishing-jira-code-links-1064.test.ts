/**
 * #1064 / PR #1102 review, cycle 2 — Jira never receives the code links.
 *
 * A draft generated for the analysed repository links its Related code into
 * that repository: owner, name and commit SHA in every URL. The GitHub leg may
 * publish that (the guard holds it to that one repository). A Jira project is
 * never the analysed repository, so for the `jira` and `both` destinations the
 * Jira issue must carry the section in its plain form — the same text the
 * generator writes for any other target.
 *
 * Driven through `executeBatch` with the real `jira-publisher`; only the Jira
 * HTTP client and the GitHub publisher are doubles.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  destination: "both" as "github" | "jira" | "both",
  drafts: new Map<string, Record<string, unknown>>(),
};

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    publishBatch: {
      findUnique: vi.fn(async () => ({
        id: "batch_1",
        projectId: "proj_1",
        status: "pending",
        dryRun: false,
        metadata: JSON.stringify({ draftIds: [...state.drafts.keys()], secretRef: null }),
        startedById: "user_1",
      })),
      update: vi.fn(async () => ({})),
    },
    project: {
      findUnique: vi.fn(async () => ({
        publishDestination: state.destination,
        jiraConnectionId: "jc_1",
        jiraProjectKey: "MET",
        requireApprovedReview: false,
      })),
    },
    issueDraft: {
      findMany: vi.fn(async () => [...state.drafts.values()]),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) => state.drafts.get(where.id) ?? null,
      ),
    },
    jiraConnection: {
      findFirst: vi.fn(async () => ({
        id: "jc_1",
        edition: "cloud",
        baseUrl: "https://example.atlassian.net",
        username: "u@example.com",
        secretId: "secret_1",
        proxyUrl: null,
        tlsRejectUnauthorized: true,
        tlsCaSecretId: null,
        status: "ok",
        deletedAt: null,
      })),
    },
    publishedIssue: { create: vi.fn(async () => ({})) },
  },
}));

const runBatch = vi.fn(async (_input: { batchId: string }) => ({ status: "completed" }));
vi.mock("../src/lib/publishing/publisher.js", () => ({
  runBatch: (input: { batchId: string }) => runBatch(input),
  archiveBatch: vi.fn(),
  previewBatchPlan: vi.fn(),
}));

const createIssue = vi.fn(async (_fields: { description?: unknown }) => ({
  id: "10001",
  key: "MET-1",
  self: "https://example.atlassian.net/rest/api/3/issue/10001",
}));
vi.mock("../src/lib/connectors/jira/jira-client.js", () => ({
  createJiraClient: () => ({ createIssue }),
  JiraApiError: class JiraApiError extends Error {},
}));
vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({ read: vi.fn(async () => ({ plaintext: "not-a-real-token" })) }),
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { executeBatch } = await import("../src/lib/publishing/publishing-service.js");
const { __testing } = await import("../src/lib/publishing/draft-generator.js");
const { codeLinkBase, CODE_LINKS_AS_TEXT_NOTE } =
  await import("../src/lib/publishing/draft-code-links.js");

const REPO = {
  origin: "https://github.com",
  owner: "secretcorp",
  repo: "upstream",
  ref: "0123abcd",
};
const LINKS = [
  {
    filePath: "server/src/auth/login.ts",
    startLine: 10,
    endLine: 42,
    symbolName: "createSession",
    symbolKind: "function",
  },
  {
    filePath: "ui/src/login-form.tsx",
    startLine: null,
    endLine: null,
    symbolName: null,
    symbolKind: null,
  },
];

function featureBody(repo: typeof REPO | null): string {
  return __testing.renderFeatureBody({
    project: { id: "proj_1", name: "App" },
    analysis: { id: "analysis_1" },
    requirement: { id: "req_1", title: "Login", body: "Body.", type: "feature", priority: "high" },
    parentTitle: "[Epic] App",
    codeLinks: { links: LINKS, repo },
  });
}

function seedLinkedDraft(): void {
  state.drafts.set("draft_1", {
    id: "draft_1",
    projectId: "proj_1",
    requirementId: "req_1",
    title: "[Feature] Login",
    body: featureBody(REPO),
    draftType: "feature",
    labels: "[]",
    storyPoints: 3,
    status: "approved",
    metadata: JSON.stringify({ analysisId: "analysis_1", codeLinkBase: codeLinkBase(REPO) }),
    deletedAt: null,
  });
}

beforeEach(() => {
  state.drafts.clear();
  vi.clearAllMocks();
});

describe("a draft that links into the analysed repository, published to Jira", () => {
  for (const destination of ["jira", "both"] as const) {
    it(`destination "${destination}": the Jira issue lists the code as text — no owner, commit or URL`, async () => {
      state.destination = destination;
      seedLinkedDraft();
      // The stored draft does link into the analysed repository.
      expect(state.drafts.get("draft_1")!.body).toContain(
        "https://github.com/secretcorp/upstream/blob/0123abcd/server/src/auth/login.ts#L10-L42",
      );

      const result = await executeBatch({ batchId: "batch_1", actorId: "user_1" });
      expect(result.status).toBe("completed");

      expect(createIssue).toHaveBeenCalledTimes(1);
      const description = String(createIssue.mock.calls[0]![0].description);
      // Exactly the body the generator writes when it has no repository to link into.
      expect(description).toBe(featureBody(null));
      expect(description).toContain(
        "- `server/src/auth/login.ts:10-42` — `createSession` (function)",
      );
      expect(description).toContain("- `ui/src/login-form.tsx`");
      expect(description).toContain(CODE_LINKS_AS_TEXT_NOTE);
      for (const leak of ["secretcorp", "upstream", "0123abcd", "github.com", "https://", "]("]) {
        expect(description, leak).not.toContain(leak);
      }
      // The GitHub leg runs only for `both`, and the stored draft is untouched:
      // the plain form is what is SENT to Jira, not a rewrite of the draft.
      expect(runBatch).toHaveBeenCalledTimes(destination === "both" ? 1 : 0);
      expect(state.drafts.get("draft_1")!.body).toBe(featureBody(REPO));
    });
  }

  it("a draft with no recorded repository is sent to Jira exactly as it is", async () => {
    state.destination = "jira";
    state.drafts.set("draft_1", {
      id: "draft_1",
      projectId: "proj_1",
      requirementId: null,
      title: "[Feature] Plain",
      body: "See [the docs](https://example.com/docs).\n\n## Related code\n\n- `a.ts`",
      draftType: "feature",
      labels: "[]",
      storyPoints: null,
      status: "approved",
      metadata: null,
      deletedAt: null,
    });
    await executeBatch({ batchId: "batch_1", actorId: "user_1" });
    expect(createIssue.mock.calls[0]![0].description).toBe(
      "See [the docs](https://example.com/docs).\n\n## Related code\n\n- `a.ts`",
    );
  });
});
