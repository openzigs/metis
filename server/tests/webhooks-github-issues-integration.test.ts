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
    issue: { number: opts.number, title: opts.title ?? `Issue #${opts.number}` },
    repository: { full_name: "acme/proj" },
  };
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
    syncIssueEventMock.mockRejectedValueOnce(new Error("boom"));
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
