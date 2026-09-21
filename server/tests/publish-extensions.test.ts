/**
 * Publish-extensions — Projects v2 add + .copilot-workspace.md commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Project {
  id: string;
  githubProjectId: string | null;
  githubProjectFieldMappings: string | null;
}
interface PublishedIssue {
  id: string;
  batchId: string;
  status: string;
  issueId: string;
  issueNumber: number;
  errorMessage: string | null;
  draftId: string | null;
  draft?: {
    id: string;
    title: string;
    body: string;
    draftType: string;
    parentDraftId: string | null;
    storyPoints: number | null;
    metadata: string | null;
  } | null;
}
interface IssueDraft {
  id: string;
  projectId: string;
  parentDraftId: string | null;
  title: string;
  storyPoints: number | null;
  metadata: string | null;
  createdAt: Date;
}

const projects = new Map<string, Project>();
const issues: PublishedIssue[] = [];
const drafts: IssueDraft[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      ),
    },
    publishedIssue: {
      findMany: vi.fn(
        async ({
          where,
          include,
        }: {
          where: Record<string, unknown>;
          include?: { draft?: unknown };
        }) => {
          const out = issues.filter((i) => {
            if (where.batchId && i.batchId !== where.batchId) return false;
            if (where.status && typeof where.status === "object") {
              const inSet = (where.status as { in: string[] }).in;
              if (!inSet.includes(i.status)) return false;
            }
            if (
              where.issueId &&
              typeof where.issueId === "object" &&
              (where.issueId as { not: string }).not === ""
            ) {
              if (i.issueId === "") return false;
            }
            if (where.issueNumber && typeof where.issueNumber === "object") {
              const gt = (where.issueNumber as { gt?: number }).gt ?? -Infinity;
              if (i.issueNumber <= gt) return false;
            }
            return true;
          });
          if (include?.draft) return out.map((o) => ({ ...o, draft: o.draft ?? null }));
          return out;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { errorMessage?: string } }) => {
          const idx = issues.findIndex((i) => i.id === where.id);
          if (idx >= 0) issues[idx] = { ...issues[idx], ...data } as PublishedIssue;
          return issues[idx];
        },
      ),
    },
    issueDraft: {
      findMany: vi.fn(async ({ where }: { where: { parentDraftId: string; projectId: string } }) =>
        drafts.filter(
          (d) => d.parentDraftId === where.parentDraftId && d.projectId === where.projectId,
        ),
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  addPublishedIssuesToProject,
  commitCopilotWorkspaceBrief,
  parseExtensionFlags,
} from "../src/lib/publishing/publish-extensions.js";
import type { PublishOctokitLike } from "../src/lib/publishing/types.js";

function makeClient(
  handler: (req: { method: string; url: string }) => unknown,
): PublishOctokitLike {
  return {
    request: vi.fn(async (req: { method: string; url: string }) => {
      const r = handler(req);
      if (r instanceof Error) throw r;
      return { status: 200, headers: {}, data: r };
    }),
  } as unknown as PublishOctokitLike;
}

beforeEach(() => {
  projects.clear();
  issues.length = 0;
  drafts.length = 0;
});

afterEach(() => vi.clearAllMocks());

describe("parseExtensionFlags", () => {
  it("defaults to false on null", () => {
    expect(parseExtensionFlags(null)).toEqual({ copilotWorkspace: false, projectsV2: false });
  });
  it("defaults to false on bad JSON", () => {
    expect(parseExtensionFlags("{not json")).toEqual({
      copilotWorkspace: false,
      projectsV2: false,
    });
  });
  it("reads booleans", () => {
    expect(
      parseExtensionFlags(JSON.stringify({ copilotWorkspace: true, projectsV2: true })),
    ).toEqual({
      copilotWorkspace: true,
      projectsV2: true,
    });
  });
});

describe("addPublishedIssuesToProject", () => {
  it("no-ops when project has no githubProjectId", async () => {
    projects.set("p1", { id: "p1", githubProjectId: null, githubProjectFieldMappings: null });
    const r = await addPublishedIssuesToProject({
      client: makeClient(() => ({})),
      batchId: "b1",
      projectId: "p1",
      actorId: "u",
    });
    expect(r).toEqual({ added: 0, failed: 0, fieldUpdateOk: 0, fieldUpdateFailed: 0 });
  });

  it("adds each issue and applies field mappings", async () => {
    projects.set("p1", {
      id: "p1",
      githubProjectId: "PV_1",
      githubProjectFieldMappings: JSON.stringify({
        Status: { fieldId: "f1", type: "single_select", value: "open" },
      }),
    });
    issues.push(
      {
        id: "pi1",
        batchId: "b1",
        status: "created",
        issueId: "I_1",
        issueNumber: 1,
        errorMessage: null,
        draftId: null,
      },
      {
        id: "pi2",
        batchId: "b1",
        status: "updated",
        issueId: "I_2",
        issueNumber: 2,
        errorMessage: null,
        draftId: null,
      },
    );
    let n = 0;
    const client = makeClient((req) => {
      if (req.method === "POST") {
        n += 1;
        const isAdd = String(JSON.stringify(req)).includes("addProjectV2ItemById");
        if (isAdd) return { data: { addProjectV2ItemById: { item: { id: `PVI_${n}` } } } };
        return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: `PVI_${n}` } } } };
      }
      return {};
    });
    const r = await addPublishedIssuesToProject({
      client,
      batchId: "b1",
      projectId: "p1",
      actorId: "u",
    });
    expect(r.added).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.fieldUpdateOk).toBe(2);
  });

  it("records the failure on the issue without rolling back the batch", async () => {
    projects.set("p1", { id: "p1", githubProjectId: "PV_1", githubProjectFieldMappings: null });
    issues.push({
      id: "pi1",
      batchId: "b1",
      status: "created",
      issueId: "I_1",
      issueNumber: 1,
      errorMessage: null,
      draftId: null,
    });
    const client = makeClient(() => ({ errors: [{ message: "denied" }] }));
    const r = await addPublishedIssuesToProject({
      client,
      batchId: "b1",
      projectId: "p1",
      actorId: "u",
    });
    expect(r.failed).toBe(1);
    expect(issues[0].errorMessage).toMatch(/denied/);
  });
});

describe("commitCopilotWorkspaceBrief", () => {
  it("returns committed=false when there are no published epics", async () => {
    const r = await commitCopilotWorkspaceBrief({
      client: makeClient(() => ({})),
      batchId: "b",
      projectId: "p",
      target: { owner: "o", repo: "r" },
      actorId: "u",
    });
    expect(r.committed).toBe(false);
    expect(r.contentHash).toBeNull();
  });

  it("creates the file when probe returns 404", async () => {
    issues.push({
      id: "pi1",
      batchId: "b1",
      status: "created",
      issueId: "I_1",
      issueNumber: 5,
      errorMessage: null,
      draftId: "d1",
      draft: {
        id: "d1",
        title: "Epic",
        body: "Summary text.",
        draftType: "epic",
        parentDraftId: null,
        storyPoints: null,
        metadata: null,
      },
    });
    drafts.push({
      id: "d2",
      projectId: "p1",
      parentDraftId: "d1",
      title: "Sub",
      storyPoints: 3,
      metadata: null,
      createdAt: new Date(),
    });
    issues.push({
      id: "pi2",
      batchId: "b1",
      status: "created",
      issueId: "I_2",
      issueNumber: 6,
      errorMessage: null,
      draftId: "d2",
      draft: {
        id: "d2",
        title: "Sub",
        body: "",
        draftType: "issue",
        parentDraftId: "d1",
        storyPoints: 3,
        metadata: null,
      },
    });
    const calls: Array<{ method: string; url: string }> = [];
    const client = makeClient((req) => {
      calls.push(req);
      if (req.method === "GET" && req.url.startsWith("/repos/o/r?")) {
        // Should not be called when branch is supplied. Return main anyway.
        return { default_branch: "main" };
      }
      if (req.method === "GET") {
        const e = new Error("not found") as Error & { status?: number };
        e.status = 404;
        return e;
      }
      if (req.method === "PUT") return {};
      return {};
    });
    const r = await commitCopilotWorkspaceBrief({
      client,
      batchId: "b1",
      projectId: "p1",
      target: { owner: "o", repo: "r" },
      actorId: "u",
      branch: "main",
    });
    expect(r.committed).toBe(true);
    expect(calls.find((c) => c.method === "PUT")).toBeDefined();
  });

  it("treats 422 from PUT as already-up-to-date", async () => {
    issues.push({
      id: "pi1",
      batchId: "b1",
      status: "created",
      issueId: "I_1",
      issueNumber: 5,
      errorMessage: null,
      draftId: "d1",
      draft: {
        id: "d1",
        title: "Epic",
        body: "",
        draftType: "epic",
        parentDraftId: null,
        storyPoints: null,
        metadata: null,
      },
    });
    const client = makeClient((req) => {
      if (req.method === "GET") return { sha: "deadbeef" };
      if (req.method === "PUT") {
        const e = new Error("no changes") as Error & { status?: number };
        e.status = 422;
        return e;
      }
      return {};
    });
    const r = await commitCopilotWorkspaceBrief({
      client,
      batchId: "b1",
      projectId: "p1",
      target: { owner: "o", repo: "r" },
      actorId: "u",
      branch: "main",
    });
    expect(r.committed).toBe(false);
    expect(r.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
