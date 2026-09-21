/**
 * Publisher pipeline — Phase 9 (#66/#68/#69/#70/#71).
 *
 * Heavy mocked-Prisma + mocked-Octokit integration test. Covers:
 *   - happy path: epic + features + sub-issue attach + audit + dedup tracking
 *   - idempotent re-run: zero new issues, dedupSkipped accounting
 *   - dry run: persists DryRunPlan + emits completed event
 *   - rate limit: sleep called between mutations
 *   - auto rollback on >50% failures: closes issues with comment
 *   - GHE base URL routing
 *   - missing token rejection
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface BatchRow {
  id: string;
  projectId: string;
  status: string;
  targetOwner: string;
  targetRepo: string;
  targetBaseUrl: string | null;
  provider: string;
  dryRun: boolean;
  totalDrafts: number;
  publishedCount: number;
  failedCount: number;
  dedupSkipped: number;
  archived: boolean;
  archivedAt: Date | null;
  archiveReason: string | null;
  archivedById: string | null;
  dryRunPlan: string | null;
  startedById: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DraftRow {
  id: string;
  projectId: string;
  requirementId: string | null;
  parentDraftId: string | null;
  draftType: string;
  title: string;
  body: string;
  labels: string;
  assignees: string;
  storyPoints: number;
  status: string;
  dedupHash: string | null;
  metadata: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PublishedIssueRow {
  id: string;
  batchId: string;
  draftId: string;
  issueNumber: number;
  issueId: string;
  htmlUrl: string;
  status: string;
  parentIssueNumber: number | null;
  dedupHash: string | null;
  bodyHash: string | null;
  errorMessage: string | null;
  publishedAt: Date;
}

const batches = new Map<string, BatchRow>();
const drafts = new Map<string, DraftRow>();
const issues = new Map<string, PublishedIssueRow>();
let issueCounter = 0;

function pubIssueKey(batchId: string, draftId: string): string {
  return `${batchId}::${draftId}`;
}

/**
 * #1091 — enforce the Prisma column types the real client enforces.
 *
 * The in-memory Prisma double accepted anything, so writing a numeric `id`
 * into the `String` `issueId` column was invisible here while production threw
 * `Argument 'issueId': Invalid value provided. Expected String, provided Int.`
 * on every single draft — after the issue was already live on GitHub.
 *
 * A hand-written mock can only be as strict as you make it. This makes it as
 * strict as the schema.
 */
function assertPublishedIssueColumnTypes(data: Record<string, unknown>): void {
  const stringCols = ["issueId", "htmlUrl", "status", "batchId", "draftId"];
  for (const col of stringCols) {
    if (col in data && data[col] !== undefined && typeof data[col] !== "string") {
      throw new Error(
        `Invalid \`prisma.publishedIssue\` invocation: Argument \`${col}\`: ` +
          `Invalid value provided. Expected String, provided ${
            typeof data[col] === "number" ? "Int" : typeof data[col]
          }.`,
      );
    }
  }
  for (const col of ["issueNumber", "parentIssueNumber"]) {
    if (col in data && data[col] !== undefined && data[col] !== null) {
      if (typeof data[col] !== "number") {
        throw new Error(
          `Invalid \`prisma.publishedIssue\` invocation: Argument \`${col}\`: ` +
            `Invalid value provided. Expected Int, provided ${typeof data[col]}.`,
        );
      }
    }
  }
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    // #619 — approval gate off; this file tests publisher mechanics. The
    // dedicated gate describe below flips `findUnique` per test.
    project: {
      findUnique: vi.fn(async () => ({ requireApprovedReview: false })),
    },
    requirement: { findMany: vi.fn(async () => []) },
    reviewRequestItem: { findMany: vi.fn(async () => []) },
    publishBatch: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => batches.get(where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<BatchRow> }) => {
        const r = batches.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() };
        batches.set(where.id, next);
        return next;
      }),
    },
    issueDraft: {
      findMany: vi.fn(
        async ({ where }: { where: { id?: { in?: string[] }; projectId: string } }) => {
          const rows = [...drafts.values()].filter(
            (d) => d.projectId === where.projectId && !d.deletedAt,
          );
          if (where.id?.in) return rows.filter((d) => where.id!.in!.includes(d.id));
          return rows;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
        const r = drafts.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() };
        drafts.set(where.id, next);
        return next;
      }),
    },
    publishedIssue: {
      findFirst: vi.fn(
        async ({ where }: { where: { draftId?: string; batch?: { projectId?: string } } }) => {
          for (const row of issues.values()) {
            if (where.draftId && row.draftId !== where.draftId) continue;
            const b = batches.get(row.batchId);
            const out = { ...row, batch: b ?? null };
            if (where.batch?.projectId && b?.projectId !== where.batch.projectId) continue;
            return out;
          }
          return null;
        },
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const out: PublishedIssueRow[] = [];
        for (const row of issues.values()) {
          if ((where.batchId as string | undefined) && row.batchId !== where.batchId) continue;
          if ((where.dedupHash as { not?: null } | undefined)?.not === null && !row.dedupHash)
            continue;
          if (
            (where.status as { in?: string[] } | undefined)?.in &&
            !(where.status as { in: string[] }).in.includes(row.status)
          )
            continue;
          if (typeof where.status === "string" && row.status !== where.status) continue;
          if (where.batch && typeof where.batch === "object") {
            const b = batches.get(row.batchId);
            const wb = where.batch as Record<string, unknown>;
            if (b && wb.projectId && b.projectId !== wb.projectId) continue;
            if (b && wb.targetOwner && b.targetOwner !== wb.targetOwner) continue;
            if (b && wb.targetRepo && b.targetRepo !== wb.targetRepo) continue;
            if (b && "archived" in wb && b.archived !== wb.archived) continue;
          }
          out.push(row);
        }
        return out;
      }),
      upsert: vi.fn(
        async ({
          where,
          update,
          create,
        }: {
          where: {
            batchId_draftId_destination: { batchId: string; draftId: string; destination: string };
          };
          update: Partial<PublishedIssueRow>;
          create: Partial<PublishedIssueRow>;
        }) => {
          assertPublishedIssueColumnTypes(update as Record<string, unknown>);
          assertPublishedIssueColumnTypes(create as Record<string, unknown>);
          const key = pubIssueKey(
            where.batchId_draftId_destination.batchId,
            where.batchId_draftId_destination.draftId,
          );
          const existing = issues.get(key);
          if (existing) {
            const next = { ...existing, ...update };
            issues.set(key, next);
            return next;
          }
          issueCounter += 1;
          const row: PublishedIssueRow = {
            id: `pi_${issueCounter}`,
            batchId: where.batchId_draftId_destination.batchId,
            draftId: where.batchId_draftId_destination.draftId,
            issueNumber: 0,
            issueId: "",
            htmlUrl: "",
            status: "created",
            parentIssueNumber: null,
            dedupHash: null,
            bodyHash: null,
            errorMessage: null,
            publishedAt: new Date(),
            ...(create as PublishedIssueRow),
          };
          issues.set(key, row);
          return row;
        },
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "github.example.com",
    address: "10.20.30.40",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));

vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async (ref: string | null) => (ref ? `tok-${ref}` : null)),
}));

vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn(() => ({})) }));

import {
  __resetPublishOctokitCache,
  __setPublishOctokitFactory,
} from "../src/lib/publishing/octokit-factory.js";
import { runBatch, archiveBatch } from "../src/lib/publishing/publisher.js";
import { audit } from "../src/lib/audit/audit-service.js";
import { prisma } from "../src/lib/prisma.js";
import { resolveVaultRef } from "../src/lib/connectors/vault-resolver.js";
import { computeDedupHash } from "../src/lib/publishing/dedup.js";
import { rollbackOutcomeMessage } from "../src/lib/publishing/publisher.js";
import type { GhIssue, PublishOctokitLike } from "../src/lib/publishing/types.js";
import realIssueFixture from "./fixtures/github-rest-issue.json" with { type: "json" };

let nextRemoteIssue = 100;

/**
 * #1091 — remote issues are built by cloning a **recorded** GitHub REST issue
 * payload (`tests/fixtures/github-rest-issue.json`, captured with
 * `gh api repos/octocat/Hello-World/issues/349`) and overriding only the
 * identifiers. The previous hand-written stub declared `id: "node_101"` — a
 * string, and no `node_id` at all — which is precisely why a mocked suite was
 * green while every live publish failed. A mock proves nothing about a type it
 * invented; this one inherits the real field types.
 */
type FakeIssue = GhIssue & { body: string };

function makeRemoteIssue(number: number, body: string): FakeIssue {
  return {
    ...(realIssueFixture as unknown as GhIssue),
    // The numeric REST database id and the GraphQL node id are DIFFERENT
    // values of DIFFERENT types — the whole point of #1091.
    id: 4_993_133_000 + number,
    node_id: `I_kwDOfake${number}`,
    number,
    html_url: `https://github.com/acme/metis/issues/${number}`,
    body,
  };
}

const remoteIssues = new Map<number, FakeIssue>();

function makeFakeOctokit(opts?: {
  failOnCreate?: number; // fail the Nth create
  rejectAuth?: boolean;
  alwaysFailCreate?: boolean;
}): PublishOctokitLike {
  let createCount = 0;
  return {
    request: async (args) => {
      const url = args.url ?? "";
      const method = args.method ?? "GET";
      // Auth scope check.
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url)) {
        if (opts?.rejectAuth) {
          const e = new Error("auth failed") as { status?: number };
          e.status = 401;
          throw e;
        }
        return {
          status: 200,
          headers: {},
          data: { permissions: { push: true }, full_name: "acme/metis" },
        };
      }
      // Label PUT/POST.
      if (/\/labels/.test(url)) {
        return { status: 200, headers: {}, data: { name: "ok" } };
      }
      // Issue list.
      if (method === "GET" && /\/issues\?/.test(url)) {
        return { status: 200, headers: {}, data: [...remoteIssues.values()] };
      }
      // Issue create.
      if (method === "POST" && /\/issues$/.test(url)) {
        createCount += 1;
        if (opts?.alwaysFailCreate) {
          throw new Error("simulated github failure");
        }
        if (opts?.failOnCreate && createCount === opts.failOnCreate) {
          throw new Error("simulated github failure");
        }
        nextRemoteIssue += 1;
        const issue = makeRemoteIssue(
          nextRemoteIssue,
          String((args.data as { body?: string })?.body ?? ""),
        );
        remoteIssues.set(issue.number, issue);
        return { status: 201, headers: {}, data: issue };
      }
      // Issue PATCH.
      if (method === "PATCH" && /\/issues\/\d+$/.test(url)) {
        const num = Number(url.split("/").pop());
        const existing = remoteIssues.get(num);
        if (existing) {
          existing.body = String((args.data as { body?: string })?.body ?? existing.body);
        }
        return {
          status: 200,
          headers: {},
          data: existing ?? makeRemoteIssue(num, ""),
        };
      }
      // Sub-issue attach.
      if (method === "POST" && /\/sub_issues$/.test(url)) {
        return { status: 201, headers: {}, data: {} };
      }
      // Comments.
      if (method === "POST" && /\/comments$/.test(url)) {
        return { status: 201, headers: {}, data: {} };
      }
      return { status: 200, headers: {}, data: {} };
    },
  };
}

function seedDraft(over: Partial<DraftRow>): DraftRow {
  const d: DraftRow = {
    id: over.id ?? `draft_${drafts.size + 1}`,
    projectId: "proj_1",
    requirementId: null,
    parentDraftId: null,
    draftType: "feature",
    title: over.title ?? "Untitled",
    body: over.body ?? "body",
    labels: over.labels ?? '["feature"]',
    assignees: "[]",
    storyPoints: 1,
    status: "approved",
    dedupHash: null,
    metadata: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  drafts.set(d.id, d);
  return d;
}

function seedBatch(over: Partial<BatchRow>): BatchRow {
  const draftIds = [...drafts.keys()];
  const b: BatchRow = {
    id: over.id ?? "batch_1",
    projectId: "proj_1",
    status: "pending",
    targetOwner: "acme",
    targetRepo: "metis",
    targetBaseUrl: null,
    provider: "github",
    dryRun: false,
    totalDrafts: draftIds.length,
    publishedCount: 0,
    failedCount: 0,
    dedupSkipped: 0,
    archived: false,
    archivedAt: null,
    archiveReason: null,
    archivedById: null,
    dryRunPlan: null,
    startedById: "user_1",
    startedAt: new Date(),
    completedAt: null,
    errorMessage: null,
    metadata: JSON.stringify({ draftIds, additionalLabels: [], secretRef: "${vault:gh}" }),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  batches.set(b.id, b);
  return b;
}

const sleepCalls: number[] = [];
const noopSleep = async (ms: number) => {
  sleepCalls.push(ms);
};

beforeEach(() => {
  // Restore default implementations and discard unconsumed gate overrides.
  vi.resetAllMocks();
  batches.clear();
  drafts.clear();
  issues.clear();
  remoteIssues.clear();
  sleepCalls.length = 0;
  issueCounter = 0;
  nextRemoteIssue = 100;
  __resetPublishOctokitCache();
});

afterEach(() => {
  __setPublishOctokitFactory(null);
  vi.clearAllMocks();
});

describe("runBatch — happy path", () => {
  it("creates epic + feature, attaches sub-issue, audits + sleeps between", async () => {
    const epic = seedDraft({
      id: "epic_1",
      title: "[Epic] Apollo",
      draftType: "epic",
      labels: '["epic"]',
    });
    seedDraft({ id: "feat_1", title: "[Feature] Login", parentDraftId: epic.id });
    seedBatch({});
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    const result = await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(result.status).toBe("completed");
    const finalBatch = batches.get("batch_1")!;
    expect(finalBatch.publishedCount).toBe(2);
    expect(finalBatch.failedCount).toBe(0);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(2);
    // PublishedIssue rows persisted with dedup + body hashes.
    const piRows = [...issues.values()];
    expect(piRows.length).toBe(2);
    expect(piRows.every((r) => r.dedupHash !== null && r.bodyHash !== null)).toBe(true);
    // Audit was called for batch.completed + per-issue create.
    const auditCalls = (audit as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].action);
    expect(auditCalls).toContain("publish.batch.completed");
    expect(auditCalls.filter((a) => a === "publish.issue.create").length).toBe(2);
  });
});

describe("#1091 — issue identifiers (recorded GitHub REST shape)", () => {
  /**
   * Run `fn` with the success-path `publishedIssue.upsert` throwing, then
   * restore. `vi.clearAllMocks()` clears calls but NOT implementations, so an
   * un-restored override would leak into every later test in this file.
   */
  async function withFailingPersistence(message: string, fn: () => Promise<void>): Promise<void> {
    const upsert = prisma.publishedIssue.upsert as ReturnType<typeof vi.fn>;
    const real = upsert.getMockImplementation()!;
    upsert.mockImplementation(async (args: { create?: { status?: string } }) => {
      if (args.create?.status !== "failed") throw new Error(message);
      return real(args);
    });
    try {
      await fn();
    } finally {
      upsert.mockImplementation(real);
    }
  }

  it("persists node_id on the UPDATE path too, not just on create", async () => {
    // The other half of the defect: `issueId = updated.data.id` on the
    // dedup-matched PATCH branch failed identically once the body changed.
    const draft = seedDraft({ id: "f1", title: "Login", body: "new body" });
    seedBatch({});
    const remote = makeRemoteIssue(777, "old body");
    remoteIssues.set(remote.number, remote);
    issues.set("batch_0::f1", {
      id: "pi_pre",
      batchId: "batch_0",
      draftId: draft.id,
      issueNumber: remote.number,
      issueId: remote.node_id,
      htmlUrl: remote.html_url,
      status: "created",
      parentIssueNumber: null,
      dedupHash: computeDedupHash("acme", "metis", draft.title),
      // Different from the draft's current body → forces the PATCH branch.
      bodyHash: "stale-hash",
      errorMessage: null,
      publishedAt: new Date(),
    });
    batches.set("batch_0", { ...batches.get("batch_1")!, id: "batch_0" });
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    const result = await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(result.status).toBe("completed");
    const row = issues.get("batch_1::f1")!;
    expect(row.status).toBe("updated");
    expect(row.issueId).toBe(remote.node_id);
    expect(typeof row.issueId).toBe("string");
    expect(row.issueNumber).toBe(777);
  });

  it("persists node_id in PublishedIssue.issueId, never the numeric REST id", async () => {
    seedDraft({ id: "f1", title: "Login" });
    seedBatch({});
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    const result = await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    // Before the fix this run recorded 0 published and 1 failed with
    // "Expected String, provided Int" — while the issue existed on GitHub.
    expect(result.status).toBe("completed");
    const row = [...issues.values()][0];
    const remote = [...remoteIssues.values()][0];
    expect(typeof remote.id).toBe("number"); // the REST id really is numeric
    expect(typeof remote.node_id).toBe("string");
    expect(row.issueId).toBe(remote.node_id);
    expect(row.issueId).not.toBe(String(remote.id));
    expect(typeof row.issueId).toBe("string");
    expect(row.issueNumber).toBe(remote.number);
  });

  it("sends the numeric REST id as sub_issue_id, not the issue number", async () => {
    const epic = seedDraft({ id: "epic_1", title: "[Epic] Apollo", draftType: "epic" });
    seedDraft({ id: "feat_1", title: "[Feature] Login", parentDraftId: epic.id });
    seedBatch({});
    const subIssueBodies: Array<{ sub_issue_id?: unknown }> = [];
    const base = makeFakeOctokit();
    __setPublishOctokitFactory(async () => ({
      request: async (args) => {
        if (args.method === "POST" && /\/sub_issues$/.test(args.url ?? "")) {
          subIssueBodies.push(args.data as { sub_issue_id?: unknown });
        }
        return base.request(args);
      },
    }));
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(subIssueBodies.length).toBe(1);
    const child = [...remoteIssues.values()].find((i) => i.body.includes("draft=feat_1"))!;
    // GitHub's sub-issue API takes the child's numeric DATABASE id. Passing
    // the issue number 404s, which the retry loop misreads as "endpoint
    // unsupported" and then silently skips every remaining attach.
    expect(subIssueBodies[0].sub_issue_id).toBe(child.id);
    expect(subIssueBodies[0].sub_issue_id).not.toBe(child.number);
    expect(typeof subIssueBodies[0].sub_issue_id).toBe("number");
  });

  it("reconcileFromRemote recovers issueId from node_id so a retry dedup-skips", async () => {
    // Simulates the live situation: issues carrying `metis-publish` markers
    // exist on GitHub, but the local PublishedIssue rows are useless.
    seedDraft({ id: "f1", title: "Login" });
    seedBatch({ id: "batch_1" });
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    const created = [...remoteIssues.values()][0];
    const persisted = [...issues.values()][0];

    // Wipe the local dedup signal (dedupHash) the way a lost/failed write
    // would, leaving only the marker on the remote issue plus the row the
    // reconciler cross-checks against.
    persisted.dedupHash = null;
    drafts.get("f1")!.status = "approved";
    seedBatch({
      id: "batch_2",
      status: "pending",
      metadata: JSON.stringify({
        draftIds: ["f1"],
        additionalLabels: [],
        secretRef: "${vault:gh}",
      }),
    });
    const second = await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(second.status).toBe("completed");
    // Recovered from the marker → dedup-skipped, no duplicate issue created.
    expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
    expect(remoteIssues.size).toBe(1);
    // And the row the recovery wrote carries the node id, not the numeric id.
    const recovered = issues.get("batch_2::f1")!;
    expect(recovered.issueId).toBe(created.node_id);
  });

  it("rollback closes issues created remotely even when the local write failed", async () => {
    // The #1091 failure mode exactly: GitHub creates succeed, persistence
    // throws, so no `status: "created"` row exists for the rollback to find.
    seedDraft({ id: "f1", title: "one" });
    seedDraft({ id: "f2", title: "two" });
    seedBatch({});
    const closed: number[] = [];
    const base = makeFakeOctokit();
    __setPublishOctokitFactory(async () => ({
      request: async (args) => {
        if (args.method === "PATCH" && /\/issues\/\d+$/.test(args.url ?? "")) {
          const data = args.data as { state?: string } | undefined;
          if (data?.state === "closed") closed.push(Number((args.url ?? "").split("/").pop()));
        }
        return base.request(args);
      },
    }));
    // The literal Prisma error the live run produced, success path only.
    await withFailingPersistence(
      "Argument `issueId`: Invalid value provided. Expected String, provided Int",
      async () => {
        const result = await runBatch({
          batchId: "batch_1",
          dryRun: false,
          secretRef: "${vault:gh}",
          sleep: noopSleep,
        });
        expect(result.status).toBe("failed");
      },
    );
    // Both issues really were created on GitHub, so both must be closed —
    // previously the rollback found nothing and left them open.
    expect(closed.sort()).toEqual([...remoteIssues.keys()].sort());
    expect(closed.length).toBeGreaterThan(0);
    // ...and the batch says so rather than implying a clean rollback.
    expect(batches.get("batch_1")!.errorMessage).toContain("closed");
  });

  it("records the real issue number on a failed row when the remote write succeeded", async () => {
    seedDraft({ id: "f1", title: "one" });
    seedBatch({});
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await withFailingPersistence("simulated persistence failure", async () => {
      await runBatch({
        batchId: "batch_1",
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });
    });
    const row = issues.get("batch_1::f1")!;
    const remote = [...remoteIssues.values()][0];
    expect(row.status).toBe("failed");
    expect(row.issueNumber).toBe(remote.number);
    expect(row.issueId).toBe(remote.node_id);
  });

  it("skips a remote issue whose payload is malformed instead of poisoning dedup", async () => {
    // A proxy/API change that drops `node_id` must not seed the dedup map
    // with a bad identifier — that is how a retry re-failed wholesale.
    seedDraft({ id: "f1", title: "Login", body: "body" });
    seedBatch({});
    const hash = computeDedupHash("acme", "metis", "Login");
    // The reconciler treats a marker as a hint and cross-checks the DB (F3),
    // so a matching row must exist for the payload guard to be reached at all.
    // `dedupHash: null` keeps it out of the local dedup map.
    issues.set("batch_1::f1", {
      id: "pi_pre",
      batchId: "batch_1",
      draftId: "f1",
      issueNumber: 42,
      issueId: "I_kwDOfake42",
      htmlUrl: "https://github.com/acme/metis/issues/42",
      status: "created",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
    });
    __setPublishOctokitFactory(async () => {
      const base = makeFakeOctokit();
      return {
        request: async (args) => {
          if ((args.method ?? "GET") === "GET" && /\/issues\?/.test(args.url ?? "")) {
            return {
              status: 200,
              headers: {},
              data: [
                {
                  // No node_id at all.
                  id: 4_993_133_999,
                  number: 42,
                  html_url: "https://github.com/acme/metis/issues/42",
                  body: `body\n\n<!-- metis-publish: batch=batch_1 draft=f1 hash=${hash} -->`,
                },
              ],
            };
          }
          return base.request(args);
        },
      };
    });
    const result = await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    // The malformed remote row is ignored; the draft publishes normally.
    expect(result.status).toBe("completed");
    expect(issues.get("batch_1::f1")!.issueNumber).not.toBe(42);
  });
});

describe("rollbackOutcomeMessage (#1091)", () => {
  it("says plainly when nothing had been created", () => {
    expect(rollbackOutcomeMessage(3, 4, { attempted: 0, closed: 0, failed: 0 })).toContain(
      "no issues had been created",
    );
  });

  it("reports how many were closed", () => {
    expect(rollbackOutcomeMessage(3, 4, { attempted: 2, closed: 2, failed: 0 })).toContain(
      "closed 2 created issue(s)",
    );
  });

  it("does NOT imply a clean rollback when some could not be closed", () => {
    // The old fixed string read as if GitHub had been returned to a clean
    // state; 8 issues were in fact still open.
    const msg = rollbackOutcomeMessage(8, 14, { attempted: 8, closed: 5, failed: 3 });
    expect(msg).toContain("3 could NOT be closed and remain open on GitHub");
    expect(msg).toContain("8/14 drafts failed");
  });
});

describe("runBatch — idempotent re-run", () => {
  it("second run produces zero new issues and counts dedupSkipped", async () => {
    seedDraft({ id: "feat_1", title: "Login" });
    seedBatch({ id: "batch_1" });
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(batches.get("batch_1")!.publishedCount).toBe(1);
    // Reset draft status (publisher marked it 'published') so second batch picks it up
    drafts.get("feat_1")!.status = "approved";
    seedBatch({
      id: "batch_2",
      status: "pending",
      publishedCount: 0,
      failedCount: 0,
      dedupSkipped: 0,
      metadata: JSON.stringify({
        draftIds: ["feat_1"],
        additionalLabels: [],
        secretRef: "${vault:gh}",
      }),
    });
    const second = await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(second.status).toBe("completed");
    expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
    expect(batches.get("batch_2")!.publishedCount).toBe(0);
  });
});

describe("runBatch — dry run", () => {
  it("persists a DryRunPlan, never calls Octokit, emits completed", async () => {
    seedDraft({ id: "epic_1", title: "[Epic] Apollo", draftType: "epic" });
    seedDraft({ id: "f1", title: "[Feature] Login", parentDraftId: "epic_1" });
    seedBatch({ dryRun: true });
    let factoryCalls = 0;
    __setPublishOctokitFactory(async () => {
      factoryCalls += 1;
      return makeFakeOctokit();
    });
    const r = await runBatch({
      batchId: "batch_1",
      dryRun: true,
      secretRef: null,
      sleep: noopSleep,
    });
    expect(r.status).toBe("completed");
    expect(factoryCalls).toBe(0); // Octokit never acquired in dry-run
    const final = batches.get("batch_1")!;
    expect(final.dryRunPlan).not.toBeNull();
    const plan = JSON.parse(final.dryRunPlan!);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.some((a: { kind: string }) => a.kind === "issue.create")).toBe(true);
  });

  it("#1093 — reports credentialResolved=false when no ref was supplied", async () => {
    seedDraft({ id: "f1", title: "Login" });
    seedBatch({ dryRun: true });
    await runBatch({ batchId: "batch_1", dryRun: true, secretRef: null, sleep: noopSleep });
    const plan = JSON.parse(batches.get("batch_1")!.dryRunPlan!);
    expect(plan.credentialResolved).toBe(false);
    expect(plan.credentialCheck).toBe("missing");
    // The batch must not read as an unqualified success in the batch list.
    expect(batches.get("batch_1")!.errorMessage).toContain("credential");
  });

  it("#1093 — reports credentialResolved=true when the ref resolves", async () => {
    seedDraft({ id: "f1", title: "Login" });
    seedBatch({ dryRun: true });
    await runBatch({
      batchId: "batch_1",
      dryRun: true,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    const plan = JSON.parse(batches.get("batch_1")!.dryRunPlan!);
    expect(plan.credentialResolved).toBe(true);
    expect(plan.credentialCheck).toBe("resolved");
    expect(batches.get("batch_1")!.errorMessage).toBeNull();
    // The plan itself never carries the token.
    expect(batches.get("batch_1")!.dryRunPlan).not.toContain("tok-");
  });

  it("#1093 — records unresolved when the vault returns no token for a valid ref", async () => {
    seedDraft({ id: "f1", title: "Login" });
    seedBatch({ dryRun: true });
    const resolver = resolveVaultRef as ReturnType<typeof vi.fn>;
    const real = resolver.getMockImplementation()!;
    resolver.mockImplementation(async () => null);
    try {
      await runBatch({
        batchId: "batch_1",
        dryRun: true,
        secretRef: "${vault:empty}",
        sleep: noopSleep,
      });
      const plan = JSON.parse(batches.get("batch_1")!.dryRunPlan!);
      expect(plan.credentialResolved).toBe(false);
      expect(plan.credentialCheck).toBe("unresolved");
      expect(plan.credentialErrorCode).toBe("TOKEN_REQUIRED");
    } finally {
      resolver.mockImplementation(real);
    }
  });

  it("#1093 — records unresolved (not a crash) when the vault rejects the ref", async () => {
    seedDraft({ id: "f1", title: "Login" });
    seedBatch({ dryRun: true });
    const resolver = resolveVaultRef as ReturnType<typeof vi.fn>;
    const real = resolver.getMockImplementation()!;
    resolver.mockImplementation(async () => {
      const err = new Error("vault reference ${vault:nope} could not be resolved") as Error & {
        code: string;
        status: number;
      };
      err.code = "VAULT_REF_UNRESOLVED";
      err.status = 500;
      throw err;
    });
    try {
      const r = await runBatch({
        batchId: "batch_1",
        dryRun: true,
        secretRef: "${vault:nope}",
        sleep: noopSleep,
      });
      // The preview is still worth having — it is why the user asked for one.
      expect(r.status).toBe("completed");
      const plan = JSON.parse(batches.get("batch_1")!.dryRunPlan!);
      expect(plan.credentialResolved).toBe(false);
      expect(plan.credentialCheck).toBe("unresolved");
      expect(plan.credentialErrorCode).toBe("VAULT_REF_UNRESOLVED");
      // Only the bare code is retained — no upstream message text.
      expect(batches.get("batch_1")!.dryRunPlan).not.toContain("could not be resolved");
    } finally {
      resolver.mockImplementation(real);
    }
  });

  it("#1093 — the dry run still acquires no Octokit client while pre-flighting (M1)", async () => {
    seedDraft({ id: "f1", title: "Login" });
    seedBatch({ dryRun: true, targetBaseUrl: "https://github.example.com/api/v3" });
    let factoryCalls = 0;
    __setPublishOctokitFactory(async () => {
      factoryCalls += 1;
      return makeFakeOctokit();
    });
    await runBatch({
      batchId: "batch_1",
      dryRun: true,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    // Resolving a vault ref is a local secret-store read; M1's guarantee is
    // about DNS / allow-list / GitHub, and it still holds.
    expect(factoryCalls).toBe(0);
  });
});

describe("runBatch — approval gate (#619, scheduler-bypass choke point)", () => {
  it("blocks a LIVE run with 409 APPROVAL_REQUIRED when the gate is on and drafts are unreviewed", async () => {
    // The scheduler's republish handler calls runBatch directly (no
    // createBatch/executeBatch); the gate must hold at this layer too.
    seedDraft({ id: "feat_1", title: "[Feature] Login", requirementId: "req_1" });
    seedBatch({});
    (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      requireApprovedReview: true,
    }));
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await expect(
      runBatch({ batchId: "batch_1", dryRun: false, secretRef: "${vault:gh}", sleep: noopSleep }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "APPROVAL_REQUIRED",
      details: expect.objectContaining({ requirementIds: ["req_1"] }),
    });
    // Nothing was published.
    expect([...issues.values()]).toHaveLength(0);
  });

  it("FAIL CLOSED: a gate lookup error blocks the live run with 503", async () => {
    seedDraft({ id: "feat_1", title: "[Feature] Login", requirementId: "req_1" });
    seedBatch({});
    (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await expect(
      runBatch({ batchId: "batch_1", dryRun: false, secretRef: "${vault:gh}", sleep: noopSleep }),
    ).rejects.toMatchObject({ statusCode: 503, code: "APPROVAL_GATE_UNAVAILABLE" });
    expect([...issues.values()]).toHaveLength(0);
  });

  it("dry-run stays exempt even with the gate on (pure preview)", async () => {
    seedDraft({ id: "feat_1", title: "[Feature] Login", requirementId: "req_1" });
    seedBatch({ dryRun: true });
    (prisma.project.findUnique as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      requireApprovedReview: true,
    }));
    const r = await runBatch({
      batchId: "batch_1",
      dryRun: true,
      secretRef: null,
      sleep: noopSleep,
    });
    expect(r.status).toBe("completed");
  });
});

describe("runBatch — token required", () => {
  it("rejects when secretRef returns no token", async () => {
    seedDraft({ id: "f1", title: "x" });
    seedBatch({});
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await expect(
      runBatch({ batchId: "batch_1", dryRun: false, secretRef: null, sleep: noopSleep }),
    ).rejects.toMatchObject({ code: "TOKEN_REQUIRED" });
  });
});

// #1104 (F) — cancel settles the local row; the publisher must then treat it
// as terminal, so no path can resume a batch the user has written off and
// create issues nobody is watching for.
describe("runBatch — cancelled batch", () => {
  it("refuses to publish a cancelled batch", async () => {
    seedDraft({ id: "f1", title: "x" });
    seedBatch({ status: "cancelled" });
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await expect(
      runBatch({ batchId: "batch_1", dryRun: false, secretRef: "${vault:gh}", sleep: noopSleep }),
    ).rejects.toMatchObject({ code: "BATCH_CANCELLED", status: 409 });
  });
});

describe("runBatch — auto rollback", () => {
  it("triggers rollback when failures > 50% and closes any successful issues", async () => {
    seedDraft({ id: "f1", title: "one" });
    seedDraft({ id: "f2", title: "two" });
    seedDraft({ id: "f3", title: "three" });
    seedBatch({});
    __setPublishOctokitFactory(async () => makeFakeOctokit({ alwaysFailCreate: true }));
    const r = await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(r.status).toBe("failed");
    expect(batches.get("batch_1")!.errorMessage).toMatch(/auto-rollback/);
  });
});

describe("runBatch — GHE base URL", () => {
  it("routes through the GHE host via allow-list + DNS pin", async () => {
    seedDraft({ id: "f1", title: "x" });
    seedBatch({ targetBaseUrl: "https://github.example.com/api/v3" });
    let receivedBaseUrl = "";
    __setPublishOctokitFactory(async (args) => {
      receivedBaseUrl = args.baseUrl;
      expect(args.pinnedAddress).toBe("10.20.30.40");
      return makeFakeOctokit();
    });
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(receivedBaseUrl).toContain("github.example.com");
  });
});

describe("archiveBatch", () => {
  it("flags the batch archived without closing issues when closeIssues=false", async () => {
    seedDraft({ id: "f1", title: "x" });
    seedBatch({});
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    await archiveBatch({
      batchId: "batch_1",
      reason: "manual",
      closeIssues: false,
      actorId: "user_1",
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(batches.get("batch_1")!.archived).toBe(true);
    expect(batches.get("batch_1")!.archiveReason).toBe("manual");
  });

  it("noop on already-archived batch", async () => {
    seedDraft({ id: "f1", title: "x" });
    seedBatch({ archived: true });
    await archiveBatch({
      batchId: "batch_1",
      reason: "again",
      closeIssues: false,
      actorId: "user_1",
      secretRef: null,
      sleep: noopSleep,
    });
    expect(batches.get("batch_1")!.archived).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Review fix-up tests — F1, F2, F3, M1, M2
// ─────────────────────────────────────────────────────────────────────────

import {
  __resetSubIssueCapabilityCache,
  __testing as publisherTesting,
} from "../src/lib/publishing/publisher.js";
import { resolvePublishTarget } from "../src/lib/publishing/host-allowlist.js";

describe("F1 — sub-issue retry uses full backoff (no /100 divider)", () => {
  it("passes the documented exponential backoff into sleep", async () => {
    const calls: number[] = [];
    const failingClient = {
      request: vi.fn(async (args: { url?: string; method?: string }) => {
        if ((args.method ?? "GET") === "POST" && /sub_issues$/.test(args.url ?? "")) {
          throw new Error("sub-issue attach failure");
        }
        return { status: 200, headers: {}, data: {} };
      }),
    };
    await expect(
      publisherTesting.attachSubIssueWithRetry({
        client: failingClient,
        target: { owner: "acme", repo: "metis" },
        parentNumber: 1,
        childRestId: 4_993_133_002,
        childNumber: 2,
        rateLimit: {
          delayMs: 0,
          jitterMs: 0,
          secondaryBackoffBaseMs: 60_000,
          secondaryBackoffMaxMs: 600_000,
          maxRetries: 3,
          backoffBudgetMs: 30 * 60_000,
        },
        sleep: async (ms) => {
          calls.push(ms);
        },
      }),
    ).rejects.toBeTruthy();
    // 3 retries → 2 sleeps (between attempts). First sleep = 60_000, second = 120_000.
    expect(calls).toEqual([60_000, 120_000]);
  });
});

describe("F2 — rollback only closes batch-CREATED issues, not pre-existing updated ones", () => {
  it("closes one created issue and leaves one updated (dedup-matched) untouched", async () => {
    seedDraft({ id: "f1", title: "one" });
    seedDraft({ id: "f2", title: "two" });
    seedBatch({ id: "batch_x" });
    // Pre-seed an "updated" published issue (simulates a prior batch).
    issues.set("batch_x::pre", {
      id: "pi_pre",
      batchId: "batch_x",
      draftId: "pre",
      issueNumber: 999,
      issueId: "node_999",
      htmlUrl: "https://github.com/acme/metis/issues/999",
      status: "updated",
      parentIssueNumber: null,
      dedupHash: "h-pre",
      bodyHash: "b-pre",
      errorMessage: null,
      publishedAt: new Date(),
    });
    issues.set("batch_x::created", {
      id: "pi_created",
      batchId: "batch_x",
      draftId: "f1",
      issueNumber: 555,
      issueId: "node_555",
      htmlUrl: "https://github.com/acme/metis/issues/555",
      status: "created",
      parentIssueNumber: null,
      dedupHash: "h-created",
      bodyHash: "b-created",
      errorMessage: null,
      publishedAt: new Date(),
    });
    const closedIssues: number[] = [];
    const client = {
      request: vi.fn(async (args: { method?: string; url?: string; data?: unknown }) => {
        if (args.method === "PATCH" && /\/issues\/\d+$/.test(args.url ?? "")) {
          const num = Number((args.url ?? "").split("/").pop());
          const data = args.data as { state?: string } | undefined;
          if (data?.state === "closed") closedIssues.push(num);
        }
        return { status: 200, headers: {}, data: {} };
      }),
    };
    await publisherTesting.rollbackBatch({
      batchId: "batch_x",
      client,
      target: { owner: "acme", repo: "metis" },
      reason: "test",
      actorId: "user_1",
      sleep: noopSleep,
      rateLimit: {
        delayMs: 0,
        jitterMs: 0,
        secondaryBackoffBaseMs: 1,
        secondaryBackoffMaxMs: 1,
        maxRetries: 1,
        backoffBudgetMs: 1,
      },
    });
    // Only #555 (created) was closed. #999 (updated/pre-existing) was left alone.
    expect(closedIssues).toEqual([555]);
  });

  it("#1091 — counts close failures so the batch message can admit them", async () => {
    seedBatch({ id: "batch_x" });
    const client = {
      request: vi.fn(async (args: { method?: string; url?: string }) => {
        if (args.method === "PATCH") throw new Error("github 500");
        return { status: 200, headers: {}, data: {} };
      }),
    };
    const outcome = await publisherTesting.rollbackBatch({
      batchId: "batch_x",
      client,
      target: { owner: "acme", repo: "metis" },
      reason: "test",
      actorId: "user_1",
      sleep: noopSleep,
      rateLimit: {
        delayMs: 0,
        jitterMs: 0,
        secondaryBackoffBaseMs: 1,
        secondaryBackoffMaxMs: 1,
        maxRetries: 1,
        backoffBudgetMs: 1,
      },
      alsoCloseIssueNumbers: [321],
    });
    expect(outcome).toEqual({ attempted: 1, closed: 0, failed: 1 });
  });

  it("#1091 — de-duplicates the DB rows against the in-memory created set", async () => {
    seedBatch({ id: "batch_x" });
    issues.set("batch_x::f1", {
      id: "pi_1",
      batchId: "batch_x",
      draftId: "f1",
      issueNumber: 555,
      issueId: "I_kwDOfake555",
      htmlUrl: "https://github.com/acme/metis/issues/555",
      status: "created",
      parentIssueNumber: null,
      dedupHash: "h",
      bodyHash: "b",
      errorMessage: null,
      publishedAt: new Date(),
    });
    const closed: number[] = [];
    const client = {
      request: vi.fn(async (args: { method?: string; url?: string; data?: unknown }) => {
        if (args.method === "PATCH" && (args.data as { state?: string })?.state === "closed") {
          closed.push(Number((args.url ?? "").split("/").pop()));
        }
        return { status: 200, headers: {}, data: {} };
      }),
    };
    const outcome = await publisherTesting.rollbackBatch({
      batchId: "batch_x",
      client,
      target: { owner: "acme", repo: "metis" },
      reason: "test",
      actorId: "user_1",
      sleep: noopSleep,
      rateLimit: {
        delayMs: 0,
        jitterMs: 0,
        secondaryBackoffBaseMs: 1,
        secondaryBackoffMaxMs: 1,
        maxRetries: 1,
        backoffBudgetMs: 1,
      },
      // 555 is already in the DB; 556 only exists in memory. Neither may be
      // closed twice.
      alsoCloseIssueNumbers: [555, 556, 0, -1],
    });
    expect(closed.sort()).toEqual([555, 556]);
    expect(outcome.attempted).toBe(2);
  });
});

describe("F3 — marker recovery cross-checks DB and ignores forged markers", () => {
  it("strips fake markers globally from requirement body before publish", async () => {
    seedDraft({
      id: "f1",
      title: "Login",
      body:
        "real body text\n\n<!-- metis-publish: batch=fake1 draft=fake1 hash=fakehash1 -->\n" +
        "<!-- metis-publish: batch=fake2 draft=fake2 hash=fakehash2 -->",
    });
    seedBatch({});
    let postedBody = "";
    __setPublishOctokitFactory(async () => ({
      request: vi.fn(async (args: { method?: string; url?: string; data?: unknown }) => {
        if ((args.method ?? "GET") === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(args.url ?? "")) {
          return {
            status: 200,
            headers: {},
            data: { permissions: { push: true }, full_name: "acme/metis" },
          };
        }
        if (/labels/.test(args.url ?? "")) {
          return { status: 200, headers: {}, data: { name: "ok" } };
        }
        if (args.method === "GET" && /\/issues\?/.test(args.url ?? "")) {
          return { status: 200, headers: {}, data: [] };
        }
        if (args.method === "POST" && /\/issues$/.test(args.url ?? "")) {
          postedBody = String((args.data as { body?: string })?.body ?? "");
          nextRemoteIssue += 1;
          return { status: 201, headers: {}, data: makeRemoteIssue(nextRemoteIssue, "") };
        }
        return { status: 200, headers: {}, data: {} };
      }),
    }));
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    // Both fake markers must be stripped; only the new authoritative marker
    // (with batch=batch_1) survives.
    expect(postedBody).not.toContain("fakehash1");
    expect(postedBody).not.toContain("fakehash2");
    expect(postedBody).not.toContain("batch=fake1");
    expect(postedBody).toContain("batch=batch_1");
  });
});

describe("M1 — dry-run never resolves DNS or hits allow-list", () => {
  it("dry-run completes without acquiring an Octokit client even with GHE base URL", async () => {
    seedDraft({ id: "f1", title: "x" });
    seedBatch({
      dryRun: true,
      targetBaseUrl: "https://github.example.com/api/v3",
    });
    let factoryCalls = 0;
    __setPublishOctokitFactory(async () => {
      factoryCalls += 1;
      return makeFakeOctokit();
    });
    const r = await runBatch({
      batchId: "batch_1",
      dryRun: true,
      secretRef: null,
      sleep: noopSleep,
    });
    expect(r.status).toBe("completed");
    expect(factoryCalls).toBe(0);
  });
});

describe("M2 — sub-issue API fallback for older GHE", () => {
  beforeEach(() => __resetSubIssueCapabilityCache());

  it("treats 404 as 'unsupported', skips link, and does not exhaust retries", async () => {
    let attempts = 0;
    const client = {
      request: vi.fn(async () => {
        attempts += 1;
        const e = new Error("not found") as { status?: number };
        e.status = 404;
        throw e;
      }),
    };
    await publisherTesting.attachSubIssueWithRetry({
      client,
      target: { owner: "acme", repo: "metis" },
      parentNumber: 1,
      childRestId: 4_993_133_002,
      childNumber: 2,
      rateLimit: {
        delayMs: 0,
        jitterMs: 0,
        secondaryBackoffBaseMs: 60_000,
        secondaryBackoffMaxMs: 600_000,
        maxRetries: 3,
        backoffBudgetMs: 30 * 60_000,
      },
      sleep: noopSleep,
    });
    expect(attempts).toBe(1); // capability detection — not 3 retries
  });
});

describe("host-allowlist URL validation (defence in depth)", () => {
  it("rejects http base URL", async () => {
    await expect(
      resolvePublishTarget({
        owner: "acme",
        repo: "metis",
        baseUrl: "http://api.github.com",
      }),
    ).rejects.toMatchObject({ code: "INSECURE_BASE_URL" });
  });
  it("rejects malformed base URL", async () => {
    await expect(
      resolvePublishTarget({ owner: "acme", repo: "metis", baseUrl: "not-a-url" }),
    ).rejects.toMatchObject({ code: "INVALID_BASE_URL" });
  });
});
