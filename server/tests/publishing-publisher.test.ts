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
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

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
  /** `github` when left out, as the column defaults. */
  destination?: string;
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
      // Honours `where.status` as the real client does: `runBatch` and the
      // preview ask for `draft | approved | publishing | failed`, which is what
      // keeps an already-published draft out of a run. A double that ignored it
      // could not show that, and PATCHed issues the real query never selects.
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { id?: { in?: string[] }; projectId: string; status?: { in?: string[] } };
        }) => {
          let rows = [...drafts.values()].filter(
            (d) => d.projectId === where.projectId && !d.deletedAt,
          );
          if (where.status?.in) rows = rows.filter((d) => where.status!.in!.includes(d.status));
          if (where.id?.in) rows = rows.filter((d) => where.id!.in!.includes(d.id));
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
        async ({
          where,
        }: {
          where: { draftId?: string; destination?: string; batch?: { projectId?: string } };
        }) => {
          for (const row of issues.values()) {
            if (where.draftId && row.draftId !== where.draftId) continue;
            if (where.destination && (row.destination ?? "github") !== where.destination) continue;
            const b = batches.get(row.batchId);
            const out = { ...row, batch: b ?? null };
            if (where.batch?.projectId && b?.projectId !== where.batch.projectId) continue;
            return out;
          }
          return null;
        },
      ),
      findMany: vi.fn(
        async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
          const out: Array<PublishedIssueRow & { batch?: BatchRow | null }> = [];
          for (const row of issues.values()) {
            if ((where.batchId as string | undefined) && row.batchId !== where.batchId) continue;
            // #1276 — the earlier-published parent epic lookup.
            const draftIn = (where.draftId as { in?: string[] } | undefined)?.in;
            if (draftIn && !draftIn.includes(row.draftId)) continue;
            if (
              typeof where.destination === "string" &&
              (row.destination ?? "github") !== where.destination
            )
              continue;
            const gt = (where.issueNumber as { gt?: number } | undefined)?.gt;
            if (gt !== undefined && !(row.issueNumber > gt)) continue;
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
            out.push(include ? { ...row, batch: batches.get(row.batchId) ?? null } : row);
          }
          return out;
        },
      ),
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
          const row: PublishedIssueRow = Object.assign(
            {
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
            },
            create,
          );
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
import {
  runBatch,
  archiveBatch,
  configurePublisher,
  previewBatchPlan,
} from "../src/lib/publishing/publisher.js";
import { audit } from "../src/lib/audit/audit-service.js";
import { prisma } from "../src/lib/prisma.js";
import { resolveVaultRef } from "../src/lib/connectors/vault-resolver.js";
import { computeBodyHash, computeDedupHash, stripMarker } from "../src/lib/publishing/dedup.js";
import { renderCodeLinksSection } from "../src/lib/publishing/draft-code-links.js";
import { rollbackOutcomeMessage } from "../src/lib/publishing/publisher.js";
import type {
  GhIssue,
  OctokitRequestArgs,
  OctokitResponseLike,
  PublishOctokitLike,
} from "../src/lib/publishing/types.js";
import realIssueFixture from "./fixtures/github-rest-issue.json" with { type: "json" };

/** `request<T>` is caller-typed, as on the real client: `T` is what the caller
 * asserts the body holds, so a fake can only hand back `unknown` data. */
function fakeOctokit(client: {
  request: (args: OctokitRequestArgs) => Promise<OctokitResponseLike>;
}): PublishOctokitLike {
  return client as PublishOctokitLike;
}

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
    // #1106 review — the recorded fixture names octocat/Hello-World here.
    repository_url: "https://api.github.com/repos/acme/metis",
    body,
  } as FakeIssue;
}

const remoteIssues = new Map<number, FakeIssue>();

function makeFakeOctokit(opts?: {
  failOnCreate?: number; // fail the Nth create
  rejectAuth?: boolean;
  alwaysFailCreate?: boolean;
}): PublishOctokitLike {
  let createCount = 0;
  return fakeOctokit({
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
      // Issue list — paged as GitHub pages it (#1106: `per_page`, `page`).
      if (method === "GET" && /\/issues\?/.test(url)) {
        const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
        const perPage = Number(query.get("per_page") ?? 30);
        const page = Number(query.get("page") ?? 1);
        const all = [...remoteIssues.values()];
        return { status: 200, headers: {}, data: all.slice((page - 1) * perPage, page * perPage) };
      }
      // One issue, by number (#1106). An unknown number is GitHub's 404.
      if (method === "GET" && /\/issues\/\d+$/.test(url)) {
        const found = remoteIssues.get(Number(url.split("/").pop()));
        if (!found) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { status: 200, headers: {}, data: found };
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
  });
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

describe("runBatch — labels (#744)", () => {
  it("never sends a finding:<id> label, and upserts only labels some draft carries", async () => {
    seedDraft({
      id: "feat_1",
      title: "[Feature] Feed refresh",
      labels: JSON.stringify(["feature", "metis-generated", "finding:cmv1tix0d0vyu7d9kr8tbqrgq"]),
    });
    seedBatch({});
    const calls: OctokitRequestArgs[] = [];
    const base = makeFakeOctokit();
    __setPublishOctokitFactory(async () =>
      fakeOctokit({
        request: async (args) => {
          calls.push(args);
          return base.request(args);
        },
      }),
    );
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });

    const labelPuts = calls
      .filter((c) => c.method === "PUT" && /\/labels\//.test(c.url ?? ""))
      .map((c) => decodeURIComponent((c.url ?? "").split("/labels/")[1]));
    expect(labelPuts).toEqual(["feature", "metis-generated"]);
    const create = calls.find((c) => c.method === "POST" && /\/issues$/.test(c.url ?? ""));
    expect((create?.data as { labels: string[] }).labels).toEqual(["feature", "metis-generated"]);
  });
});

describe("#1049 — the batch's Additional labels reach every issue it writes", () => {
  const ADDITIONAL = ["sprint-42", "Feature", "unverified", "finding:abc", "  "];

  async function publishRecording(): Promise<OctokitRequestArgs[]> {
    const calls: OctokitRequestArgs[] = [];
    const base = makeFakeOctokit();
    __setPublishOctokitFactory(async () =>
      fakeOctokit({
        request: async (args) => {
          calls.push(args);
          return base.request(args);
        },
      }),
    );
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    return calls;
  }

  it("a created issue carries them, once each, never an internal one", async () => {
    seedDraft({ id: "feat_1", title: "[Feature] Login", labels: '["feature"]' });
    seedBatch({
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: ADDITIONAL }),
    });
    const calls = await publishRecording();
    const create = calls.find((c) => c.method === "POST" && /\/issues$/.test(c.url ?? ""));
    expect((create?.data as { labels: string[] }).labels).toEqual(["feature", "sprint-42"]);
  });

  it("an updated issue carries them too", async () => {
    seedDraft({ id: "feat_1", title: "[Feature] Login", body: "new body", labels: '["feature"]' });
    seedBatch({ id: "batch_0", status: "completed" });
    issues.set(pubIssueKey("batch_0", "feat_1"), {
      id: "pi_old",
      batchId: "batch_0",
      draftId: "feat_1",
      issueNumber: 55,
      issueId: "I_kwDOold55",
      htmlUrl: "https://github.com/acme/metis/issues/55",
      status: "created",
      parentIssueNumber: null,
      dedupHash: computeDedupHash("acme", "metis", "[Feature] Login"),
      bodyHash: computeBodyHash("old body"),
      errorMessage: null,
      publishedAt: new Date(),
    });
    seedBatch({
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: ["sprint-42"] }),
    });
    const calls = await publishRecording();
    const patch = calls.find((c) => c.method === "PATCH" && /\/issues\/55$/.test(c.url ?? ""));
    expect((patch?.data as { labels: string[] }).labels).toEqual(["feature", "sprint-42"]);
  });

  /** Issue #55, published unchanged by `batch_0` with that batch's Additional labels. */
  function seedEarlierPublish(earlierLabels: string[]) {
    seedDraft({ id: "feat_1", title: "[Feature] Login", body: "same body", labels: '["feature"]' });
    seedBatch({
      id: "batch_0",
      status: "completed",
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: earlierLabels }),
    });
    issues.set(pubIssueKey("batch_0", "feat_1"), {
      id: "pi_old",
      batchId: "batch_0",
      draftId: "feat_1",
      issueNumber: 55,
      issueId: "I_kwDOold55",
      htmlUrl: "https://github.com/acme/metis/issues/55",
      status: "created",
      parentIssueNumber: null,
      dedupHash: computeDedupHash("acme", "metis", "[Feature] Login"),
      bodyHash: computeBodyHash("same body"),
      errorMessage: null,
      publishedAt: new Date("2026-10-01T00:00:00Z"),
    });
  }

  it("review — an unchanged issue gets this batch's labels when they differ (labels only)", async () => {
    seedEarlierPublish(["sprint-41"]);
    seedBatch({
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: ["sprint-42"] }),
    });
    const calls = await publishRecording();
    const patches = calls.filter((c) => c.method === "PATCH" && /\/issues\/55$/.test(c.url ?? ""));
    expect(patches.map((c) => c.data)).toEqual([{ labels: ["feature", "sprint-42"] }]);
    // Still a dedup skip: no body was sent, and the new row names the issue.
    expect(batches.get("batch_1")!.dedupSkipped).toBe(1);
    expect(issues.get(pubIssueKey("batch_1", "feat_1"))!.issueNumber).toBe(55);
  });

  it("review — an unchanged issue whose labels already match is not touched", async () => {
    seedEarlierPublish(["Sprint-42"]);
    seedBatch({
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: ["sprint-42"] }),
    });
    const calls = await publishRecording();
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("review — the dry run says the skipped issue's labels will be updated", async () => {
    seedEarlierPublish(["sprint-41"]);
    seedBatch({
      dryRun: true,
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: ["sprint-42"] }),
    });
    await runBatch({ batchId: "batch_1", dryRun: true, secretRef: null, sleep: noopSleep });
    const plan = JSON.parse(batches.get("batch_1")!.dryRunPlan!) as {
      actions: Array<{ kind: string; reason?: string; labels?: string[] }>;
    };
    expect(plan.actions.find((a) => a.kind === "issue.skipDuplicate")).toMatchObject({
      reason: "body unchanged; labels updated",
      labels: ["feature", "sprint-42"],
    });
  });

  it("the dry run and the preview list them on each issue the live run writes", async () => {
    seedDraft({ id: "feat_1", title: "[Feature] Login", labels: '["feature"]' });
    seedBatch({
      dryRun: true,
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: ADDITIONAL }),
    });
    await runBatch({ batchId: "batch_1", dryRun: true, secretRef: null, sleep: noopSleep });
    const plan = JSON.parse(batches.get("batch_1")!.dryRunPlan!) as {
      actions: Array<{ kind: string; labels?: string[] }>;
    };
    expect(plan.actions.find((a) => a.kind === "issue.create")!.labels).toEqual([
      "feature",
      "sprint-42",
    ]);
    const preview = await previewBatchPlan({
      projectId: "proj_1",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      draftIds: ["feat_1"],
      additionalLabels: ADDITIONAL,
      secretRef: null,
    });
    expect(preview.actions.find((a) => a.kind === "issue.create")!.labels).toEqual([
      "feature",
      "sprint-42",
    ]);
  });
});

describe("#1276 — what a sub-issue body and labels carry onto GitHub", () => {
  const PARENT_LINE = "> Parent epic: **[Epic] Apollo — 2 requirements**";
  const FEATURE_BODY = `${PARENT_LINE}\n\n## Description\n\nLogin.\n\n## Acceptance criteria\n\n- [ ] ok`;
  const EPIC_URL = "https://github.com/acme/metis/issues/7";

  /** The epic, published as #7 by an earlier batch `batch_0` into `owner/repo`. */
  const EPIC_BODY = "## Goal\n\nTrack the requirements.";

  function seedEarlierEpic(
    over: {
      owner?: string;
      repo?: string;
      archived?: boolean;
      baseUrl?: string | null;
      epicStatus?: string;
    } = {},
  ) {
    seedDraft({
      id: "epic_1",
      title: "[Epic] Apollo — 2 requirements",
      draftType: "epic",
      labels: '["epic"]',
      body: EPIC_BODY,
      status: over.epicStatus ?? "published",
    });
    seedBatch({
      id: "batch_0",
      status: "completed",
      targetOwner: over.owner ?? "acme",
      targetRepo: over.repo ?? "metis",
      targetBaseUrl: over.baseUrl ?? null,
      archived: over.archived ?? false,
    });
    issues.set(pubIssueKey("batch_0", "epic_1"), {
      id: "pi_epic",
      batchId: "batch_0",
      draftId: "epic_1",
      issueNumber: 7,
      issueId: "I_kwDOepic7",
      htmlUrl: EPIC_URL,
      status: "created",
      parentIssueNumber: null,
      dedupHash: computeDedupHash("acme", "metis", "[Epic] Apollo — 2 requirements"),
      // The epic's body as published, so a batch that holds it dedup-skips it.
      bodyHash: computeBodyHash(EPIC_BODY),
      errorMessage: null,
      publishedAt: new Date("2026-10-01T00:00:00Z"),
    });
  }

  async function publish(): Promise<OctokitRequestArgs[]> {
    const calls: OctokitRequestArgs[] = [];
    const base = makeFakeOctokit();
    __setPublishOctokitFactory(async () =>
      fakeOctokit({
        request: async (args) => {
          calls.push(args);
          return base.request(args);
        },
      }),
    );
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    return calls;
  }

  const created = (calls: OctokitRequestArgs[], title: string) =>
    calls.find(
      (c) =>
        c.method === "POST" &&
        /\/issues$/.test(c.url ?? "") &&
        (c.data as { title?: string }).title === title,
    )?.data as { body: string; labels: string[] } | undefined;

  it("names an epic published in an earlier batch by number and link", async () => {
    seedEarlierEpic();
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    seedBatch({ metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: [] }) });
    const calls = await publish();
    const body = created(calls, "[Feature] Login")!.body;
    expect(body.split("\n")[0]).toBe(`${PARENT_LINE} ([#7](${EPIC_URL}))`);
    // The stored draft is not rewritten: the number is filled in at publish time.
    expect(drafts.get("feat_1")!.body).toBe(FEATURE_BODY);
    // The body hash covers what was sent, so a retry dedup-skips rather than re-patching.
    const row = [...issues.values()].find((r) => r.draftId === "feat_1")!;
    expect(row.bodyHash).toBe(computeBodyHash(stripMarker(body).trimEnd()));
  });

  it("matches the earlier batch's repository case-insensitively", async () => {
    seedEarlierEpic({ owner: "ACME", repo: "Metis" });
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    seedBatch({ metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: [] }) });
    const body = created(await publish(), "[Feature] Login")!.body;
    expect(body.split("\n")[0]).toContain("[#7]");
  });

  it.each([
    ["another repository", { repo: "other" }],
    ["an archived batch", { archived: true }],
  ])("does not name an epic published to %s", async (_label, over) => {
    seedEarlierEpic(over);
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    seedBatch({ metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: [] }) });
    const calls = await publish();
    const body = created(calls, "[Feature] Login")?.body;
    expect(body, JSON.stringify(calls.map((c) => [c.method, c.url]))).toBeDefined();
    expect(body!.split("\n")[0]).toBe(PARENT_LINE);
  });

  it("leaves the body of a sub-issue whose epic is in the same batch as it was", async () => {
    seedDraft({
      id: "epic_1",
      title: "[Epic] Apollo — 2 requirements",
      draftType: "epic",
      labels: '["epic"]',
    });
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    seedBatch({});
    const calls = await publish();
    expect(created(calls, "[Feature] Login")!.body.split("\n")[0]).toBe(PARENT_LINE);
    // …and it is still attached as a sub-issue of the epic created in this run.
    expect(calls.some((c) => c.method === "POST" && /\/sub_issues$/.test(c.url ?? ""))).toBe(true);
  });

  it("never sends or upserts `unverified`, and says it in one sentence instead", async () => {
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      body: FEATURE_BODY,
      labels: JSON.stringify(["feature", "security", "unverified"]),
    });
    seedBatch({});
    const calls = await publish();
    const labelUrls = calls
      .filter((c) => /\/labels/.test(c.url ?? ""))
      .map((c) => decodeURIComponent(c.url ?? ""));
    expect(labelUrls.some((u) => /unverified/i.test(u))).toBe(false);
    const sent = created(calls, "[Feature] Login")!;
    expect(sent.labels).toEqual(["feature", "security"]);
    expect(sent.body).toContain(
      "METIS could not confirm the code references behind this item; check them before relying on them.",
    );
    // Inside METIS the label stays on the draft.
    expect(JSON.parse(drafts.get("feat_1")!.labels)).toContain("unverified");
  });

  it("the dry run shows the same body and labels the live run sends", async () => {
    seedEarlierEpic();
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
      labels: JSON.stringify(["feature", "unverified"]),
    });
    seedBatch({
      dryRun: true,
      metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: [] }),
    });
    await runBatch({ batchId: "batch_1", dryRun: true, secretRef: null, sleep: noopSleep });
    const plan = JSON.parse(batches.get("batch_1")!.dryRunPlan!) as {
      actions: Array<{ kind: string; body?: string; labels?: string[] }>;
    };
    const create = plan.actions.find((a) => a.kind === "issue.create")!;
    expect(create.body!.split("\n")[0]).toBe(`${PARENT_LINE} ([#7](${EPIC_URL}))`);
    expect(create.body).toContain("METIS could not confirm the code references");
    expect(create.labels).toEqual(["feature"]);
    const upserts = plan.actions.filter((a) => a.kind === "label.upsert").flatMap((a) => a.labels);
    expect(upserts).not.toContain("unverified");
  });

  it("the pre-publish preview shows it too", async () => {
    seedEarlierEpic();
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    const plan = await previewBatchPlan({
      projectId: "proj_1",
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      draftIds: ["feat_1"],
      additionalLabels: [],
      secretRef: null,
    });
    const create = plan.actions.find((a) => a.kind === "issue.create")!;
    expect(create.body!.split("\n")[0]).toBe(`${PARENT_LINE} ([#7](${EPIC_URL}))`);
  });

  it("names an already-published epic whether or not it is in the batch, so a re-publish patches nothing", async () => {
    // The epic was published (#7) and regenerated since, so a batch can select it again.
    seedEarlierEpic({ epicStatus: "approved" });
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    // Batch 1: the sub-issue alone.
    seedBatch({ metadata: JSON.stringify({ draftIds: ["feat_1"], additionalLabels: [] }) });
    const first = await publish();
    const alone = created(first, "[Feature] Login")!.body;
    expect(alone.split("\n")[0]).toBe(`${PARENT_LINE} ([#7](${EPIC_URL}))`);

    // Batch 2: the same sub-issue (regenerated, unchanged) with its already-published epic.
    drafts.get("feat_1")!.status = "approved";
    drafts.get("epic_1")!.status = "approved";
    seedBatch({
      id: "batch_2",
      metadata: JSON.stringify({ draftIds: ["epic_1", "feat_1"], additionalLabels: [] }),
    });
    const calls: OctokitRequestArgs[] = [];
    const base = makeFakeOctokit();
    __setPublishOctokitFactory(async () =>
      fakeOctokit({
        request: async (args) => {
          calls.push(args);
          return base.request(args);
        },
      }),
    );
    await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    const writes = calls.filter(
      (c) => (c.method === "PATCH" || c.method === "POST") && /\/issues(\/\d+)?$/.test(c.url ?? ""),
    );
    expect(writes).toEqual([]);
    expect(batches.get("batch_2")!.dedupSkipped).toBe(2);
  });

  it("the dry run plans the same body for the sub-issue with or without its published epic", async () => {
    seedEarlierEpic({ epicStatus: "approved" });
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    const bodyFor = async (draftIds: string[]) => {
      const plan = await previewBatchPlan({
        projectId: "proj_1",
        targetOwner: "acme",
        targetRepo: "metis",
        targetBaseUrl: null,
        provider: "github",
        draftIds,
        additionalLabels: [],
        secretRef: null,
      });
      return plan.actions.find((a) => a.kind === "issue.create" && a.draftId === "feat_1")!.body;
    };
    expect(await bodyFor(["epic_1", "feat_1"])).toBe(await bodyFor(["feat_1"]));
  });

  it("does not link an epic whose earlier issue is on another API host (GHES vs github.com)", async () => {
    seedEarlierEpic({ baseUrl: "https://ghe.example.com/api/v3" });
    seedDraft({
      id: "feat_1",
      title: "[Feature] Login",
      parentDraftId: "epic_1",
      body: FEATURE_BODY,
    });
    const firstLine = async (targetBaseUrl: string | null) => {
      const plan = await previewBatchPlan({
        projectId: "proj_1",
        targetOwner: "acme",
        targetRepo: "metis",
        targetBaseUrl,
        provider: targetBaseUrl ? "github_enterprise" : "github",
        draftIds: ["feat_1"],
        additionalLabels: [],
        secretRef: null,
      });
      return plan.actions.find((a) => a.kind === "issue.create")!.body!.split("\n")[0];
    };
    // Same owner/repo name on github.com is another repository.
    expect(await firstLine(null)).toBe(PARENT_LINE);
    // The same GHES host (any case, trailing slash) is the same repository.
    expect(await firstLine("https://GHE.example.com/api/v3/")).toBe(
      `${PARENT_LINE} ([#7](${EPIC_URL}))`,
    );
  });
});

describe("#1091 — issue identifiers (recorded GitHub REST shape)", () => {
  /**
   * Run `fn` with the success-path `publishedIssue.upsert` throwing, then
   * restore. `vi.clearAllMocks()` clears calls but NOT implementations, so an
   * un-restored override would leak into every later test in this file.
   */
  async function withFailingPersistence(message: string, fn: () => Promise<void>): Promise<void> {
    // `prisma` is vi.mock'ed: this delegate is the in-memory mock, not the fluent client.
    const upsert = prisma.publishedIssue.upsert as unknown as Mock<
      (args: { create?: { status?: string } }) => Promise<unknown>
    >;
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

  it("#1064 — writes the ids as a hidden source marker, and still recognises the issue on a retry", async () => {
    seedDraft({
      id: "f1",
      title: "Login",
      body: "Text\n\n---\n> Generated by METIS",
      requirementId: "req_1",
      metadata: JSON.stringify({ analysisId: "analysis_1" }),
    });
    seedBatch({ id: "batch_1" });
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    await runBatch({
      batchId: "batch_1",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    const created = [...remoteIssues.values()][0]!;
    const hash = computeDedupHash("acme", "metis", "Login");
    expect(created.body).toBe(
      "Text\n\n---\n> Generated by METIS\n\n" +
        "<!-- metis-source: project=proj_1 analysis=analysis_1 requirement=req_1 -->\n" +
        `<!-- metis-publish: batch=batch_1 draft=f1 hash=${hash} -->\n`,
    );

    // The local dedup signal is lost; only the remote body can identify it.
    [...issues.values()][0]!.dedupHash = null;
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
    await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    // Both markers were stripped before hashing, so the body reads as unchanged.
    expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
    expect(remoteIssues.size).toBe(1);
  });

  it("#1064 — an issue published with the old visible footer is still recognised, not duplicated", async () => {
    // What METIS wrote before #1064: the ids in a visible footer, and only the
    // publish marker. The draft still holds that body (its text was signed off).
    const oldBody =
      "Text\n\n---\n> Generated by METIS · project=`proj_1xx` · analysis=`analysis` · requirement=`req_1`";
    const hash = computeDedupHash("acme", "metis", "Login");
    seedDraft({ id: "f1", title: "Login", body: oldBody, requirementId: "req_1" });
    seedBatch({ id: "batch_old", status: "completed" });
    issues.set("batch_old::f1", {
      id: "pi_old",
      batchId: "batch_old",
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
    remoteIssues.set(
      42,
      makeRemoteIssue(
        42,
        `${oldBody}\n\n<!-- metis-publish: batch=batch_old draft=f1 hash=${hash} -->\n`,
      ),
    );
    seedBatch({
      id: "batch_2",
      status: "pending",
      metadata: JSON.stringify({
        draftIds: ["f1"],
        additionalLabels: [],
        secretRef: "${vault:gh}",
      }),
    });
    __setPublishOctokitFactory(async () => makeFakeOctokit());
    const result = await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(result.status).toBe("completed");
    expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
    expect(remoteIssues.size).toBe(1);
    // Untouched: an unchanged body is skipped, so no marker is added behind the user's back.
    expect(remoteIssues.get(42)!.body).not.toContain("metis-source");
  });

  describe("#1064 — issues published before the change, after Generate rewrote their drafts", () => {
    const OLD = (n: number) =>
      `Text ${n}\n\n---\n> Generated by METIS · project=\`proj_1xx\` · analysis=\`analysis\` · requirement=\`req_${n}\``;
    const NEW = (n: number) =>
      `Text ${n}\n\n## Related code\n\n- \`src/f${n}.ts\`\n\n---\n> Generated by METIS`;

    /** A draft published under the old body, with its issue on the tracker. */
    function seedPublished(n: number, over: Partial<DraftRow> = {}): void {
      const title = `Feature ${n}`;
      const hash = computeDedupHash("acme", "metis", title);
      seedDraft({ id: `f${n}`, title, body: NEW(n), status: "published", ...over });
      issues.set(`batch_old::f${n}`, {
        id: `pi_old_${n}`,
        batchId: "batch_old",
        draftId: `f${n}`,
        issueNumber: 40 + n,
        issueId: `I_kwDOfake${40 + n}`,
        htmlUrl: `https://github.com/acme/metis/issues/${40 + n}`,
        status: "created",
        parentIssueNumber: null,
        dedupHash: hash,
        bodyHash: computeBodyHash(OLD(n)),
        errorMessage: null,
        publishedAt: new Date(),
      });
      remoteIssues.set(
        40 + n,
        makeRemoteIssue(
          40 + n,
          `${OLD(n)}\n\n<!-- metis-publish: batch=batch_old draft=f${n} hash=${hash} -->\n`,
        ),
      );
    }

    function countingOctokit(): { client: PublishOctokitLike; writes: string[] } {
      const inner = makeFakeOctokit();
      const writes: string[] = [];
      const client = fakeOctokit({
        request: async (args) => {
          const method = args.method ?? "GET";
          if (/\/issues(\/\d+)?$/.test(args.url ?? "") && method !== "GET") {
            writes.push(`${method} ${args.url}`);
          }
          return inner.request(args);
        },
      });
      return { client, writes };
    }

    it("N published drafts regenerated → the next publish selects none and updates nothing", async () => {
      // After upgrading, an ordinary Generate rewrote all three bodies; the
      // drafts are still `published`.
      for (const n of [1, 2, 3]) seedPublished(n);
      seedBatch({ id: "batch_old", status: "completed" });
      const before = new Map([...remoteIssues].map(([n, i]) => [n, i.body]));
      seedBatch({ id: "batch_2", status: "pending" });
      const { client, writes } = countingOctokit();
      __setPublishOctokitFactory(async () => client);

      await runBatch({
        batchId: "batch_2",
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });

      expect(writes).toEqual([]);
      expect(batches.get("batch_2")).toMatchObject({ totalDrafts: 0, publishedCount: 0 });
      // The issues are exactly as they were published: old footer, no source marker.
      for (const [n, body] of before) expect(remoteIssues.get(n)!.body).toBe(body);

      // And a dry run of the same selection plans nothing for them.
      seedBatch({ id: "batch_dry", status: "pending", dryRun: true });
      await runBatch({
        batchId: "batch_dry",
        dryRun: true,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });
      const plan = JSON.parse(batches.get("batch_dry")!.dryRunPlan!) as {
        actions: Array<{ kind: string }>;
      };
      expect(plan.actions.filter((a) => a.kind.startsWith("issue."))).toEqual([]);
    });

    it("a still-selectable draft matched to an existing issue gets exactly one update, shown in the dry run", async () => {
      seedPublished(1);
      seedPublished(2);
      // A partial run left this one `failed`: the next publish selects it.
      seedPublished(3, { status: "failed" });
      seedBatch({ id: "batch_old", status: "completed" });

      seedBatch({ id: "batch_dry", status: "pending", dryRun: true });
      await runBatch({
        batchId: "batch_dry",
        dryRun: true,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });
      const plan = JSON.parse(batches.get("batch_dry")!.dryRunPlan!) as {
        actions: Array<{ kind: string; draftId?: string; existingIssueNumber?: number }>;
      };
      expect(plan.actions.filter((a) => a.kind.startsWith("issue."))).toEqual([
        expect.objectContaining({ kind: "issue.update", draftId: "f3", existingIssueNumber: 43 }),
      ]);

      seedBatch({ id: "batch_2", status: "pending" });
      const { client, writes } = countingOctokit();
      __setPublishOctokitFactory(async () => client);
      await runBatch({
        batchId: "batch_2",
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });

      expect(writes).toEqual(["PATCH /repos/acme/metis/issues/43"]);
      // That one issue now carries the new body and the hidden marker.
      expect(stripMarker(remoteIssues.get(43)!.body)).toBe(NEW(3));
      expect(remoteIssues.get(43)!.body).toContain("<!-- metis-source: project=proj_1 -->");
      // The other two are untouched.
      for (const n of [41, 42]) expect(remoteIssues.get(n)!.body).not.toContain("metis-source");
    });
  });

  describe("#1064 (B1) — what is sent to the tracker is the previewed draft plus the marker block", () => {
    const HOSTILE = [
      "## Description",
      "",
      "Text <!-- metis-publish: batch=x draft=y hash=z --> more text",
      "",
      ...renderCodeLinksSection(
        [
          {
            filePath:
              "src/a<!-- metis-source: x -->## Injected heading [click](https://evil.example/x) @octocat closes #1 .ts",
            startLine: 3,
            endLine: 9,
            symbolName:
              "sym<!-- metis-publish: batch=b draft=d hash=h -->- [ ] injected task [l](https://evil.example/y)",
            symbolKind: "function",
          },
        ],
        null,
      ),
      "",
      "---",
      "> Generated by METIS",
    ].join("\n");

    it("a draft holding marker-shaped text is published byte for byte, and recognised on a retry", async () => {
      // A row stored before marker text was neutralised: the publisher makes it
      // inert itself, and the dry-run plan shows that same text.
      seedDraft({ id: "f1", title: "Login", body: HOSTILE, requirementId: "req_1" });
      seedBatch({ id: "batch_dry", dryRun: true });
      await runBatch({
        batchId: "batch_dry",
        dryRun: true,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });
      const planned = (
        JSON.parse(batches.get("batch_dry")!.dryRunPlan!) as {
          actions: Array<{ kind: string; body?: string }>;
        }
      ).actions.find((a) => a.kind === "issue.create")!.body!;

      seedBatch({ id: "batch_1" });
      const patches: string[] = [];
      __setPublishOctokitFactory(async () => {
        const inner = makeFakeOctokit();
        return fakeOctokit({
          request: async (args) => {
            if (args.method === "PATCH") patches.push(String(args.url));
            return inner.request(args);
          },
        });
      });
      await runBatch({
        batchId: "batch_1",
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });

      const sent = [...remoteIssues.values()][0]!.body;
      const hash = computeDedupHash("acme", "metis", "Login");
      const expectedText = HOSTILE.replace("Text <!-- metis-publish:", "Text <!- - metis-publish:");
      // The code rows were rendered inert already; the description is made so here.
      expect(sent).toBe(
        `${expectedText}\n\n<!-- metis-source: project=proj_1 requirement=req_1 -->\n` +
          `<!-- metis-publish: batch=batch_1 draft=f1 hash=${hash} -->\n`,
      );
      // Line for line the same as the draft: nothing was cut into new lines.
      expect(sent.split("\n").slice(0, HOSTILE.split("\n").length)).toEqual(
        expectedText.split("\n"),
      );
      for (const line of sent.split("\n")) {
        expect(line.startsWith("## Injected")).toBe(false);
        expect(line.startsWith("- [ ] injected")).toBe(false);
      }
      // The dry run showed this text (its marker names the dry-run batch).
      expect(stripMarker(planned)).toBe(stripMarker(sent));

      // The local dedup signal is lost; the remote body must hash back to the
      // draft, or the issue would be PATCHed on this and every later run.
      [...issues.values()].find((r) => r.batchId === "batch_1")!.dedupHash = null;
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
      await runBatch({
        batchId: "batch_2",
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });
      expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
      expect(patches).toEqual([]);
      expect(remoteIssues.size).toBe(1);
      expect([...remoteIssues.values()][0]!.body).toBe(sent);
    });
  });

  describe("#1064 (M2) — a draft that links into the analysed repository is not published elsewhere", () => {
    const BASE = "https://github.com/acme/metis";
    const linked = () =>
      seedDraft({
        id: "f1",
        title: "Login",
        body: `- [\`a.ts\`](${BASE}/blob/0123abcd/a.ts)`,
        metadata: JSON.stringify({ codeLinkBase: BASE }),
      });

    it("runBatch refuses another target before any call, live or dry run", async () => {
      linked();
      const request = vi.fn();
      __setPublishOctokitFactory(async () => fakeOctokit({ request }));
      for (const dryRun of [false, true]) {
        seedBatch({ id: `batch_${dryRun}`, targetOwner: "someone", targetRepo: "public", dryRun });
        await expect(
          runBatch({
            batchId: `batch_${dryRun}`,
            dryRun,
            secretRef: "${vault:gh}",
            sleep: noopSleep,
          }),
        ).rejects.toMatchObject({ status: 409, code: "CODE_LINKS_TARGET_MISMATCH" });
        expect(batches.get(`batch_${dryRun}`)!.dryRunPlan).toBeNull();
      }
      expect(request).not.toHaveBeenCalled();
    });

    it("the pre-publish preview refuses it too", async () => {
      linked();
      await expect(
        previewBatchPlan({
          projectId: "proj_1",
          targetOwner: "someone",
          targetRepo: "public",
          targetBaseUrl: null,
          provider: "github",
          draftIds: ["f1"],
          additionalLabels: [],
          secretRef: "${vault:gh}",
        }),
      ).rejects.toMatchObject({ code: "CODE_LINKS_TARGET_MISMATCH" });
    });

    it("publishes into the repository the links point into", async () => {
      linked();
      seedBatch({ id: "batch_1" });
      __setPublishOctokitFactory(async () => makeFakeOctokit());
      const result = await runBatch({
        batchId: "batch_1",
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });
      expect(result.status).toBe("completed");
      expect([...remoteIssues.values()][0]!.body).toContain(`${BASE}/blob/0123abcd/a.ts`);
    });
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
      return fakeOctokit({
        request: async (args) => {
          // #1106 — the row's issue is read by number.
          if ((args.method ?? "GET") === "GET" && /\/issues\/42$/.test(args.url ?? "")) {
            return {
              status: 200,
              headers: {},
              data: {
                // No node_id at all.
                id: 4_993_133_999,
                number: 42,
                html_url: "https://github.com/acme/metis/issues/42",
                body: `body\n\n<!-- metis-publish: batch=batch_1 draft=f1 hash=${hash} -->`,
              },
            };
          }
          return base.request(args);
        },
      });
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
import { PublishError } from "../src/lib/publishing/types.js";

describe("F1 — sub-issue retry uses full backoff (no /100 divider)", () => {
  it("passes the documented exponential backoff into sleep", async () => {
    const calls: number[] = [];
    const failingClient = fakeOctokit({
      request: vi.fn(async (args: { url?: string; method?: string }) => {
        if ((args.method ?? "GET") === "POST" && /sub_issues$/.test(args.url ?? "")) {
          throw new Error("sub-issue attach failure");
        }
        return { status: 200, headers: {}, data: {} };
      }),
    });
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

  it("#1478 — does not retry a non-retryable PublishError (a refused redirect)", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const refused = new PublishError(
      502,
      "GITHUB_REDIRECT_REFUSED",
      "GitHub redirected the request to another origin; it was not followed",
    );
    const client = fakeOctokit({
      request: vi.fn(async () => {
        attempts += 1;
        throw refused;
      }),
    });
    await expect(
      publisherTesting.attachSubIssueWithRetry({
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
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    ).rejects.toBe(refused);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
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
    const client = fakeOctokit({
      request: vi.fn(async (args: { method?: string; url?: string; data?: unknown }) => {
        if (args.method === "PATCH" && /\/issues\/\d+$/.test(args.url ?? "")) {
          const num = Number((args.url ?? "").split("/").pop());
          const data = args.data as { state?: string } | undefined;
          if (data?.state === "closed") closedIssues.push(num);
        }
        return { status: 200, headers: {}, data: {} };
      }),
    });
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
    const client = fakeOctokit({
      request: vi.fn(async (args: { method?: string; url?: string }) => {
        if (args.method === "PATCH") throw new Error("github 500");
        return { status: 200, headers: {}, data: {} };
      }),
    });
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
    const client = fakeOctokit({
      request: vi.fn(async (args: { method?: string; url?: string; data?: unknown }) => {
        if (args.method === "PATCH" && (args.data as { state?: string })?.state === "closed") {
          closed.push(Number((args.url ?? "").split("/").pop()));
        }
        return { status: 200, headers: {}, data: {} };
      }),
    });
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
    __setPublishOctokitFactory(async () =>
      fakeOctokit({
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
      }),
    );
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

describe("#528 — loadExistingByHash is deterministic when rows share a dedupHash", () => {
  const HASH = computeDedupHash("acme", "metis", "Login");

  function sharedRow(
    id: string,
    draftId: string,
    issueNumber: number,
    publishedAt: string,
    batchId = "batch_old",
  ): PublishedIssueRow {
    return {
      id,
      batchId,
      draftId,
      issueNumber,
      issueId: `node_${issueNumber}`,
      htmlUrl: `https://github.com/acme/metis/issues/${issueNumber}`,
      status: "created",
      parentIssueNumber: null,
      dedupHash: HASH,
      bodyHash: `b-${issueNumber}`,
      errorMessage: null,
      publishedAt: new Date(publishedAt),
    };
  }

  /** Seed the rows in `order`, so a row-order-dependent pick shows up. */
  function seedIssues(rows: PublishedIssueRow[]): void {
    issues.clear();
    for (const r of rows) issues.set(pubIssueKey(r.batchId, r.draftId), r);
  }

  const load = (prefer?: string[]) =>
    publisherTesting.loadExistingByHash("proj_1", "acme", "metis", prefer);

  beforeEach(() => {
    seedBatch({ id: "batch_old", status: "completed" });
  });

  it("prefers the row of a draft being published, whatever the row order", async () => {
    const mine = sharedRow("pi_a", "d_mine", 11, "2026-01-01T00:00:00Z");
    const other = sharedRow("pi_b", "d_other", 12, "2026-06-01T00:00:00Z");
    for (const order of [
      [mine, other],
      [other, mine],
    ]) {
      seedIssues(order);
      // d_other's row is newer, so only the draft preference picks #11.
      expect((await load(["d_mine"])).get(HASH)?.issueNumber).toBe(11);
    }
  });

  it("with no preferred row, picks the most recent publishedAt, whatever the row order", async () => {
    const older = sharedRow("pi_z", "d_1", 21, "2026-01-01T00:00:00Z");
    const newer = sharedRow("pi_a", "d_2", 22, "2026-06-01T00:00:00Z");
    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      seedIssues(order);
      // pi_z > pi_a, so an id tiebreak alone would pick the wrong one.
      expect((await load(["d_unrelated"])).get(HASH)?.issueNumber).toBe(22);
      expect((await load()).get(HASH)?.issueNumber).toBe(22);
    }
  });

  it("among preferred rows, the most recent wins", async () => {
    const older = sharedRow("pi_z", "d_1", 31, "2026-01-01T00:00:00Z");
    const newer = sharedRow("pi_a", "d_2", 32, "2026-06-01T00:00:00Z", "batch_other");
    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      seedIssues(order);
      expect((await load(["d_1", "d_2"])).get(HASH)?.issueNumber).toBe(32);
    }
  });

  it("settles an exact publishedAt tie on the row id, whatever the row order", async () => {
    const low = sharedRow("pi_a", "d_1", 41, "2026-01-01T00:00:00Z");
    const high = sharedRow("pi_b", "d_2", 42, "2026-01-01T00:00:00Z");
    for (const order of [
      [low, high],
      [high, low],
    ]) {
      seedIssues(order);
      expect((await load()).get(HASH)?.issueNumber).toBe(42);
    }
  });

  it("a live publish updates the issue of the draft being published, not its twin's", async () => {
    seedDraft({ id: "d_mine", title: "Login", body: "new body" });
    const mine = sharedRow("pi_a", "d_mine", 11, "2026-01-01T00:00:00Z");
    // A newer duplicate for another draft — the one the old last-wins map
    // could land on, overwriting that issue's body.
    const other = sharedRow("pi_b", "d_other", 12, "2026-06-01T00:00:00Z");
    seedBatch({
      id: "batch_new",
      metadata: JSON.stringify({
        draftIds: ["d_mine"],
        additionalLabels: [],
        secretRef: "${vault:gh}",
      }),
    });
    seedIssues([mine, other]);
    const patched: number[] = [];
    const base = makeFakeOctokit();
    __setPublishOctokitFactory(async () => ({
      request: async (args) => {
        if (args.method === "PATCH" && /\/issues\/\d+$/.test(args.url ?? "")) {
          patched.push(Number((args.url ?? "").split("/").pop()));
        }
        return base.request(args);
      },
    }));
    const result = await runBatch({
      batchId: "batch_new",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(result.status).toBe("completed");
    expect(patched).toEqual([11]);
    expect(issues.get(pubIssueKey("batch_new", "d_mine"))?.issueNumber).toBe(11);
  });

  it("the dry run and the pre-publish preview name the same issue the live run updates", async () => {
    seedDraft({ id: "d_mine", title: "Login", body: "new body" });
    seedBatch({
      id: "batch_new",
      dryRun: true,
      metadata: JSON.stringify({ draftIds: ["d_mine"], additionalLabels: [], secretRef: null }),
    });
    seedIssues([
      sharedRow("pi_a", "d_mine", 11, "2026-01-01T00:00:00Z"),
      sharedRow("pi_b", "d_other", 12, "2026-06-01T00:00:00Z"),
    ]);
    const updateOf = (plan: { actions: Array<{ kind: string; existingIssueNumber?: number }> }) =>
      plan.actions.filter((a) => a.kind === "issue.update").map((a) => a.existingIssueNumber);

    await runBatch({ batchId: "batch_new", dryRun: true, secretRef: null, sleep: noopSleep });
    expect(updateOf(JSON.parse(batches.get("batch_new")!.dryRunPlan!))).toEqual([11]);

    const preview = await previewBatchPlan({
      projectId: "proj_1",
      draftIds: ["d_mine"],
      targetOwner: "acme",
      targetRepo: "metis",
      targetBaseUrl: null,
      provider: "github",
      additionalLabels: [],
      secretRef: null,
    });
    expect(updateOf(preview)).toEqual([11]);
  });
});

// ---- #1102 review, cycle 2 -------------------------------------------------

describe("previewBatchPlan — an already-published draft is not in the plan", () => {
  it("lists the approved draft only, as the live run would select it", async () => {
    seedDraft({ id: "f_done", title: "Login", status: "published" });
    seedDraft({ id: "f_new", title: "Billing", status: "approved" });
    for (const draftIds of [["f_done", "f_new"], []]) {
      const plan = await previewBatchPlan({
        projectId: "proj_1",
        targetOwner: "acme",
        targetRepo: "metis",
        targetBaseUrl: null,
        provider: "github",
        draftIds,
        additionalLabels: [],
        secretRef: null,
      });
      const issueActions = plan.actions.filter((a) => a.kind.startsWith("issue."));
      expect(issueActions.map((a) => [a.kind, a.draftId])).toEqual([["issue.create", "f_new"]]);
    }
  });
});

describe("reconcileFromRemote — the marker's hash is checked against what METIS recorded", () => {
  const H_LOGIN = computeDedupHash("acme", "metis", "Login");
  const H_BILLING = computeDedupHash("acme", "metis", "Billing");
  const marker = (draftId: string, hash: string) =>
    `<!-- metis-publish: batch=batch_1 draft=${draftId} hash=${hash} -->`;

  function row(over: Partial<PublishedIssueRow> = {}): PublishedIssueRow {
    return {
      id: "pi_42",
      batchId: "batch_1",
      draftId: "f1",
      issueNumber: 42,
      issueId: "I_kwDOfake42",
      htmlUrl: "https://github.com/acme/metis/issues/42",
      status: "created",
      parentIssueNumber: null,
      dedupHash: H_LOGIN,
      bodyHash: computeBodyHash("login body"),
      errorMessage: null,
      publishedAt: new Date(),
      ...over,
    };
  }

  /** Every issue read the fake tracker was sent (#1106 review). */
  const trackerReads: string[] = [];

  /** The fake tracker, recording every write it is sent. */
  function tracker(): string[] {
    const writes: string[] = [];
    trackerReads.length = 0;
    __setPublishOctokitFactory(async () => {
      const base = makeFakeOctokit();
      return fakeOctokit({
        request: async (args) => {
          if (
            (args.method === "POST" || args.method === "PATCH") &&
            /\/issues(\/\d+)?$/.test(args.url ?? "")
          ) {
            writes.push(`${args.method} ${args.url}`);
          }
          if ((args.method ?? "GET") === "GET" && /\/issues/.test(args.url ?? "")) {
            trackerReads.push(`GET ${args.url}`);
          }
          return base.request(args);
        },
      });
    });
    return writes;
  }

  const batch2 = (draftIds: string[], dryRun = false) =>
    seedBatch({
      id: `batch_2${dryRun ? "_dry" : ""}`,
      dryRun,
      metadata: JSON.stringify({ draftIds, additionalLabels: [], secretRef: "${vault:gh}" }),
    });

  it("an issue whose marker was edited to another draft's hash is not overwritten with that draft", async () => {
    // Issue #42 is "Login" (draft f1), and METIS's row says so. Someone with
    // write access to the tracker edits its marker to the dedup hash of the
    // unpublished draft "Billing" — the hash is sha256 of `owner/repo:title`,
    // so anyone can compute it.
    seedDraft({ id: "f1", title: "Login", body: "login body", status: "published" });
    seedDraft({ id: "f2", title: "Billing", body: "billing body", status: "approved" });
    seedBatch({ id: "batch_1", status: "completed" });
    issues.set("batch_1::f1", row());
    const edited = `login body\n\n${marker("f1", H_BILLING)}\n`;
    remoteIssues.set(42, makeRemoteIssue(42, edited));
    const writes = tracker();

    // The dry run and the live run agree: "Billing" is a new issue.
    batch2(["f2"], true);
    await runBatch({ batchId: "batch_2_dry", dryRun: true, secretRef: null, sleep: noopSleep });
    const plan = JSON.parse(batches.get("batch_2_dry")!.dryRunPlan!) as {
      actions: Array<{ kind: string; draftId?: string }>;
    };
    expect(
      plan.actions.filter((a) => a.kind.startsWith("issue.")).map((a) => [a.kind, a.draftId]),
    ).toEqual([["issue.create", "f2"]]);

    batch2(["f2"]);
    const result = await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(result.status).toBe("completed");
    // #42 is untouched, and "Billing" has an issue of its own.
    expect(writes).toEqual(["POST /repos/acme/metis/issues"]);
    expect(remoteIssues.get(42)!.body).toBe(edited);
    expect(remoteIssues.size).toBe(2);
    expect(issues.get("batch_2::f2")!.issueNumber).not.toBe(42);
    // #1106 — "Billing" has no row, so the tracker was never consulted for it:
    // the edited marker could not even be read, let alone start a match.
    expect(trackerReads).toEqual([]);

    // When "Login" itself is published again (its row's batch archived, so the
    // tracker is checked), the edited hash is one METIS cannot vouch for: no
    // match, a new issue, and the conflict reported against #42.
    batches.get("batch_1")!.archived = true;
    drafts.get("f1")!.status = "approved";
    seedBatch({
      id: "batch_3",
      metadata: JSON.stringify({
        draftIds: ["f1"],
        additionalLabels: [],
        secretRef: "${vault:gh}",
      }),
    });
    writes.length = 0;
    await runBatch({
      batchId: "batch_3",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(writes).toEqual(["POST /repos/acme/metis/issues"]);
    expect(remoteIssues.get(42)!.body).toBe(edited);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "publish.reconcile.marker_hash_mismatch",
        target: { type: "github_issue", id: "acme/metis#42" },
        metadata: expect.objectContaining({ draftId: "f1", markerDraftIds: ["f1"] }),
      }),
    );
  });

  it("still recovers an issue whose marker carries the hash METIS recorded for it", async () => {
    // The row is real but out of the local dedup map (its batch was archived):
    // the sweep is what finds the issue, and the hash matches the record.
    seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
    seedBatch({ id: "batch_1", status: "completed", archived: true });
    issues.set("batch_1::f1", row());
    remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
    const writes = tracker();
    batch2(["f1"]);
    await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(writes).toEqual([]);
    expect(remoteIssues.size).toBe(1);
    expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "publish.reconcile.marker_hash_mismatch" }),
    );
  });

  it("a row that recorded no hash is held to the hash of the draft the marker names", async () => {
    seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
    seedDraft({ id: "f2", title: "Billing", body: "billing body", status: "approved" });
    seedBatch({ id: "batch_1", status: "completed" });
    issues.set("batch_1::f1", row({ dedupHash: null }));
    const edited = `login body\n\n${marker("f1", H_BILLING)}\n`;
    remoteIssues.set(42, makeRemoteIssue(42, edited));
    const writes = tracker();
    batch2(["f1", "f2"]);
    await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    // Nothing is PATCHed onto #42; both drafts are filed as new issues.
    expect(writes).toEqual(["POST /repos/acme/metis/issues", "POST /repos/acme/metis/issues"]);
    expect(remoteIssues.get(42)!.body).toBe(edited);

    // …and when the marker names a draft that is not in the batch at all, the
    // hash cannot be checked, so it is not trusted.
    remoteIssues.clear();
    issues.clear();
    issues.set("batch_1::f1", row({ dedupHash: null }));
    remoteIssues.set(42, makeRemoteIssue(42, edited));
    drafts.get("f2")!.status = "approved";
    writes.length = 0;
    seedBatch({
      id: "batch_3",
      metadata: JSON.stringify({
        draftIds: ["f2"],
        additionalLabels: [],
        secretRef: "${vault:gh}",
      }),
    });
    await runBatch({
      batchId: "batch_3",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(writes).toEqual(["POST /repos/acme/metis/issues"]);
    expect(remoteIssues.get(42)!.body).toBe(edited);
  });

  describe("a draft retitled after a failed run keeps its one issue (#1102 review, cycle 3)", () => {
    const H_OLD = computeDedupHash("acme", "metis", "Old title");
    const H_NEW = computeDedupHash("acme", "metis", "New title");
    const mismatch = expect.objectContaining({ action: "publish.reconcile.marker_hash_mismatch" });
    const run2 = () =>
      runBatch({ batchId: "batch_2", dryRun: false, secretRef: "${vault:gh}", sleep: noopSleep });

    /** Issue #50 exists, stamped with the hash of the title the draft has now. */
    function seedRetitled(recorded: string | null): string[] {
      seedDraft({ id: "f1", title: "New title", body: "the body", status: "failed" });
      seedBatch({ id: "batch_1", status: "failed" });
      issues.set(
        "batch_1::f1",
        row({
          status: "failed",
          issueNumber: 50,
          issueId: "I_kwDOfake50",
          htmlUrl: "https://github.com/acme/metis/issues/50",
          dedupHash: recorded,
          bodyHash: computeBodyHash("the body"),
          errorMessage: "sub-issue attach failed",
        }),
      );
      remoteIssues.set(50, makeRemoteIssue(50, `the body\n\n${marker("f1", H_NEW)}\n`));
      return tracker();
    }

    it("the row as it was written before: failed, #50, the OLD title's hash — zero creates", async () => {
      // The failed branch used to record the issue it had just created without
      // the hash it had stamped on it. The sweep then read its own marker as a
      // forged one and filed the draft a second time.
      const writes = seedRetitled(H_OLD);
      batch2(["f1"]);
      expect((await run2()).status).toBe("completed");
      expect(writes).toEqual([]);
      expect(remoteIssues.size).toBe(1);
      expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
      expect(audit).not.toHaveBeenCalledWith(mismatch);
      // The new row names the issue under the hash its marker carries.
      expect(issues.get("batch_2::f1")).toMatchObject({ issueNumber: 50, dedupHash: H_NEW });
    });

    it("the same row with no recorded hash at all is recovered the same way", async () => {
      const writes = seedRetitled(null);
      batch2(["f1"]);
      await run2();
      expect(writes).toEqual([]);
      expect(remoteIssues.size).toBe(1);
      expect(audit).not.toHaveBeenCalledWith(mismatch);
    });

    it.each([
      ["the old title's hash", H_OLD],
      ["no hash", null],
    ])(
      "…but only for the issue's own draft: a same-titled sibling does not inherit it (row holds %s)",
      async (_label, recorded) => {
        // #1106 — f9 has no PublishedIssue row of its own, so nothing names an
        // issue for it: the tracker (and #50's marker naming f1) is never read,
        // and the sibling is filed as a new issue.
        const writes = seedRetitled(recorded);
        seedDraft({ id: "f9", title: "New title", body: "the body", status: "approved" });
        batch2(["f9"]);
        await run2();
        expect(writes).toEqual(["POST /repos/acme/metis/issues"]);
        expect(remoteIssues.size).toBe(2);
        expect(audit).not.toHaveBeenCalledWith(mismatch);
      },
    );

    it("the failed branch now records the hash with the issue it records", async () => {
      // Run 1 failed before creating anything, under the old title.
      seedDraft({ id: "f1", title: "New title", body: "the body", status: "failed" });
      seedBatch({ id: "batch_1" });
      issues.set(
        "batch_1::f1",
        row({
          status: "failed",
          issueNumber: 0,
          issueId: "",
          htmlUrl: "",
          dedupHash: H_OLD,
          bodyHash: "stale",
        }),
      );
      const writes = tracker();
      // Run 2 creates the issue, then persisting the success fails.
      const upsert = prisma.publishedIssue.upsert as unknown as Mock<
        (args: { create?: { status?: string } }) => Promise<unknown>
      >;
      const real = upsert.getMockImplementation()!;
      upsert.mockImplementation(async (args: { create?: { status?: string } }) => {
        if (args.create?.status !== "failed") throw new Error("database is down");
        return real(args);
      });
      try {
        await runBatch({
          batchId: "batch_1",
          dryRun: false,
          secretRef: "${vault:gh}",
          sleep: noopSleep,
        });
      } finally {
        upsert.mockImplementation(real);
      }
      const creates = () => writes.filter((w) => w === "POST /repos/acme/metis/issues");
      expect(creates()).toHaveLength(1);
      const created = [...remoteIssues.values()][0]!;
      expect(created.body).toContain(marker("f1", H_NEW));
      const recorded = issues.get("batch_1::f1")!;
      expect(recorded).toMatchObject({
        status: "failed",
        issueNumber: created.number,
        issueId: created.node_id,
        // The hash stamped on the issue, and the hash of the body it carries.
        dedupHash: H_NEW,
        bodyHash: computeBodyHash("the body"),
      });

      // Run 3: the issue is found again; no second one is created.
      drafts.get("f1")!.status = "failed";
      batch2(["f1"]);
      await run2();
      expect(creates()).toHaveLength(1);
      expect(remoteIssues.size).toBe(1);
      expect(audit).not.toHaveBeenCalledWith(mismatch);
    });

    it("a failure before any write leaves the recorded issue and its hash together", async () => {
      // #50 was stamped under the old title; the draft is retitled and the
      // next run cannot reach GitHub. The row must go on describing #50.
      seedDraft({ id: "f1", title: "New title", body: "the body", status: "failed" });
      seedBatch({ id: "batch_1" });
      issues.set(
        "batch_1::f1",
        row({ status: "failed", issueNumber: 50, dedupHash: H_OLD, bodyHash: "old-body-hash" }),
      );
      __setPublishOctokitFactory(async () => makeFakeOctokit({ alwaysFailCreate: true }));
      await runBatch({
        batchId: "batch_1",
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: noopSleep,
      });
      expect(issues.get("batch_1::f1")).toMatchObject({
        status: "failed",
        issueNumber: 50,
        dedupHash: H_OLD,
        bodyHash: "old-body-hash",
      });
    });

    it("a dedup-skip records the hash it matched on, over a row an earlier failed run left", async () => {
      seedDraft({ id: "f1", title: "New title", body: "the body", status: "failed" });
      seedBatch({ id: "batch_0", status: "completed" });
      issues.set(
        "batch_0::f1",
        row({
          id: "pi_0",
          batchId: "batch_0",
          issueNumber: 50,
          dedupHash: H_NEW,
          bodyHash: computeBodyHash("the body"),
        }),
      );
      batch2(["f1"]);
      issues.set(
        "batch_2::f1",
        row({
          id: "pi_2",
          batchId: "batch_2",
          status: "failed",
          issueNumber: 0,
          dedupHash: H_OLD,
          bodyHash: "stale",
        }),
      );
      const writes = tracker();
      await run2();
      expect(writes).toEqual([]);
      expect(issues.get("batch_2::f1")).toMatchObject({
        status: "updated",
        issueNumber: 50,
        dedupHash: H_NEW,
        bodyHash: computeBodyHash("the body"),
      });
    });
  });

  it("matches a GitHub issue against the draft's GitHub row, not its Jira row", async () => {
    // Destination `both`: the draft has a Jira row (issue number 0) beside its
    // GitHub one. Read first, the Jira row made the sweep refuse the issue.
    seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
    seedBatch({ id: "batch_1", status: "completed", archived: true });
    issues.set(
      "batch_1::f1::jira",
      row({
        id: "pi_jira",
        issueNumber: 0,
        issueId: "10001",
        dedupHash: null,
        destination: "jira",
      }),
    );
    issues.set("batch_1::f1", row());
    remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
    const writes = tracker();
    batch2(["f1"]);
    await runBatch({
      batchId: "batch_2",
      dryRun: false,
      secretRef: "${vault:gh}",
      sleep: noopSleep,
    });
    expect(writes).toEqual([]);
    expect(remoteIssues.size).toBe(1);
    // #1106 — the row is looked up among the draft's GitHub rows only.
    expect(vi.mocked(prisma.publishedIssue.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ draftId: { in: ["f1"] }, destination: "github" }),
      }),
    );
  });
});

describe("#1106 — the sweep matches from METIS's own rows; the tracker's marker only confirms", () => {
  const H_LOGIN = computeDedupHash("acme", "metis", "Login");
  const H_BILLING = computeDedupHash("acme", "metis", "Billing");
  const marker = (draftId: string, hash: string, batchId = "batch_1") =>
    `<!-- metis-publish: batch=${batchId} draft=${draftId} hash=${hash} -->`;

  function row(over: Partial<PublishedIssueRow> = {}): PublishedIssueRow {
    return {
      id: "pi_42",
      batchId: "batch_1",
      draftId: "f1",
      issueNumber: 42,
      issueId: "I_kwDOfake42",
      htmlUrl: "https://github.com/acme/metis/issues/42",
      status: "created",
      parentIssueNumber: null,
      dedupHash: H_LOGIN,
      bodyHash: computeBodyHash("login body"),
      errorMessage: null,
      publishedAt: new Date("2026-10-01T00:00:00Z"),
      ...over,
    };
  }

  /** The fake tracker, recording every issue call it is sent. */
  function tracker(
    override?: (args: OctokitRequestArgs) => Promise<OctokitResponseLike> | null,
  ): string[] {
    const calls: string[] = [];
    __setPublishOctokitFactory(async () => {
      const base = makeFakeOctokit();
      return fakeOctokit({
        request: async (args) => {
          if (/\/issues/.test(args.url ?? "")) calls.push(`${args.method ?? "GET"} ${args.url}`);
          return (override && override(args)) ?? base.request(args);
        },
      });
    });
    return calls;
  }
  const writes = (calls: string[]) => calls.filter((c) => !c.startsWith("GET "));
  const reads = (calls: string[]) => calls.filter((c) => c.startsWith("GET "));

  const batch2 = (draftIds: string[], dryRun = false) =>
    seedBatch({
      id: `batch_2${dryRun ? "_dry" : ""}`,
      dryRun,
      metadata: JSON.stringify({ draftIds, additionalLabels: [], secretRef: "${vault:gh}" }),
    });
  const run2 = () =>
    runBatch({ batchId: "batch_2", dryRun: false, secretRef: "${vault:gh}", sleep: noopSleep });
  const dry2 = async () => {
    await runBatch({ batchId: "batch_2_dry", dryRun: true, secretRef: null, sleep: noopSleep });
    const plan = JSON.parse(batches.get("batch_2_dry")!.dryRunPlan!) as {
      actions: Array<{
        kind: string;
        draftId?: string;
        existingIssueNumber?: number;
        mayMatchIssueNumber?: number;
        reason?: string;
      }>;
    };
    return plan.actions.filter((a) => a.kind.startsWith("issue."));
  };

  /** Draft f1 ("Login") was published as #42 by a batch since archived. */
  function seedArchivedLogin(body = `login body\n\n${marker("f1", H_LOGIN)}\n`): void {
    seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
    seedBatch({ id: "batch_1", status: "completed", archived: true });
    issues.set("batch_1::f1", row());
    remoteIssues.set(42, makeRemoteIssue(42, body));
  }

  describe("item 3 — the key is the PublishedIssue row, never the tracker text", () => {
    it("a draft METIS has no row for never reads the tracker, whatever markers it holds", async () => {
      // #42 carries a well-formed marker naming f2 with f2's own hash: text
      // anyone with write access to the tracker can type.
      seedDraft({ id: "f2", title: "Billing", body: "billing body", status: "approved" });
      seedBatch({ id: "batch_1", status: "completed" });
      remoteIssues.set(42, makeRemoteIssue(42, `x\n\n${marker("f2", H_BILLING)}\n`));
      const calls = tracker();
      batch2(["f2"]);
      expect((await run2()).status).toBe("completed");
      expect(reads(calls)).toEqual([]);
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
    });

    it("the row's issue is read by number, so an issue that lost its label is still found", async () => {
      // Someone removed `metis-generated` from #42 on the tracker, so a label
      // listing no longer shows it. The row still names it.
      seedArchivedLogin();
      const calls = tracker((args) =>
        /\/issues\?/.test(args.url ?? "")
          ? Promise.resolve({ status: 200, headers: {}, data: [] })
          : null,
      );
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual([]);
      expect(remoteIssues.size).toBe(1);
      expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
      expect(issues.get("batch_2::f1")).toMatchObject({ issueNumber: 42, status: "updated" });
    });

    it("an issue whose marker names another draft is not matched (the marker vetoes, never starts)", async () => {
      seedArchivedLogin(`login body\n\n${marker("f7", H_LOGIN)}\n`);
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "publish.reconcile.marker_mismatch",
          target: { type: "github_issue", id: "acme/metis#42" },
        }),
      );
    });
  });

  describe("item 1 — the dry run says which drafts the publish checks against the tracker", () => {
    it("a recoverable draft is planned as a create that may match #42, checked at publish", async () => {
      seedArchivedLogin();
      seedDraft({ id: "f2", title: "Billing", body: "billing body", status: "approved" });
      batch2(["f1", "f2"], true);
      const actions = await dry2();
      const f1 = actions.find((a) => a.draftId === "f1")!;
      expect(f1).toMatchObject({ kind: "issue.create", mayMatchIssueNumber: 42 });
      expect(f1.reason).toMatch(/may match existing issue #42.*checked at publish/);
      // A draft with no row is a plain create: nothing is left to the publish.
      const f2 = actions.find((a) => a.draftId === "f2")!;
      expect(f2.kind).toBe("issue.create");
      expect(f2.mayMatchIssueNumber).toBeUndefined();
    });

    it("the preview confirmation says the same", async () => {
      seedArchivedLogin();
      const plan = await previewBatchPlan({
        projectId: "proj_1",
        draftIds: ["f1"],
        targetOwner: "acme",
        targetRepo: "metis",
        targetBaseUrl: null,
        provider: "github",
        additionalLabels: [],
        secretRef: null,
      });
      expect(plan.actions.find((a) => a.draftId === "f1")).toMatchObject({
        kind: "issue.create",
        mayMatchIssueNumber: 42,
      });
    });

    it("…and the live run checks exactly the drafts the plan marked", async () => {
      seedArchivedLogin();
      seedDraft({ id: "f2", title: "Billing", body: "billing body", status: "approved" });
      batch2(["f1", "f2"], true);
      const marked = (await dry2()).filter((a) => a.mayMatchIssueNumber !== undefined);
      const calls = tracker();
      batch2(["f1", "f2"]);
      await run2();
      expect(marked.map((a) => [a.draftId, a.mayMatchIssueNumber])).toEqual([["f1", 42]]);
      expect(reads(calls)).toEqual(["GET /repos/acme/metis/issues/42"]);
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
    });
  });

  describe("item 2 — several standalone markers: the one the database confirms", () => {
    it("a marker line appended below the genuine block does not hide it", async () => {
      // f2 is published too, as #43: its marker is a real one, pasted under #42's.
      seedArchivedLogin(`login body\n\n${marker("f1", H_LOGIN)}\n\n${marker("f2", H_BILLING)}\n`);
      seedDraft({ id: "f2", title: "Billing", body: "billing body", status: "published" });
      issues.set(
        "batch_1::f2",
        row({ id: "pi_43", draftId: "f2", issueNumber: 43, dedupHash: H_BILLING }),
      );
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual([]);
      expect(remoteIssues.size).toBe(1);
      expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
    });

    it("a marker inside a line of text (not alone on its line) is never read", async () => {
      seedArchivedLogin(`login body \`${marker("f1", H_LOGIN)}\`\n`);
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
    });
  });

  describe("item 4 — the row is the one for this target, newest first, fully ordered", () => {
    it("a row for another repository is not used, even with the same issue number", async () => {
      // f1 was published as acme/other#42. acme/metis#42 is someone else's
      // issue, and a copied marker in it now names f1.
      seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
      seedBatch({ id: "batch_1", status: "completed", archived: true, targetRepo: "other" });
      issues.set("batch_1::f1", row());
      remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(reads(calls)).toEqual([]);
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
    });

    it("the same repository named in another case is this target", async () => {
      seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
      seedBatch({ id: "batch_1", status: "completed", archived: true, targetOwner: "ACME" });
      issues.set("batch_1::f1", row());
      remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual([]);
    });

    it("a row on another API host is not this target", async () => {
      seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
      seedBatch({
        id: "batch_1",
        status: "completed",
        archived: true,
        targetBaseUrl: "https://ghe.example.com/api/v3",
      });
      issues.set("batch_1::f1", row());
      remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(reads(calls)).toEqual([]);
    });

    it.each([
      ["older row first", false],
      ["newer row first", true],
    ])(
      "the newest row decides, whatever order the database returns (%s)",
      async (_l, newerFirst) => {
        seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
        seedBatch({ id: "batch_0", status: "completed", archived: true });
        seedBatch({ id: "batch_1", status: "completed", archived: true });
        const older = row({ id: "pi_a", batchId: "batch_0", issueNumber: 42 });
        const newer = row({
          id: "pi_b",
          batchId: "batch_1",
          issueNumber: 43,
          issueId: "I_kwDOfake43",
          publishedAt: new Date("2026-10-05T00:00:00Z"),
        });
        for (const r of newerFirst ? [newer, older] : [older, newer]) {
          issues.set(`${r.batchId}::f1`, r);
        }
        remoteIssues.set(
          42,
          makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN, "batch_0")}\n`),
        );
        remoteIssues.set(43, makeRemoteIssue(43, `login body\n\n${marker("f1", H_LOGIN)}\n`));
        const calls = tracker();
        batch2(["f1"]);
        await run2();
        expect(reads(calls)).toEqual(["GET /repos/acme/metis/issues/43"]);
        expect(writes(calls)).toEqual([]);
        expect(issues.get("batch_2::f1")!.issueNumber).toBe(43);
      },
    );

    it("an exact timestamp tie is settled on the row id", async () => {
      seedDraft({ id: "f1", title: "Login", body: "login body", status: "approved" });
      seedBatch({ id: "batch_0", status: "completed", archived: true });
      seedBatch({ id: "batch_1", status: "completed", archived: true });
      issues.set("batch_1::f1", row({ id: "pi_b", batchId: "batch_1", issueNumber: 43 }));
      issues.set("batch_0::f1", row({ id: "pi_a", batchId: "batch_0", issueNumber: 42 }));
      remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
      remoteIssues.set(43, makeRemoteIssue(43, `login body\n\n${marker("f1", H_LOGIN)}\n`));
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(reads(calls)).toEqual(["GET /repos/acme/metis/issues/43"]);
    });

    it("a newer failed row that recorded no issue does not shadow the one that did", async () => {
      seedDraft({ id: "f1", title: "Login", body: "login body", status: "failed" });
      seedBatch({ id: "batch_0", status: "completed", archived: true });
      seedBatch({ id: "batch_1", status: "failed" });
      issues.set("batch_0::f1", row({ id: "pi_a", batchId: "batch_0" }));
      issues.set(
        "batch_1::f1",
        row({
          id: "pi_b",
          batchId: "batch_1",
          status: "failed",
          issueNumber: 0,
          issueId: "",
          htmlUrl: "",
          dedupHash: null,
          publishedAt: new Date("2026-10-05T00:00:00Z"),
        }),
      );
      remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual([]);
      expect(issues.get("batch_2::f1")!.issueNumber).toBe(42);
    });
  });

  describe("two drafts are never filed onto one issue", () => {
    it("an issue the title match already claims is not offered to a draft through its row", async () => {
      // g1 "Login" is live as #42 (in the dedup map by title). f1, since
      // retitled, has an archived row that also names #42.
      seedDraft({ id: "g1", title: "Login", body: "login body", status: "approved" });
      seedDraft({ id: "f1", title: "Login v2", body: "v2 body", status: "approved" });
      seedBatch({ id: "batch_0", status: "completed" });
      seedBatch({ id: "batch_1", status: "completed", archived: true });
      issues.set("batch_0::g1", row({ id: "pi_g", batchId: "batch_0", draftId: "g1" }));
      issues.set("batch_1::f1", row({ id: "pi_f", batchId: "batch_1", draftId: "f1" }));
      remoteIssues.set(42, makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`));
      batch2(["g1", "f1"], true);
      expect((await dry2()).filter((a) => a.mayMatchIssueNumber !== undefined)).toEqual([]);
      const calls = tracker();
      batch2(["g1", "f1"]);
      await run2();
      expect(reads(calls)).toEqual([]);
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
      expect(issues.get("batch_2::g1")!.issueNumber).toBe(42);
      expect(issues.get("batch_2::f1")!.issueNumber).not.toBe(42);
    });

    it("an issue GitHub answers for under another number (moved) is not matched", async () => {
      seedArchivedLogin();
      const calls = tracker((args) =>
        /\/issues\/42$/.test(args.url ?? "") && (args.method ?? "GET") === "GET"
          ? Promise.resolve({
              status: 200,
              headers: {},
              data: makeRemoteIssue(77, `login body\n\n${marker("f1", H_LOGIN)}\n`),
            })
          : null,
      );
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
    });
  });

  describe("a transferred issue answered through a redirect (#1106 review)", () => {
    it.each([
      ["repository_url", { repository_url: "https://api.github.com/repos/acme/elsewhere" }],
      ["html_url", { html_url: "https://github.com/acme/elsewhere/issues/42" }],
      ["both missing", { repository_url: undefined, html_url: "not a url" }],
    ])("same number, but %s names another repository: not matched", async (_label, over) => {
      seedArchivedLogin();
      const calls = tracker((args) =>
        /\/issues\/42$/.test(args.url ?? "") && (args.method ?? "GET") === "GET"
          ? Promise.resolve({
              status: 200,
              headers: {},
              data: {
                ...makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`),
                ...over,
              },
            })
          : null,
      );
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
    });

    it("the same repository in another letter case is still this one", async () => {
      seedArchivedLogin();
      const calls = tracker((args) =>
        /\/issues\/42$/.test(args.url ?? "") && (args.method ?? "GET") === "GET"
          ? Promise.resolve({
              status: 200,
              headers: {},
              data: {
                ...makeRemoteIssue(42, `login body\n\n${marker("f1", H_LOGIN)}\n`),
                repository_url: "https://api.github.com/repos/Acme/Metis",
                html_url: "https://github.com/Acme/Metis/issues/42",
              },
            })
          : null,
      );
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual([]);
    });
  });

  describe("progress and timing for the reads (#1106 review)", () => {
    it("each read emits a dedup-scan progress event", async () => {
      const progress: Array<Record<string, unknown>> = [];
      configurePublisher({
        emitter: {
          status: () => undefined,
          progress: (e) => progress.push(e as unknown as Record<string, unknown>),
          completed: () => undefined,
        },
      });
      try {
        seedArchivedLogin();
        tracker();
        batch2(["f1"]);
        await run2();
      } finally {
        configurePublisher({ emitter: undefined });
      }
      expect(progress).toContainEqual(
        expect.objectContaining({
          phase: "dedup-scan",
          step: "reading-issue",
          current: 1,
          total: 1,
          draftId: "f1",
          issueNumber: 42,
        }),
      );
    });

    it("the dry-run estimate counts one call per issue read at publish", async () => {
      seedArchivedLogin();
      batch2(["f1"], true);
      await runBatch({
        batchId: "batch_2_dry",
        dryRun: true,
        secretRef: null,
        sleep: noopSleep,
        rateLimit: {
          delayMs: 1000,
          jitterMs: 0,
          secondaryBackoffBaseMs: 0,
          secondaryBackoffMaxMs: 0,
          maxRetries: 0,
          backoffBudgetMs: 0,
        },
      });
      const plan = JSON.parse(batches.get("batch_2_dry")!.dryRunPlan!) as {
        totalActions: number;
        estimatedDurationMs: number;
      };
      expect(plan.estimatedDurationMs).toBe((plan.totalActions + 1) * 1000);
    });
  });

  describe("item 5 — no page limit", () => {
    it("recovers a draft whose issue sits past the first 100 metis-generated issues", async () => {
      for (let n = 1; n <= 150; n += 1) {
        remoteIssues.set(1000 + n, makeRemoteIssue(1000 + n, `other ${n}`));
      }
      seedArchivedLogin();
      const calls = tracker();
      batch2(["f1"]);
      await run2();
      expect(writes(calls)).toEqual([]);
      expect(batches.get("batch_2")!.dedupSkipped).toBe(1);
    });
  });

  describe("item 6 — a failed read is logged and reported on the batch", () => {
    /** Every request the fake tracker is sent, labels included; issue reads fail with 502. */
    function failingReads(): string[] {
      const all: string[] = [];
      __setPublishOctokitFactory(async () => {
        const base = makeFakeOctokit();
        return fakeOctokit({
          request: async (args) => {
            const method = args.method ?? "GET";
            all.push(`${method} ${args.url}`);
            if (method === "GET" && /\/issues\/\d+$/.test(args.url ?? "")) {
              throw Object.assign(new Error("Bad Gateway"), { status: 502 });
            }
            return base.request(args);
          },
        });
      });
      return all;
    }

    it("a failed read stops the batch before ANY write: nothing created, nothing rolled back", async () => {
      // Two drafts whose issues cannot be read, one new draft. Counting the
      // two as failed drafts would cross the >50% auto-rollback threshold and
      // close the new draft's issue, which has nothing to do with them.
      seedArchivedLogin();
      seedDraft({ id: "f4", title: "Export", body: "export body", status: "approved" });
      issues.set(
        "batch_1::f4",
        row({
          id: "pi_44",
          draftId: "f4",
          issueNumber: 44,
          dedupHash: computeDedupHash("acme", "metis", "Export"),
        }),
      );
      seedDraft({ id: "f2", title: "Billing", body: "billing body", status: "approved" });
      const all = failingReads();
      batch2(["f1", "f4", "f2"]);
      const rowsBefore = issues.size;
      expect((await run2()).status).toBe("failed");
      // Only the auth check and the two reads: no label sync, no POST, no close.
      expect(all.filter((c) => !c.startsWith("GET "))).toEqual([]);
      expect(all.filter((c) => /\/issues\/\d+$/.test(c))).toEqual([
        "GET /repos/acme/metis/issues/42",
        "GET /repos/acme/metis/issues/44",
      ]);
      expect(issues.size).toBe(rowsBefore);
      expect(remoteIssues.size).toBe(1);
      for (const id of ["f1", "f4", "f2"]) expect(drafts.get(id)!.status).toBe("approved");
      const b = batches.get("batch_2")!;
      expect(b).toMatchObject({ status: "failed", publishedCount: 0, failedCount: 0 });
      expect(b.errorMessage).toMatch(/could not read issue #42, #44 .*retry the batch/);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "publish.reconcile.read_failed",
          target: { type: "github_issue", id: "acme/metis#42" },
          metadata: expect.objectContaining({ status: 502 }),
        }),
      );
      expect(audit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "publish.issue.closed" }),
      );
    });

    it("re-running the same batch after a failed read records the whole row (ids, link, no stale error)", async () => {
      seedArchivedLogin();
      batch2(["f1"]);
      // A row an earlier failed run of this batch left: no issue, an error.
      issues.set(
        "batch_2::f1",
        row({
          id: "pi_2",
          batchId: "batch_2",
          status: "failed",
          issueNumber: 0,
          issueId: "",
          htmlUrl: "",
          dedupHash: null,
          bodyHash: null,
          errorMessage: "simulated earlier failure",
          publishedAt: new Date("2026-10-10T00:00:00Z"),
        }),
      );
      failingReads();
      expect((await run2()).status).toBe("failed");
      expect(issues.get("batch_2::f1")!.errorMessage).toBe("simulated earlier failure");

      // GitHub is back: the same batch is run again.
      __resetPublishOctokitCache();
      const calls = tracker();
      expect((await run2()).status).toBe("completed");
      expect(writes(calls)).toEqual([]);
      expect(issues.get("batch_2::f1")).toMatchObject({
        issueNumber: 42,
        issueId: "I_kwDOfake42",
        htmlUrl: "https://github.com/acme/metis/issues/42",
        status: "updated",
        dedupHash: H_LOGIN,
        bodyHash: computeBodyHash("login body"),
        errorMessage: null,
      });
      // Drift detection's lookup (`reconcileIssueChange`): the newest row
      // whose issueId is the webhook's node id. It must be this batch's row.
      const byNodeId = [...issues.values()]
        .filter((r) => r.issueId === "I_kwDOfake42")
        .sort(
          (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || (b.id > a.id ? 1 : -1),
        );
      expect(byNodeId[0]).toMatchObject({ batchId: "batch_2", errorMessage: null });
    });

    it("an issue deleted on the tracker (404) is not a failure: the draft is created", async () => {
      seedArchivedLogin();
      remoteIssues.delete(42);
      const calls = tracker();
      batch2(["f1"]);
      expect((await run2()).status).toBe("completed");
      expect(writes(calls)).toEqual(["POST /repos/acme/metis/issues"]);
      expect(batches.get("batch_2")!.errorMessage).toBeNull();
    });
  });
});
