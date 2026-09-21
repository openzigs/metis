/**
 * POST /api/projects/:projectId/publishing/batches — request lifecycle
 * regressions (#1092, #1093, #1094).
 *
 * All three defects came out of one live walkthrough and share a root shape:
 * the endpoint wrote the `PublishBatch` row FIRST and validated the credential
 * afterwards.
 *
 *   #1092 — a rejected request left a `pending` batch row behind forever.
 *   #1093 — a dry run reported `completed` for the very ref the live run 400s.
 *   #1094 — the 400's actionable message was redacted to "The request could
 *           not be processed.", so a user could not tell WHICH field was wrong
 *           or what shape it needed.
 *
 * The redaction rule from #1082/#1084/#1065 is deliberately preserved here:
 * the `ConnectorError` message (which embeds a preview of the submitted value,
 * and for other codes can embed resolved private addresses) is still never
 * forwarded. Instead the server supplies its OWN vetted string. The tests
 * below assert both halves — the format IS explained, and the submitted value
 * is NOT echoed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const PROJECT = "proj_mine_00001";

const drafts = new Map<string, DraftRow>();
const batches = new Map<string, BatchRow>();
let batchSeq = 0;

interface Where {
  id?: string;
  projectId?: string;
  deletedAt?: Date | null;
  [k: string]: unknown;
}

function matches(row: { id: string; projectId: string; deletedAt?: Date | null }, where: Where) {
  if (where.id !== undefined && typeof where.id === "string" && row.id !== where.id) return false;
  if (
    where.id !== undefined &&
    typeof where.id === "object" &&
    !((where.id as { in?: string[] }).in ?? []).includes(row.id)
  ) {
    return false;
  }
  if (where.projectId !== undefined && row.projectId !== where.projectId) return false;
  if (where.deletedAt === null && row.deletedAt) return false;
  return true;
}

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => [{ workspaceId: "ws_caller" }]) },
    user: {
      upsert: vi.fn(async ({ create }: { create: { username: string } }) => ({
        id: `user_${create.username}`,
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async () => ({
        workspaceId: "ws_caller",
        publishDestination: "github",
        jiraConnectionId: null,
        jiraProjectKey: null,
        requireApprovedReview: false,
      })),
    },
    requirement: { findMany: vi.fn(async () => []) },
    reviewRequestItem: { findMany: vi.fn(async () => []) },
    issueDraft: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        [...drafts.values()].filter((d) => matches(d, where)),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          [...drafts.values()].find((d) => matches(d, where)) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: Where }) =>
          [...drafts.values()].find((d) => matches(d, where)) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<DraftRow> }) => {
        const row = drafts.get(where.id)!;
        const next = { ...row, ...data };
        drafts.set(where.id, next);
        return next;
      }),
    },
    publishBatch: {
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        [...batches.values()].filter((b) => matches(b, where)),
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const row = [...batches.values()].find((b) => matches(b, where));
        return row ? { ...row, publishedIssues: [] } : null;
      }),
      findUnique: vi.fn(async ({ where }: { where: Where }) => {
        const row = [...batches.values()].find((b) => matches(b, where));
        return row ? { ...row, publishedIssues: [] } : null;
      }),
      create: vi.fn(async ({ data }: { data: Partial<BatchRow> }) => {
        batchSeq += 1;
        const row: BatchRow = {
          id: `batch_${batchSeq}`,
          projectId: PROJECT,
          status: "pending",
          targetOwner: "acme",
          targetRepo: "metis",
          targetBaseUrl: null,
          provider: "github",
          dryRun: false,
          totalDrafts: 0,
          publishedCount: 0,
          failedCount: 0,
          dedupSkipped: 0,
          archived: false,
          archivedAt: null,
          archiveReason: null,
          archivedById: null,
          dryRunPlan: null,
          startedById: "user_coordinator",
          startedAt: new Date(),
          completedAt: null,
          errorMessage: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        batches.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<BatchRow> }) => {
        const row = batches.get(where.id)!;
        const next = { ...row, ...data };
        batches.set(where.id, next);
        return next;
      }),
    },
    repoConnection: { findFirst: vi.fn(async () => null) },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const runBatchImpl = vi.fn(async () => ({ status: "completed" }));
vi.mock("../src/lib/publishing/publisher.js", () => ({
  runBatch: (...args: unknown[]) => runBatchImpl(...(args as [])),
  archiveBatch: vi.fn(async () => undefined),
  configurePublisher: vi.fn(),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { assertValidSecretRef } from "../src/lib/publishing/publishing-service.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function postBatch(token: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/projects/${PROJECT}/publishing/batches`)
    .set("Authorization", `Bearer ${token}`)
    .send({ targetOwner: "acme", targetRepo: "metis", draftIds: ["draft_000000001"], ...body });
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  drafts.clear();
  batches.clear();
  batchSeq = 0;
  runBatchImpl.mockImplementation(async () => ({ status: "completed" }));
  drafts.set("draft_000000001", {
    id: "draft_000000001",
    projectId: PROJECT,
    requirementId: null,
    parentDraftId: null,
    draftType: "feature",
    title: "Login",
    body: "body",
    labels: "[]",
    assignees: "[]",
    storyPoints: 1,
    status: "approved",
    dedupHash: null,
    metadata: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("#1092 — a rejected request leaves no orphaned batch row", () => {
  it("rejects a malformed vault ref WITHOUT creating a PublishBatch", async () => {
    const token = await login("coordinator");
    // Exactly the value the Publish page's own placeholder taught (#1094).
    const res = await postBatch(token, { dryRun: false, secretRef: "vault:github-mgcronin" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VAULT_REF_INVALID");
    // The defect: a `pending` row was written at the same instant as the 400,
    // and nothing ever reaped it.
    expect(prisma.publishBatch.create).not.toHaveBeenCalled();
    expect(batches.size).toBe(0);
  });

  it("rejects a live publish with no credential at all without creating a row", async () => {
    // `runBatch` used to throw TOKEN_REQUIRED *after* the row existed,
    // orphaning it the same way.
    const token = await login("coordinator");
    const res = await postBatch(token, { dryRun: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOKEN_REQUIRED");
    expect(batches.size).toBe(0);
  });

  it("marks the batch failed — never leaves it pending — when execution throws", async () => {
    const token = await login("coordinator");
    runBatchImpl.mockImplementation(async () => {
      const err = new Error("host not allow-listed") as Error & { status: number; code: string };
      err.status = 403;
      err.code = "HOST_NOT_ALLOWED";
      throw err;
    });
    const res = await postBatch(token, {
      dryRun: false,
      secretRef: "${vault:gh-publish-token}",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const row = [...batches.values()][0];
    expect(row).toBeDefined();
    // A `pending` row is indistinguishable from one genuinely in flight.
    expect(row.status).toBe("failed");
    expect(row.completedAt).not.toBeNull();
    expect(row.errorMessage).toContain("HOST_NOT_ALLOWED");
  });

  it("accepts a well-formed ref and does create the batch", async () => {
    // Negative control: the guard must not reject valid input, or every
    // assertion above would pass for the wrong reason.
    const token = await login("coordinator");
    const res = await postBatch(token, { dryRun: false, secretRef: "${vault:gh-publish-token}" });
    expect(res.status).toBe(201);
    expect(batches.size).toBe(1);
  });

  it("does not touch an ARCHIVED batch when execution throws", async () => {
    // Archiving is a deliberate operator action; a failed run must not
    // silently rewrite its terminal state.
    const token = await login("coordinator");
    const create = prisma.publishBatch.create as ReturnType<typeof vi.fn>;
    const realCreate = create.getMockImplementation()!;
    create.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      const row = (await realCreate(args)) as { id: string };
      batches.set(row.id, { ...batches.get(row.id)!, archived: true });
      return batches.get(row.id)!;
    });
    runBatchImpl.mockImplementation(async () => {
      throw new Error("boom");
    });
    try {
      await postBatch(token, { dryRun: false, secretRef: "${vault:gh}" });
      const row = [...batches.values()][0];
      expect(row.archived).toBe(true);
      expect(row.status).toBe("pending"); // left exactly as it was
    } finally {
      create.mockImplementation(realCreate);
    }
  });

  it("does not overwrite a batch the publisher already settled", async () => {
    // `runBatch` sets `failed` itself on auto-rollback and then rethrows in
    // some paths; the wrapper must not clobber that richer message.
    const token = await login("coordinator");
    runBatchImpl.mockImplementation(async () => {
      const row = [...batches.values()][0];
      batches.set(row.id, {
        ...row,
        status: "failed",
        errorMessage: "auto-rollback after >50% failures; closed 2 created issue(s) on GitHub",
      });
      throw new Error("boom");
    });
    await postBatch(token, { dryRun: false, secretRef: "${vault:gh}" });
    expect([...batches.values()][0].errorMessage).toContain("closed 2 created issue(s)");
  });

  it("never masks the original error if marking the batch failed also fails", async () => {
    const token = await login("coordinator");
    const update = prisma.publishBatch.update as ReturnType<typeof vi.fn>;
    const realUpdate = update.getMockImplementation()!;
    runBatchImpl.mockImplementation(async () => {
      throw new Error("original failure");
    });
    update.mockImplementation(async () => {
      throw new Error("db unavailable");
    });
    try {
      const res = await postBatch(token, { dryRun: false, secretRef: "${vault:gh}" });
      // The request still fails — it does not turn into a 500 about the DB
      // write, nor a spurious success.
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      update.mockImplementation(realUpdate);
    }
  });
});

describe("#1093 — a dry run rejects what the live run rejects", () => {
  it("400s a malformed ref on a DRY RUN too, instead of reporting completed", async () => {
    const token = await login("coordinator");
    const res = await postBatch(token, { dryRun: true, secretRef: "vault:github-mgcronin" });
    // Previously: 201 Created, status "completed", a full 104-action plan and
    // no warning — for input the live run rejects outright.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VAULT_REF_INVALID");
    expect(batches.size).toBe(0);
  });

  it("still allows a credential-less preview", async () => {
    // A preview with no ref is legitimate — the plan is what the user wants —
    // so it must not be blocked; the plan reports `credentialResolved: false`.
    const token = await login("coordinator");
    const res = await postBatch(token, { dryRun: true });
    expect(res.status).toBe(201);
  });
});

describe("#1094 — the 400 explains the format without echoing the value", () => {
  it("names the field and the required shape", async () => {
    const token = await login("coordinator");
    const res = await postBatch(token, { dryRun: false, secretRef: "vault:github-mgcronin" });
    const message = res.body.error.message as string;
    // Was: "The request could not be processed." — true, useless, and the
    // reporter only recovered by reading vault-resolver.ts.
    expect(message).not.toBe("The request could not be processed.");
    expect(message).toContain("${vault:");
    expect(message.toLowerCase()).toContain("vault secret ref");
    // The error code is surfaced too, so a user can self-diagnose.
    expect(res.body.error.code).toBe("VAULT_REF_INVALID");
  });

  it("translates a ConnectorError raised deeper in the run into a vetted message", async () => {
    // A well-formed ref that no secret matches only fails once `runBatch`
    // resolves it. That ConnectorError used to reach the central handler,
    // which (correctly) refuses to forward connector messages — so the user
    // got the generic string again.
    const token = await login("coordinator");
    runBatchImpl.mockImplementation(async () => {
      const err = new Error("vault reference ${vault:ghost} could not be resolved") as Error & {
        status: number;
        code: string;
      };
      err.name = "ConnectorError";
      err.status = 400;
      err.code = "VAULT_REF_UNRESOLVED";
      throw err;
    });
    const res = await postBatch(token, { dryRun: false, secretRef: "${vault:ghost}" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VAULT_REF_UNRESOLVED");
    expect(res.body.error.message).toMatch(/no matching secret exists/i);
    // The connector's own message is still discarded — it is the one that can
    // carry resolved addresses and upstream text.
    expect(res.body.error.message).not.toContain("could not be resolved");
  });

  it("does NOT echo the submitted value back to the client", async () => {
    // This field is where a user may paste a raw PAT by mistake. The
    // underlying ConnectorError embeds a preview of the input; that message is
    // deliberately not forwarded.
    const token = await login("coordinator");
    const secret = "ghp_averyrealisticlookingtokenvalue123456";
    const res = await postBatch(token, { dryRun: false, secretRef: secret });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(JSON.stringify(res.body)).not.toContain("ghp_");
  });
});

describe("assertValidSecretRef", () => {
  it("accepts the ${vault:label} form", () => {
    expect(() => assertValidSecretRef("${vault:gh-publish-token}", false)).not.toThrow();
  });

  it.each(["vault:gh", "gh-publish-token", "${vault:}", "${vault:   }", "$ {vault:x}", ""])(
    "rejects %j on a live run",
    (ref) => {
      expect(() => assertValidSecretRef(ref, false)).toThrow();
    },
  );

  it("allows an absent ref on a dry run but not on a live run", () => {
    expect(() => assertValidSecretRef(undefined, true)).not.toThrow();
    expect(() => assertValidSecretRef(undefined, false)).toThrow(/live publish requires/i);
  });

  it("still rejects a malformed ref on a dry run", () => {
    expect(() => assertValidSecretRef("vault:gh", true)).toThrow();
  });
});
