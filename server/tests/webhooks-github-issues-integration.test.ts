/**
 * Issue #438 — integration coverage for `POST /api/webhooks/github/issues`.
 *
 * The direct unit tests in `lib/spec-kit/issue-sync.test.ts` exercise the
 * helper but the route-level wiring (HMAC verify → dedup → rate-limit →
 * sync dispatch → 200 contract) was previously 0% covered.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recordDeliveryMock = vi.hoisted(() =>
  vi.fn(async (_input: { deliveryId: string; eventType: string }) => ({
    duplicate: false,
    deliveryId: "set-by-test",
  })),
);

const syncIssueEventMock = vi.hoisted(() =>
  vi.fn(async (_input: unknown) => ({
    handled: true,
    featureSlug: "001-x",
    taskId: "T01",
    change: "checkbox" as const,
    tasksMdVersion: 2,
  })),
);

vi.mock("../src/lib/agents/pr-reviewer/webhook-dedup.js", () => ({
  recordDelivery: recordDeliveryMock,
  attachRunId: vi.fn(async () => undefined),
  purgeOldDeliveries: vi.fn(async () => 0),
}));

vi.mock("../src/lib/spec-kit/issue-sync.js", () => ({
  syncIssueEvent: syncIssueEventMock,
}));

// Issue #96 — the same receiver now runs the drift reconciler too. Stub the
// reconcile step (its DB write + `drift:detected` emit are covered in
// `lib/sync/reconcile-service.test.ts`) and record what reached it.
const reconcileMock = vi.hoisted(() =>
  vi.fn(async (_event: unknown) => ({ handled: true, driftEventId: "drift-1" }) as unknown),
);
vi.mock("../src/lib/sync/reconcile-service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, reconcileIssueChange: reconcileMock };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { repoConnection: { findFirst: vi.fn(async () => null) } },
}));

import { githubPrWebhookRouter } from "../src/routes/webhooks-github.js";
import { __resetGithubIssuesWebhookRateLimiter } from "../src/middleware/github-issues-webhook-rate-limit.js";

const SECRET = "issues-webhook-secret";

beforeEach(() => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  recordDeliveryMock.mockReset();
  recordDeliveryMock.mockImplementation(async (input) => ({
    duplicate: false,
    deliveryId: input.deliveryId,
  }));
  syncIssueEventMock.mockReset();
  syncIssueEventMock.mockImplementation(async () => ({
    handled: true,
    featureSlug: "001-x",
    taskId: "T01",
    change: "checkbox",
    tasksMdVersion: 2,
  }));
  reconcileMock.mockReset();
  reconcileMock.mockImplementation(async () => ({ handled: true, driftEventId: "drift-1" }));
  __resetGithubIssuesWebhookRateLimiter();
  // Generous limits for the happy-path tests; one test below overrides
  // these to assert the throttle path.
  process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_MAX = "1000";
  process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_WINDOW_MS = "60000";
});

afterEach(() => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_MAX;
  delete process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_WINDOW_MS;
  __resetGithubIssuesWebhookRateLimiter();
});

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
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

function issuesPayload(opts: { action: string; number: number; title?: string }) {
  return {
    action: opts.action,
    issue: {
      number: opts.number,
      node_id: `I_node_${opts.number}`,
      title: opts.title ?? `Issue #${opts.number}`,
      body: "b",
      state: "open",
    },
    repository: { full_name: "acme/proj" },
  };
}

function post(app: express.Application, body: string, headers: Record<string, string>) {
  let req = request(app)
    .post("/api/webhooks/github/issues")
    .set("Content-Type", "application/json")
    .set("X-Hub-Signature-256", sign(body));
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body);
}

describe("POST /api/webhooks/github/issues — integration", () => {
  it("rejects an unsigned payload with 401", async () => {
    const app = makeApp();
    const body = JSON.stringify(issuesPayload({ action: "closed", number: 11 }));
    const resp = await request(app)
      .post("/api/webhooks/github/issues")
      .set("Content-Type", "application/json")
      .send(body);
    expect(resp.status).toBe(401);
    expect(resp.body.ok).toBe(false);
    expect(syncIssueEventMock).not.toHaveBeenCalled();
  });

  it("dispatches a signed `closed` payload through to syncIssueEvent", async () => {
    const app = makeApp();
    const body = JSON.stringify(issuesPayload({ action: "closed", number: 12 }));
    const resp = await request(app)
      .post("/api/webhooks/github/issues")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "delivery-12")
      .set("X-GitHub-Event", "issues")
      .send(body);
    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(syncIssueEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: "acme",
        repoName: "proj",
        issueNumber: 12,
        action: "closed",
      }),
    );
    expect(recordDeliveryMock).toHaveBeenCalledWith({
      deliveryId: "delivery-12",
      eventType: "issues",
    });
  });

  it("short-circuits on a duplicate delivery without invoking syncIssueEvent", async () => {
    recordDeliveryMock.mockResolvedValueOnce({ duplicate: true, deliveryId: "dup" });
    const app = makeApp();
    const body = JSON.stringify(issuesPayload({ action: "closed", number: 13 }));
    const resp = await request(app)
      .post("/api/webhooks/github/issues")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "dup")
      .send(body);
    expect(resp.status).toBe(200);
    expect(resp.body.handled).toBe(false);
    expect(resp.body.reason).toBe("DUPLICATE_DELIVERY");
    expect(syncIssueEventMock).not.toHaveBeenCalled();
  });

  it("never 5xxs GitHub even when syncIssueEvent throws", async () => {
    syncIssueEventMock.mockRejectedValueOnce(new Error("boom: /srv/metis/specs/secret-path"));
    const app = makeApp();
    const body = JSON.stringify(issuesPayload({ action: "closed", number: 14 }));
    const resp = await request(app)
      .post("/api/webhooks/github/issues")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "delivery-14")
      .send(body);
    expect(resp.status).toBe(200);
    expect(resp.body.ok).toBe(true);
    expect(resp.body.reason).toBe("SYNC_ERROR");
    // #113 — fixed vocabulary, like the drift half: the cause is logged, never returned.
    expect(resp.body).not.toHaveProperty("error");
    expect(JSON.stringify(resp.body)).not.toContain("secret-path");
  });

  it("acks unhandled actions without dispatching", async () => {
    const app = makeApp();
    const body = JSON.stringify(issuesPayload({ action: "labeled", number: 15 }));
    const resp = await request(app)
      .post("/api/webhooks/github/issues")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-GitHub-Delivery", "delivery-15")
      .send(body);
    expect(resp.status).toBe(200);
    expect(resp.body.handled).toBe(false);
    expect(resp.body.reason).toBe("UNHANDLED_ACTION:labeled");
    expect(syncIssueEventMock).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_MAX = "2";
    process.env.GITHUB_ISSUES_WEBHOOK_LIMIT_WINDOW_MS = "60000";
    __resetGithubIssuesWebhookRateLimiter();

    const app = makeApp();
    const body = JSON.stringify(issuesPayload({ action: "closed", number: 16 }));
    const sig = sign(body);

    // First two requests pass the limiter (still 401 because the signature
    // header is omitted, but they're not 429s).
    for (let i = 0; i < 2; i++) {
      const resp = await request(app)
        .post("/api/webhooks/github/issues")
        .set("Content-Type", "application/json")
        .send(body);
      expect(resp.status).toBe(401);
    }
    // Third hit trips the limiter regardless of signature presence.
    const limited = await request(app)
      .post("/api/webhooks/github/issues")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sig)
      .send(body);
    expect(limited.status).toBe(429);
    expect(limited.body.reason).toBe("RATE_LIMITED");
  });
});

describe("POST /api/webhooks/github/issues — drift reconcile (#96)", () => {
  it("reconciles a signed `issues.edited` delivery and reports it under `drift`", async () => {
    const body = JSON.stringify({
      ...issuesPayload({ action: "edited", number: 21, title: "Edited upstream" }),
      changes: { title: { from: "Original" } },
      sender: { login: "octocat" },
    });
    const resp = await post(makeApp(), body, {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-21",
    });
    expect(resp.status).toBe(200);
    expect(resp.body.drift).toEqual({ handled: true, driftEventId: "drift-1" });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(reconcileMock.mock.calls[0][0]).toMatchObject({
      source: "github",
      deliveryId: "delivery-21",
      externalId: "I_node_21",
      externalRef: "21",
      action: "edited",
      changes: { title: "Edited upstream" },
      actor: "octocat",
    });
    // The spec-kit half still ran for the same delivery.
    expect(syncIssueEventMock).toHaveBeenCalledTimes(1);
    expect(resp.body.handled).toBe(true);
  });

  it("reconciles actions the spec-kit sync does not handle (labeled)", async () => {
    const body = JSON.stringify(issuesPayload({ action: "labeled", number: 22 }));
    const resp = await post(makeApp(), body, {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-22",
    });
    expect(resp.body.reason).toBe("UNHANDLED_ACTION:labeled");
    expect(syncIssueEventMock).not.toHaveBeenCalled();
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(resp.body.drift.handled).toBe(true);
  });

  it("does not reconcile a non-`issues` event, e.g. an issue_comment edit", async () => {
    const body = JSON.stringify(issuesPayload({ action: "edited", number: 23 }));
    const resp = await post(makeApp(), body, {
      "X-GitHub-Event": "issue_comment",
      "X-GitHub-Delivery": "delivery-23",
    });
    expect(resp.status).toBe(200);
    expect(resp.body.drift).toEqual({ handled: false, reason: "NOT_ISSUES_EVENT" });
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("passes an unsupported action through as the normalizer's reason", async () => {
    const body = JSON.stringify(issuesPayload({ action: "pinned", number: 24 }));
    const resp = await post(makeApp(), body, {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-24",
    });
    expect(resp.body.drift).toEqual({ handled: false, reason: "UNSUPPORTED_ACTION" });
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("does not reconcile a replayed delivery", async () => {
    recordDeliveryMock.mockResolvedValueOnce({ duplicate: true, deliveryId: "dup-25" });
    const body = JSON.stringify(issuesPayload({ action: "edited", number: 25 }));
    const resp = await post(makeApp(), body, {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "dup-25",
    });
    expect(resp.body.reason).toBe("DUPLICATE_DELIVERY");
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("mints a delivery id when GitHub sent none, so the DriftEvent key is never empty", async () => {
    const body = JSON.stringify(issuesPayload({ action: "closed", number: 26 }));
    await post(makeApp(), body, { "X-GitHub-Event": "issues" });
    const event = reconcileMock.mock.calls[0][0] as { deliveryId: string };
    expect(event.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("a reconcile failure neither 5xxs GitHub, skips spec-kit, nor echoes the error", async () => {
    reconcileMock.mockRejectedValueOnce(new Error("db exploded: secret-connection-string"));
    const body = JSON.stringify(issuesPayload({ action: "closed", number: 27 }));
    const resp = await post(makeApp(), body, {
      "X-GitHub-Event": "issues",
      "X-GitHub-Delivery": "delivery-27",
    });
    expect(resp.status).toBe(200);
    expect(resp.body.drift).toEqual({ handled: false, reason: "DRIFT_ERROR" });
    expect(JSON.stringify(resp.body)).not.toContain("secret-connection-string");
    expect(syncIssueEventMock).toHaveBeenCalledTimes(1);
    expect(resp.body.handled).toBe(true);
  });

  it("an unsigned delivery reaches neither pipeline", async () => {
    const body = JSON.stringify(issuesPayload({ action: "edited", number: 28 }));
    const resp = await request(makeApp())
      .post("/api/webhooks/github/issues")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Event", "issues")
      .send(body);
    expect(resp.status).toBe(401);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
