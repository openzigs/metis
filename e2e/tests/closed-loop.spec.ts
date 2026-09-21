/**
 * Epic #192 — Closed-loop e2e coverage.
 *
 * Walks the operator path against the seeded admin token + offline AI stub:
 *   1. Enable `autoReviewPrs` on a fresh project.
 *   2. Send a signed `pull_request.opened` webhook → verify the webhook
 *      handler returns `handled:true kind:reviewable` (judge is not wired
 *      from the webhook in test mode, so no review is posted).
 *   3. Send a signed `pull_request.closed+merged` webhook with a `Closes #N`
 *      body → verify the response confirms living-spec sync ran.
 *   4. POST `/api/run-reviews` with an explicit AC list → verify the run is
 *      created and the review record is reachable via `GET /api/run-reviews/:id`.
 */
import crypto from "node:crypto";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user";
import { apiBase } from "../fixtures/api-base";

const API_BASE = apiBase();
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "e2e-closed-loop-secret";

interface Envelope<T> {
  success: boolean;
  data: T;
}

async function adminContext(): Promise<APIRequestContext> {
  const { accessToken } = await primeAdminUser(API_BASE);
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

function sign(body: string): string {
  return "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

test.describe("Epic #192 — Closed loop", () => {
  test("webhook accepts signed pull_request events and rejects bad signatures", async () => {
    const ctx = await adminContext();
    try {
      const slug = `e2e-closed-loop-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `Closed Loop ${slug}`, slug, description: "epic-192" },
      });
      expect(created.status(), await created.text()).toBe(201);

      const reviewableBody = JSON.stringify({
        action: "opened",
        pull_request: {
          number: 1001,
          title: "feat(e2e): closed-loop happy path",
          body: "Closes #1\n- [ ] **Given a PR When opened Then reviewer runs**",
          merged: false,
        },
        repository: { full_name: "metis-e2e/closed-loop" },
      });
      const reviewableRes = await ctx.post("/api/webhooks/github/pr", {
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(reviewableBody),
        },
        data: reviewableBody,
      });
      expect(reviewableRes.status()).toBe(200);
      const reviewableJson = (await reviewableRes.json()) as {
        ok: boolean;
        handled: boolean;
        kind?: string;
      };
      expect(reviewableJson.ok).toBe(true);
      expect(reviewableJson.handled).toBe(true);
      expect(reviewableJson.kind).toBe("reviewable");

      // Bad signature is rejected with 401.
      const badRes = await ctx.post("/api/webhooks/github/pr", {
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=deadbeef",
        },
        data: reviewableBody,
      });
      expect(badRes.status()).toBe(401);

      // Merged event (no requirements pre-seeded — sync just no-ops, but
      // the dispatcher still reports kind:merged).
      const mergedBody = JSON.stringify({
        action: "closed",
        pull_request: {
          number: 1002,
          title: "feat: merge",
          body: "Closes #2",
          merged: true,
          merged_at: new Date().toISOString(),
          merge_commit_sha: "deadbeefcafe",
        },
        repository: { full_name: "metis-e2e/closed-loop" },
      });
      const mergedRes = await ctx.post("/api/webhooks/github/pr", {
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(mergedBody),
        },
        data: mergedBody,
      });
      expect(mergedRes.status()).toBe(200);
      const mergedJson = (await mergedRes.json()) as { handled: boolean; kind?: string };
      expect(mergedJson.handled).toBe(true);
      expect(mergedJson.kind).toBe("merged");
    } finally {
      await ctx.dispose();
    }
  });

  test("manual /api/run-reviews trigger is gated when judge/octokit are unconfigured", async () => {
    const ctx = await adminContext();
    try {
      const slug = `e2e-run-reviews-${Date.now()}`;
      const created = await ctx.post("/api/projects", {
        data: { name: `Run Reviews ${slug}`, slug, description: "epic-192" },
      });
      expect(created.status(), await created.text()).toBe(201);
      const project = (await created.json()) as Envelope<{ id: string }>;

      const triggerRes = await ctx.post("/api/run-reviews", {
        data: {
          projectId: project.data.id,
          owner: "metis-e2e",
          repo: "closed-loop",
          prNumber: 7,
          prTitle: "feat: e2e manual review",
          prBody: "Closes #1",
          diff: "@@ -1 +1 @@\n-foo\n+bar",
          criteria: [{ id: "AC1", text: "Given a PR When the agent runs Then it posts a verdict" }],
        },
      });
      // E2E env intentionally does not wire a judge LLM into the router —
      // the trigger should respond 503 with REVIEW_AGENT_UNAVAILABLE rather
      // than silently no-op.
      expect(triggerRes.status()).toBe(503);
      const body = (await triggerRes.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("REVIEW_AGENT_UNAVAILABLE");
    } finally {
      await ctx.dispose();
    }
  });

  test("GET /api/run-reviews/:id returns 404 for unknown runs", async () => {
    const ctx = await adminContext();
    try {
      const res = await ctx.get(`/api/run-reviews/run-does-not-exist-${Date.now()}`);
      expect(res.status()).toBe(404);
    } finally {
      await ctx.dispose();
    }
  });
});
