/**
 * Epic #156 — Async agent platform e2e.
 *
 * 1. Login as admin and create a project.
 * 2. Submit a background run (kind=chat) and poll for terminal status.
 * 3. Send a steer message before completion.
 * 4. Cancel a long-running submitted run.
 * 5. Create a webhook trigger and fire it via HMAC-signed payload.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import crypto from "node:crypto";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function login(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.post("/api/auth/login", {
    data: { username: "admin", password: "password" },
  });
  expect(res.status()).toBe(200);
  return (await res.json()).data.accessToken as string;
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  { tries = 30, delayMs = 200 } = {},
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last as T;
}

test.describe("Async agent platform (#156) @quarantine", () => {
  test("submit, steer, cancel, and trigger an async run", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const token = await login(ctx);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      const slug = `async-${Date.now()}`;
      const projRes = await ctx.post("/api/projects", {
        headers,
        data: { name: `Async ${slug}`, slug, description: "v1.1 async platform e2e" },
      });
      expect(projRes.status()).toBeLessThan(400);
      const project = (await projRes.json()).data;

      // Submit a background chat run
      const submitRes = await ctx.post("/api/runs/background", {
        headers,
        data: { projectId: project.id, kind: "chat", payload: { message: "hi" } },
      });
      expect(submitRes.status()).toBe(202);
      const { data: submitted } = await submitRes.json();
      const runId: string = submitted.runId;
      expect(runId).toBeTruthy();

      // Steer it (idempotent — message stored)
      const steerRes = await ctx.post(`/api/runs/${runId}/steer`, {
        headers,
        data: { message: "actually focus on X", role: "user" },
      });
      expect(steerRes.status()).toBe(202);

      // Poll for terminal status
      const final = await pollUntil(
        async () => {
          const r = await ctx.get(`/api/runs/background/${runId}`, { headers });
          if (r.status() !== 200) return { status: "missing" };
          return (await r.json()).data as { status: string };
        },
        (v) => ["succeeded", "failed", "cancelled"].includes(v.status),
      );
      expect(["succeeded", "failed", "cancelled"]).toContain(final.status);

      // Submit another run and cancel it
      const r2 = await ctx.post("/api/runs/background", {
        headers,
        data: { projectId: project.id, kind: "browse", payload: { url: "about:blank" } },
      });
      const { runId: runId2 } = (await r2.json()).data;
      const cancelRes = await ctx.post(`/api/runs/background/${runId2}/cancel`, { headers });
      expect([200, 202, 409]).toContain(cancelRes.status());

      // Create a webhook trigger and fire it
      const secret = "test-secret";
      const tRes = await ctx.post(`/api/projects/${project.id}/triggers`, {
        headers,
        data: {
          name: "Generic webhook",
          source: "webhook",
          config: { secret, kind: "chat" },
        },
      });
      expect(tRes.status()).toBeLessThan(400);
      const trigger = (await tRes.json()).data;

      const ts = String(Math.floor(Date.now() / 1000));
      const body = JSON.stringify({ payload: { message: "from webhook" } });
      const sig =
        "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
      const fireRes = await ctx.post(`/api/triggers/${trigger.id}/fire`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-metis-signature": sig,
          "x-metis-timestamp": ts,
        },
        data: body,
      });
      expect(fireRes.status()).toBeLessThan(400);
    } finally {
      await ctx.dispose();
    }
  });
});
