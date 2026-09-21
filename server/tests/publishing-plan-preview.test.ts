/**
 * #1104 (D) — plan preview for the pre-publish confirmation.
 *
 * The confirmation dialog must state exactly what a live publish would write
 * and where. Rather than growing a second summary path, it asks the server for
 * the SAME plan the dry run computes — but without creating a `PublishBatch`
 * row, without a single GitHub call, and with issue bodies stripped so the
 * response stays small enough to be a dialog-open cost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DraftRow {
  id: string;
  projectId: string;
  title: string;
  body: string;
  labels: string;
  parentDraftId: string | null;
  draftType: string;
  status: string;
  deletedAt: Date | null;
}

const drafts = new Map<string, DraftRow>();
let publishedIssueRows: Array<Record<string, unknown>> = [];
const { publishBatchCreate } = vi.hoisted(() => ({
  publishBatchCreate: vi.fn(async () => {
    throw new Error("preview must never create a batch row");
  }),
}));
const draftFindManyWhere: Array<Record<string, unknown>> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: vi.fn(async () => ({ requireApprovedReview: false })) },
    requirement: { findMany: vi.fn(async () => []) },
    reviewRequestItem: { findMany: vi.fn(async () => []) },
    issueDraft: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { projectId?: string; id?: { in: string[] }; status?: { in: string[] } };
        }) => {
          draftFindManyWhere.push(where as Record<string, unknown>);
          let rows = [...drafts.values()].filter((d) => !d.deletedAt);
          if (where.projectId) rows = rows.filter((d) => d.projectId === where.projectId);
          if (where.id?.in) rows = rows.filter((d) => where.id!.in.includes(d.id));
          if (where.status?.in) rows = rows.filter((d) => where.status!.in.includes(d.status));
          return rows;
        },
      ),
    },
    publishedIssue: { findMany: vi.fn(async () => publishedIssueRows) },
    publishBatch: { create: publishBatchCreate },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { acquireOctokit, resolveAndAssertConnectorHost } = vi.hoisted(() => ({
  acquireOctokit: vi.fn(async () => ({ request: vi.fn() })),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "api.github.com",
    address: "10.0.0.1",
    family: 4 as const,
  })),
}));
vi.mock("../src/lib/publishing/octokit-factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/publishing/octokit-factory.js")>()),
  acquirePublishOctokit: acquireOctokit,
}));

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost,
  makePinnedLookup: vi.fn(() => undefined),
}));

let vaultToken: string | null = "tok";
let vaultThrows: { code: string } | null = null;
vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async () => {
    if (vaultThrows) throw Object.assign(new Error("nope"), vaultThrows);
    return vaultToken;
  }),
  isVaultRef: (v: string) => /^\$\{vault:[^}]+\}$/.test(v),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn(() => ({})) }));

import { audit } from "../src/lib/audit/audit-service.js";
import { previewBatch } from "../src/lib/publishing/publishing-service.js";
import { computeBodyHash, computeDedupHash } from "../src/lib/publishing/dedup.js";

function seedDraft(id: string, over: Partial<DraftRow> = {}): void {
  drafts.set(id, {
    id,
    projectId: "proj_1",
    title: id,
    body: `body of ${id}`,
    labels: JSON.stringify(["feature"]),
    parentDraftId: null,
    draftType: "feature",
    status: "approved",
    deletedAt: null,
    ...over,
  });
}

function input(over: Record<string, unknown> = {}) {
  return {
    projectId: "proj_1",
    targetOwner: "openzigs",
    targetRepo: "example-requirements",
    provider: "github" as const,
    dryRun: false,
    draftIds: [...drafts.keys()],
    additionalLabels: [],
    secretRef: "${vault:gh}",
    ...over,
  };
}

beforeEach(() => {
  drafts.clear();
  publishedIssueRows = [];
  draftFindManyWhere.length = 0;
  vaultToken = "tok";
  vaultThrows = null;
});
afterEach(() => vi.clearAllMocks());

describe("previewBatch", () => {
  it("returns the action breakdown and target repo without creating a batch row", async () => {
    seedDraft("draft_epic_1", { draftType: "epic", title: "[Epic] Loyalty" });
    seedDraft("draft_feat_1", { parentDraftId: "draft_epic_1" });
    seedDraft("draft_feat_2", { parentDraftId: "draft_epic_1" });

    const plan = await previewBatch({ input: input(), actorId: "user_1" });

    expect(plan.targetOwner).toBe("openzigs");
    expect(plan.targetRepo).toBe("example-requirements");
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds.filter((k) => k === "issue.create")).toHaveLength(3);
    expect(kinds.filter((k) => k === "subIssue.attach")).toHaveLength(2);
    expect(kinds.filter((k) => k === "label.upsert").length).toBeGreaterThan(0);
    expect(plan.totalActions).toBe(plan.actions.length);
    expect(publishBatchCreate).not.toHaveBeenCalled();
  });

  it("makes no GitHub calls and resolves no host — a preview is inert", async () => {
    seedDraft("draft_feat_1");
    await previewBatch({ input: input(), actorId: "user_1" });
    // No client is ever acquired, so no request can be issued; and the host
    // allow-list / DNS resolution never runs (the dry-run path's M1 purity).
    expect(acquireOctokit).not.toHaveBeenCalled();
    expect(resolveAndAssertConnectorHost).not.toHaveBeenCalled();
  });

  it("strips issue bodies so the confirmation payload stays small", async () => {
    seedDraft("draft_feat_1", { body: "x".repeat(5000) });
    const plan = await previewBatch({ input: input(), actorId: "user_1" });
    const create = plan.actions.find((a) => a.kind === "issue.create");
    expect(create).toBeDefined();
    expect(create!.title).toBe("draft_feat_1");
    expect(create!.body).toBeUndefined();
    expect(JSON.stringify(plan).length).toBeLessThan(2000);
  });

  it("distinguishes updates and dedup skips from creates", async () => {
    seedDraft("draft_feat_1", { title: "Existing", body: "unchanged" });
    seedDraft("draft_feat_2", { title: "Changed", body: "new body" });
    publishedIssueRows = [
      {
        dedupHash: computeDedupHash("openzigs", "example-requirements", "Existing"),
        issueNumber: 7,
        issueId: "n7",
        htmlUrl: "https://example.com/7",
        bodyHash: computeBodyHash("unchanged"),
        parentIssueNumber: null,
      },
      {
        dedupHash: computeDedupHash("openzigs", "example-requirements", "Changed"),
        issueNumber: 8,
        issueId: "n8",
        htmlUrl: "https://example.com/8",
        bodyHash: computeBodyHash("stale body"),
        parentIssueNumber: null,
      },
    ];
    const plan = await previewBatch({ input: input(), actorId: "user_1" });
    const kinds = plan.actions.map((a) => a.kind);
    expect(kinds).toContain("issue.skipDuplicate");
    expect(kinds).toContain("issue.update");
    expect(kinds).not.toContain("issue.create");
  });

  it("reports the credential verdict so the dialog can warn before the click", async () => {
    seedDraft("draft_feat_1");
    vaultThrows = { code: "VAULT_REF_INVALID" };
    const plan = await previewBatch({ input: input(), actorId: "user_1" });
    expect(plan.credentialResolved).toBe(false);
    expect(plan.credentialCheck).toBe("unresolved");
    expect(plan.credentialErrorCode).toBe("VAULT_REF_INVALID");
  });

  it("scopes drafts to the path project — foreign ids contribute nothing", async () => {
    seedDraft("draft_feat_1", { projectId: "proj_other" });
    const plan = await previewBatch({
      input: input({ draftIds: ["draft_feat_1"] }),
      actorId: "user_1",
    });
    expect(plan.actions.some((a) => a.kind === "issue.create")).toBe(false);
    expect(draftFindManyWhere[0]).toMatchObject({ projectId: "proj_1" });
  });

  it("audits the preview", async () => {
    seedDraft("draft_feat_1");
    await previewBatch({ input: input(), actorId: "user_1" });
    const actions = (audit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(actions).toContain("publish.batch.preview_plan");
  });
});
