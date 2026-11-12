/**
 * #2335 — `POST /api/webhooks/github/push` and `/github/push/c/:connectorId`.
 *
 * The real router, the real delivery-id dedup (`webhook-dedup.ts`) and the
 * real signed-body claim (`payload-replay.ts`), over in-memory tables that
 * refuse a duplicate key the way the database's unique constraint does. Only
 * `requestRepoConnectorRefresh` is replaced (it would start a real pull), so
 * every test reads which connector the receiver asked to refresh, with which
 * commit, and how often.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ConnRow {
  id: string;
  projectId: string;
  provider: string;
  ownerOrOrg: string;
  repoName: string;
  apiBaseUrl: string | null;
  defaultBranch: string;
  webhookSecretNonce: string | null;
  webhookSecretCheck: string | null;
  deletedAt: Date | null;
  projectDeleted: boolean;
}

const h = vi.hoisted(() => ({
  conns: [] as Array<Record<string, unknown>>,
  deliveries: new Set<string>(),
  digests: new Set<string>(),
  failMatch: false,
  failDedup: false,
  failDigest: false,
  findMany: [] as Array<Record<string, unknown>>,
  findFirst: 0,
  /** Runs after the secret lookup: a connector deleted between verification and match. */
  afterFindFirst: null as null | (() => void),
  requestRefresh: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

function dupError(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/lib/prisma.js", () => {
  const live = (c: Record<string, unknown>) => c.deletedAt === null && c.projectDeleted !== true;
  return {
    prisma: {
      repoConnection: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
          h.findFirst += 1;
          const found = h.conns.find((c) => c.id === where.id && live(c)) ?? null;
          h.afterFindFirst?.();
          return found ? { ...found } : null;
        }),
        findMany: vi.fn(
          async (args: {
            where: {
              id?: string;
              ownerOrOrg?: string;
              repoName?: string;
              provider?: { in: string[] };
              deletedAt?: null;
              project?: { deletedAt?: null };
            };
            take?: number;
          }) => {
            h.findMany.push(args as unknown as Record<string, unknown>);
            if (h.failMatch) throw new Error("database down");
            const w = args.where;
            return (
              h.conns
                // Honours the query's own soft-delete terms (not `live`), so a
                // receiver that dropped them would refresh a deleted connector.
                .filter(
                  (c) =>
                    (!("deletedAt" in w) || c.deletedAt === null) &&
                    (w.project?.deletedAt !== null || c.projectDeleted !== true) &&
                    (w.id === undefined || c.id === w.id) &&
                    (w.ownerOrOrg === undefined || c.ownerOrOrg === w.ownerOrOrg) &&
                    (w.repoName === undefined || c.repoName === w.repoName) &&
                    (w.provider === undefined || w.provider.in.includes(c.provider as string)),
                )
                .slice(0, args.take ?? Infinity)
            );
          },
        ),
      },
      prReviewWebhookDelivery: {
        create: vi.fn(async ({ data }: { data: { deliveryId: string } }) => {
          if (h.failDedup) throw new Error("dedup table down");
          if (h.deliveries.has(data.deliveryId)) throw dupError();
          h.deliveries.add(data.deliveryId);
          return data;
        }),
        deleteMany: vi.fn(async ({ where }: { where: { deliveryId: string } }) => {
          h.deliveries.delete(where.deliveryId);
          return { count: 1 };
        }),
      },
      webhookPayloadDigest: {
        create: vi.fn(
          async ({
            data,
          }: {
            data: { receiver: string; eventType: string; bodySha256: string };
          }) => {
            if (h.failDigest) throw new Error("digest table down");
            const key = `${data.receiver}|${data.eventType}|${data.bodySha256}`;
            if (h.digests.has(key)) throw dupError();
            h.digests.add(key);
            return data;
          },
        ),
        deleteMany: vi.fn(
          async ({
            where,
          }: {
            where: { receiver: string; eventType: string; bodySha256: string };
          }) => {
            h.digests.delete(`${where.receiver}|${where.eventType}|${where.bodySha256}`);
            return { count: 1 };
          },
        ),
      },
    },
  };
});
vi.mock("../src/lib/connectors/repo/refresh-trigger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/connectors/repo/refresh-trigger.js")>()),
  requestRepoConnectorRefresh: h.requestRefresh,
}));

const { githubPrWebhookRouter } = await import("../src/routes/webhooks-github.js");
const { __resetRepoRefreshRateLimit } =
  await import("../src/lib/connectors/repo/refresh-trigger.js");
const { connectorWebhookSecret, newWebhookSecretNonce, webhookSecretCheck, webhookSecretRootKey } =
  await import("../src/lib/connectors/repo/webhook-secret.js");
const { __resetWebhookReceiverRateLimiter } =
  await import("../src/middleware/webhook-receiver-rate-limit.js");

const DEPLOYMENT_SECRET = "deployment-secret-2335";
const MASTER_KEY = Buffer.alloc(32, 23).toString("base64");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function conn(over: Partial<ConnRow> = {}): ConnRow {
  return {
    id: "conn-main",
    projectId: "proj-1",
    provider: "github",
    ownerOrOrg: "acme",
    repoName: "app",
    apiBaseUrl: null,
    defaultBranch: "main",
    webhookSecretNonce: null,
    webhookSecretCheck: null,
    deletedAt: null,
    projectDeleted: false,
    ...over,
  };
}

/** Give `row` its own active secret; returns the secret GitHub would hold. */
function withOwnSecret(row: ConnRow): string {
  const root = webhookSecretRootKey()!;
  const nonce = newWebhookSecretNonce();
  row.webhookSecretNonce = nonce;
  row.webhookSecretCheck = webhookSecretCheck(root, row.id, nonce);
  return connectorWebhookSecret(root, row.id, nonce);
}

function pushBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    before: "f".repeat(40),
    after: SHA_A,
    commits: [],
    pusher: { name: "dev" },
    repository: {
      full_name: "acme/app",
      html_url: "https://github.com/acme/app",
      pushed_at: Math.floor(Date.now() / 1000),
    },
    ...over,
  });
}

function sign(body: string, secret = DEPLOYMENT_SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/** The outcome the receiver logged for the last handled push (its answer is opaque on `/github/push`). */
function handled(): Record<string, unknown> | undefined {
  const calls = h.info.mock.calls.filter((c) => c[0] === "push_webhook.handled");
  return calls.at(-1)?.[1] as Record<string, unknown> | undefined;
}

function makeApp(): express.Application {
  const app = express();
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }),
  );
  app.use("/api/webhooks", githubPrWebhookRouter());
  return app;
}

function post(
  body: string,
  opts: { path?: string; signature?: string | null; delivery?: string } = {},
) {
  let req = request(makeApp())
    .post(opts.path ?? "/api/webhooks/github/push")
    .set("content-type", "application/json");
  if (opts.signature !== null) req = req.set("x-hub-signature-256", opts.signature ?? sign(body));
  if (opts.delivery) req = req.set("x-github-delivery", opts.delivery);
  return req.send(body);
}

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = DEPLOYMENT_SECRET;
  process.env.VAULT_MASTER_KEY = MASTER_KEY;
  process.env.WEBHOOK_RECEIVER_LIMIT_MAX = "100000";
  __resetWebhookReceiverRateLimiter();
  h.conns = [conn() as unknown as Record<string, unknown>];
  h.requestRefresh.mockImplementation((_id: string, req: { commitSha?: string | null }) => ({
    status: "started",
    trigger: "push",
    commitSha: req.commitSha ?? null,
  }));
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.VAULT_MASTER_KEY;
  delete process.env.WEBHOOK_RECEIVER_LIMIT_MAX;
  delete process.env.REPO_REFRESH_REQUEST_LIMIT_MAX;
  h.deliveries.clear();
  h.digests.clear();
  h.findMany = [];
  h.findFirst = 0;
  h.afterFindFirst = null;
  h.failMatch = false;
  h.failDedup = false;
  h.failDigest = false;
  h.requestRefresh.mockReset();
  h.info.mockClear();
  h.warn.mockClear();
  __resetRepoRefreshRateLimit();
});

describe("push receiver: signature (#2335)", () => {
  it("a missing signature is 401 and does nothing", async () => {
    const res = await post(pushBody(), { signature: null });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, reason: "MISSING_SIGNATURE" });
    expect(h.findMany).toHaveLength(0);
    expect(h.deliveries.size + h.digests.size).toBe(0);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("a wrong signature is 401 and does nothing", async () => {
    const body = pushBody();
    const res = await post(body, { signature: sign(body, "not-the-secret") });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("BAD_SIGNATURE");
    expect(h.findMany).toHaveLength(0);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("a signature over a different body is 401", async () => {
    const res = await post(pushBody(), { signature: sign(pushBody({ after: SHA_B })) });
    expect(res.status).toBe(401);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("a deployment receiver with no secret configured refuses everything", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const body = pushBody();
    const res = await post(body, { signature: sign(body, "") });
    expect(res.status).toBe(401);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });
});

describe("push receiver: matching and refresh (#2335)", () => {
  it("a push to the tracked branch requests that connector's refresh with the pushed commit", async () => {
    const res = await post(pushBody(), { delivery: "d-1" });
    expect(res.status).toBe(200);
    // The shared-secret answer says nothing about which connectors matched (#1475).
    expect(res.body).toEqual({ ok: true });
    expect(handled()).toEqual({ deliveryId: "d-1", repo: "acme/app", started: 1, queued: 0 });
    expect(h.requestRefresh).toHaveBeenCalledExactlyOnceWith("conn-main", {
      trigger: "push",
      commitSha: SHA_A,
    });
  });

  it("reports a request folded into a running sync as queued", async () => {
    h.requestRefresh.mockReturnValueOnce({
      status: "queued",
      trigger: "push",
      commitSha: SHA_A,
      requests: 1,
    });
    const res = await post(pushBody());
    expect(res.body).toEqual({ ok: true });
    expect(handled()).toMatchObject({ started: 0, queued: 1 });
  });

  it("ignores, with a logged reason, a push to another branch", async () => {
    const res = await post(pushBody({ ref: "refs/heads/feature/x" }));
    expect(res.body).toEqual({ ok: true });
    expect(h.requestRefresh).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(
      "push_webhook.ignored",
      expect.objectContaining({ reason: "UNTRACKED_BRANCH" }),
    );
  });

  it.each([
    ["a tag push", { ref: "refs/tags/v1.2.0" }, "TAG_PUSH"],
    ["a branch deletion", { deleted: true, after: "0".repeat(40) }, "REF_DELETED"],
    ["an unsafe ref", { ref: "refs/heads/main;id" }, "INVALID_REF"],
    ["a malformed commit", { after: "HEAD~1" }, "INVALID_COMMIT_SHA"],
  ])("ignores %s with a logged reason, before claiming anything", async (_l, over, reason) => {
    const res = await post(pushBody(over), { delivery: "d-ignored" });
    expect(res.body).toEqual({ ok: true, handled: false, reason });
    expect(h.info).toHaveBeenCalledWith(
      "push_webhook.ignored",
      expect.objectContaining({ reason }),
    );
    expect(h.findMany).toHaveLength(0);
    expect(h.deliveries.size + h.digests.size).toBe(0);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("does not act on a signed body that is not a push (a ping, a pull request)", async () => {
    for (const body of [
      JSON.stringify({ zen: "hi", hook_id: 1 }),
      JSON.stringify({ action: "opened", pull_request: { number: 1 }, repository: {} }),
    ]) {
      const res = await post(body);
      expect(res.body).toEqual({ ok: true, handled: false, reason: "NOT_PUSH_EVENT" });
    }
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("does not act on a push older than the replay window", async () => {
    const old = Math.floor(Date.now() / 1000) - 5 * 24 * 3600;
    const res = await post(pushBody({ repository: { full_name: "acme/app", pushed_at: old } }));
    expect(res.body).toEqual({ ok: true, handled: false, reason: "STALE_DELIVERY" });
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("says when no connector connects the repository", async () => {
    h.conns = [];
    const res = await post(pushBody());
    // The same answer as a match: whether anyone connects the repository is not said.
    expect(res.body).toEqual({ ok: true });
    expect(h.info).toHaveBeenCalledWith(
      "push_webhook.ignored",
      expect.objectContaining({ reason: "NO_MATCHING_CONNECTOR" }),
    );
  });

  it("refreshes every project's connector that tracks the branch, but not another host's, another branch's, a deleted one, or a project with its own secret", async () => {
    const ownSecret = conn({ id: "conn-own", projectId: "proj-own" });
    withOwnSecret(ownSecret);
    h.conns = [
      conn(),
      conn({ id: "conn-other-project", projectId: "proj-2" }),
      conn({ id: "conn-dev", projectId: "proj-3", defaultBranch: "develop" }),
      conn({
        id: "conn-ghe",
        projectId: "proj-4",
        provider: "github_enterprise",
        apiBaseUrl: "https://ghe.corp.example/api/v3",
      }),
      conn({ id: "conn-deleted", projectId: "proj-5", deletedAt: new Date() }),
      conn({ id: "conn-dead-project", projectId: "proj-6", projectDeleted: true }),
      // Same project as the own-secret connector: that project takes only what its secret signs.
      conn({ id: "conn-own-sibling", projectId: "proj-own" }),
      ownSecret,
    ] as unknown as Array<Record<string, unknown>>;
    expect((await post(pushBody())).body).toEqual({ ok: true });
    expect(handled()).toMatchObject({ started: 2 });
    expect(h.requestRefresh.mock.calls.map((c) => c[0]).sort()).toEqual([
      "conn-main",
      "conn-other-project",
    ]);
    // Only GitHub connectors are asked for, and the fan-out is bounded.
    expect(h.findMany[0]).toMatchObject({
      where: {
        ownerOrOrg: "acme",
        repoName: "app",
        provider: { in: ["github", "github_enterprise"] },
        deletedAt: null,
        project: { deletedAt: null },
      },
      take: 1000,
    });
  });

  it("caps the fan-out after the host, own-secret and branch filters, and logs what the cap left out", async () => {
    const rows: ConnRow[] = [];
    const n = (i: number) => String(i).padStart(2, "0");
    // Sorted first by id, and none of them qualify: another branch, another host.
    for (let i = 0; i < 30; i += 1)
      rows.push(conn({ id: `a-dev-${n(i)}`, projectId: `pd-${i}`, defaultBranch: "develop" }));
    for (let i = 0; i < 30; i += 1)
      rows.push(
        conn({
          id: `b-ghe-${n(i)}`,
          projectId: `pg-${i}`,
          provider: "github_enterprise",
          apiBaseUrl: "https://ghe.corp.example/api/v3",
        }),
      );
    for (let i = 0; i < 55; i += 1) rows.push(conn({ id: `c-main-${n(i)}`, projectId: `pm-${i}` }));
    h.conns = rows as unknown as Array<Record<string, unknown>>;
    await post(pushBody(), { delivery: "d-fan" });
    const refreshed = h.requestRefresh.mock.calls.map((c) => c[0] as string);
    expect(refreshed).toHaveLength(50);
    expect(refreshed.every((id) => id.startsWith("c-main-"))).toBe(true);
    expect(h.warn).toHaveBeenCalledWith(
      "push_webhook.fanout_capped",
      expect.objectContaining({
        deliveryId: "d-fan",
        cap: 50,
        capped: 5,
        cappedConnectorIds: ["c-main-50", "c-main-51", "c-main-52", "c-main-53", "c-main-54"],
      }),
    );
  });

  it("never refreshes a deleted connector, or a connector in a deleted project", async () => {
    h.conns = [
      conn({ id: "conn-deleted", deletedAt: new Date() }),
      conn({ id: "conn-dead-project", projectId: "proj-dead", projectDeleted: true }),
    ] as unknown as Array<Record<string, unknown>>;
    expect((await post(pushBody())).body).toEqual({ ok: true });
    expect(h.requestRefresh).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(
      "push_webhook.ignored",
      expect.objectContaining({ reason: "NO_MATCHING_CONNECTOR" }),
    );
  });

  it("never refreshes its own connector once it, or its project, is deleted", async () => {
    const overs: Array<Partial<ConnRow>> = [{ deletedAt: new Date() }, { projectDeleted: true }];
    for (const [i, over] of overs.entries()) {
      const row = conn();
      const secret = withOwnSecret(row);
      h.conns = [row as unknown as Record<string, unknown>];
      // Verified while live (the secret lookup), deleted before the match.
      h.afterFindFirst = () => Object.assign(row, over);
      const body = pushBody({ after: String(i + 7).repeat(40) });
      const res = await post(body, {
        path: "/api/webhooks/github/push/c/conn-main",
        signature: sign(body, secret),
      });
      expect(res.body).toEqual({ ok: true, handled: false, reason: "NO_MATCHING_CONNECTOR" });
    }
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("matches an Enterprise push to that server's connectors only", async () => {
    h.conns = [
      conn(),
      conn({
        id: "conn-ghe",
        projectId: "proj-4",
        provider: "github_enterprise",
        apiBaseUrl: "https://ghe.corp.example/api/v3",
      }),
    ] as unknown as Array<Record<string, unknown>>;
    await post(
      pushBody({
        repository: {
          full_name: "acme/app",
          html_url: "https://ghe.corp.example/acme/app",
          pushed_at: Math.floor(Date.now() / 1000),
        },
      }),
    );
    expect(handled()).toMatchObject({ started: 1 });
    expect(h.requestRefresh).toHaveBeenCalledExactlyOnceWith("conn-ghe", expect.anything());
  });

  it("gives the claims back and answers 503 when the connector lookup fails", async () => {
    h.failMatch = true;
    const res = await post(pushBody(), { delivery: "d-503" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, reason: "MATCH_UNAVAILABLE" });
    expect(h.deliveries.size + h.digests.size).toBe(0);
    // GitHub's redelivery is then processed.
    h.failMatch = false;
    const again = await post(pushBody(), { delivery: "d-503" });
    expect(again.body).toEqual({ ok: true });
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("push receiver: replay protection (#2335)", () => {
  it("acknowledges a delivery id seen before and does not process it again", async () => {
    const first = await post(pushBody(), { delivery: "d-same" });
    expect(first.body).toEqual({ ok: true });
    // GitHub's redelivery: same id (the body may differ in key order; it is the id that matches).
    const second = await post(pushBody({ after: SHA_B }), { delivery: "d-same" });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
    expect([...h.deliveries]).toEqual(["github-push:deployment:d-same"]);
  });

  it("refuses the same signed body replayed under a fresh delivery id", async () => {
    const body = pushBody();
    await post(body, { delivery: "d-1" });
    const replay = await post(body, { delivery: "d-2" });
    expect(replay.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_PAYLOAD" });
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("a failed delivery-id write is logged and the signed-body claim still guards", async () => {
    h.failDedup = true;
    const body = pushBody();
    expect((await post(body, { delivery: "d-x" })).body).toEqual({ ok: true });
    expect(h.warn).toHaveBeenCalledWith(
      "push_webhook.dedup_failed",
      expect.objectContaining({ deliveryId: "d-x" }),
    );
    const replay = await post(body, { delivery: "d-x" });
    expect(replay.body).toEqual({ ok: true, handled: false, reason: "DUPLICATE_PAYLOAD" });
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
  });

  it("fails closed (503) when the signed-body claim cannot be written, and keeps no delivery row", async () => {
    h.failDigest = true;
    const res = await post(pushBody(), { delivery: "d-y" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, reason: "REPLAY_GUARD_UNAVAILABLE" });
    expect(h.deliveries.size).toBe(0);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("claims a body with no signed time under the untimed retention", async () => {
    const body = pushBody({ repository: { full_name: "acme/app" } });
    expect((await post(body)).body).toEqual({ ok: true });
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
    expect([...h.digests][0]).toMatch(/^untimed:github-push\|push\|/);
  });
});

describe("push receiver: per-connector rate limit (#2335)", () => {
  it("limits a flood before any claim write or connector lookup, answering opaquely", async () => {
    process.env.REPO_REFRESH_REQUEST_LIMIT_MAX = "2";
    for (const sha of ["1", "2"]) {
      const ok = await post(pushBody({ after: sha.repeat(40) }), { delivery: `d-ok-${sha}` });
      expect(ok.body).toEqual({ ok: true });
    }
    const lookups = h.findMany.length;
    const claims = h.deliveries.size + h.digests.size;
    for (const sha of ["3", "4", "5"]) {
      const limited = await post(pushBody({ after: sha.repeat(40) }), {
        delivery: `d-lim-${sha}`,
      });
      // Opaque on the shared-secret receiver; the connection's own URL answers 429 (below).
      expect(limited.status).toBe(200);
      expect(limited.body).toEqual({ ok: true });
    }
    expect(h.findMany).toHaveLength(lookups);
    expect(h.deliveries.size + h.digests.size).toBe(claims);
    expect(h.requestRefresh).toHaveBeenCalledTimes(2);
    expect(h.warn).toHaveBeenCalledWith(
      "push_webhook.rate_limited",
      expect.objectContaining({ deliveryId: "d-lim-3", repo: "acme/app" }),
    );
  });

  it("counts only verified deliveries, and gives each repository its own budget", async () => {
    process.env.REPO_REFRESH_REQUEST_LIMIT_MAX = "1";
    // Unsigned and wrongly signed calls do not spend the repository's budget.
    await post(pushBody(), { signature: null });
    await post(pushBody(), { signature: sign(pushBody(), "wrong") });
    expect((await post(pushBody({ after: "1".repeat(40) }))).body).toEqual({ ok: true });
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
    h.conns.push(
      conn({ id: "conn-other-repo", projectId: "proj-o", repoName: "other" }) as unknown as Record<
        string,
        unknown
      >,
    );
    await post(
      pushBody({
        after: "2".repeat(40),
        repository: {
          full_name: "acme/other",
          html_url: "https://github.com/acme/other",
          pushed_at: Math.floor(Date.now() / 1000),
        },
      }),
    );
    expect(h.requestRefresh).toHaveBeenCalledTimes(2);
    expect(h.requestRefresh).toHaveBeenLastCalledWith("conn-other-repo", expect.anything());
  });

  it("gives each pushed branch its own budget, so untracked-branch pushes cannot starve the tracked one", async () => {
    // Default budget (20 a minute). 25 pushes to a branch no connection tracks...
    for (let i = 0; i < 25; i++) {
      const sha = i.toString(16).padStart(40, "f");
      await post(pushBody({ ref: "refs/heads/feature/x", after: sha }), { delivery: `d-fx-${i}` });
    }
    expect(h.requestRefresh).not.toHaveBeenCalled();
    // ...then one to the tracked branch, inside the same window, still refreshes.
    const res = await post(pushBody({ after: "a".repeat(40) }), { delivery: "d-main-after" });
    expect(res.body).toEqual({ ok: true });
    expect(h.requestRefresh).toHaveBeenCalledExactlyOnceWith("conn-main", expect.anything());
    expect(h.warn).not.toHaveBeenCalledWith(
      "push_webhook.rate_limited",
      expect.objectContaining({ deliveryId: "d-main-after" }),
    );
  });

  it("still limits the tracked branch itself past its budget", async () => {
    for (let i = 0; i < 21; i++) {
      const sha = i.toString(16).padStart(40, "c");
      await post(pushBody({ after: sha }), { delivery: `d-main-${i}` });
    }
    expect(h.requestRefresh).toHaveBeenCalledTimes(20);
    expect(h.warn).toHaveBeenCalledWith(
      "push_webhook.rate_limited",
      expect.objectContaining({ deliveryId: "d-main-20" }),
    );
  });
});

describe("push receiver: a connection's own secret, the CI / git-hook call (#2335)", () => {
  const PATH = "/api/webhooks/github/push/c/conn-main";

  it("refreshes that connector for a push signed with its own secret", async () => {
    const row = conn();
    const secret = withOwnSecret(row);
    h.conns = [row as unknown as Record<string, unknown>];
    const body = pushBody();
    const res = await post(body, { path: PATH, signature: sign(body, secret), delivery: "d-c" });
    expect(res.body).toMatchObject({ handled: true, started: 1 });
    expect(h.requestRefresh).toHaveBeenCalledExactlyOnceWith("conn-main", {
      trigger: "push",
      commitSha: SHA_A,
    });
    expect(h.findMany[0]).toMatchObject({ where: { id: "conn-main" } });
    expect([...h.deliveries]).toEqual(["github-push:c:conn-main:d-c"]);
    expect([...h.digests][0]).toMatch(/^github-push:c:conn-main\|push\|/);
  });

  it("accepts the minimal body a CI job or git hook builds", async () => {
    const row = conn();
    const secret = withOwnSecret(row);
    h.conns = [row as unknown as Record<string, unknown>];
    const body = JSON.stringify({
      ref: "refs/heads/main",
      before: "0".repeat(40),
      after: SHA_B,
      commits: [],
      pusher: { name: "ci" },
      repository: { full_name: "acme/app", pushed_at: Math.floor(Date.now() / 1000) },
    });
    const res = await post(body, { path: PATH, signature: sign(body, secret) });
    expect(res.body).toMatchObject({ handled: true, started: 1 });
    expect(h.requestRefresh).toHaveBeenCalledWith("conn-main", {
      trigger: "push",
      commitSha: SHA_B,
    });
  });

  it("refuses the deployment secret at a connector's URL", async () => {
    const row = conn();
    withOwnSecret(row);
    h.conns = [row as unknown as Record<string, unknown>];
    const body = pushBody();
    const res = await post(body, { path: PATH, signature: sign(body) });
    expect(res.status).toBe(401);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("refuses an unsigned call before looking the connector up", async () => {
    const res = await post(pushBody(), { path: PATH, signature: null });
    expect(res.status).toBe(401);
    expect(h.findFirst).toBe(0);
  });

  it("refuses a body naming another repository than the connector's", async () => {
    const row = conn();
    const secret = withOwnSecret(row);
    h.conns = [row as unknown as Record<string, unknown>];
    const body = pushBody({
      repository: { full_name: "acme/other", pushed_at: Math.floor(Date.now() / 1000) },
    });
    const res = await post(body, { path: PATH, signature: sign(body, secret) });
    expect(res.status).toBe(401);
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("ignores a push to a branch the connector does not track", async () => {
    const row = conn({ defaultBranch: "trunk" });
    const secret = withOwnSecret(row);
    h.conns = [row as unknown as Record<string, unknown>];
    const body = pushBody();
    const res = await post(body, { path: PATH, signature: sign(body, secret) });
    expect(res.body).toEqual({ ok: true, handled: false, reason: "UNTRACKED_BRANCH" });
    expect(h.requestRefresh).not.toHaveBeenCalled();
  });

  it("answers 429 when its connector's budget is spent, before any claim write or match", async () => {
    process.env.REPO_REFRESH_REQUEST_LIMIT_MAX = "1";
    const row = conn();
    const secret = withOwnSecret(row);
    h.conns = [row as unknown as Record<string, unknown>];
    const first = pushBody({ after: "1".repeat(40) });
    expect((await post(first, { path: PATH, signature: sign(first, secret) })).status).toBe(200);
    const lookups = h.findMany.length;
    const claims = h.deliveries.size + h.digests.size;
    const body = pushBody({ after: "2".repeat(40) });
    const res = await post(body, { path: PATH, signature: sign(body, secret), delivery: "d-429" });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ ok: false, reason: "RATE_LIMITED" });
    expect(h.findMany).toHaveLength(lookups);
    expect(h.deliveries.size + h.digests.size).toBe(claims);
    expect(h.warn).toHaveBeenCalledWith(
      "push_webhook.rate_limited",
      expect.objectContaining({ deliveryId: "d-429", connectorId: "conn-main" }),
    );
    expect(h.requestRefresh).toHaveBeenCalledTimes(1);
  });
});
