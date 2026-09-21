/**
 * Epic #165 / v1.1.0 — SDK alignment e2e against the live API.
 *
 * Flow:
 *   1. Login as the seeded admin.
 *   2. Create a project (custom-agent + plan-mode + resume need a project).
 *   3. Create a custom subagent (#112).
 *   4. Verify GET returns it alongside the four built-ins.
 *   5. Quick `/api/ai/sessions?status=resumable` smoke (#122).
 *
 * Heavier UI flows (plan-mode panel, model picker dropdown) are handled by
 * the in-process Vitest tests; this suite exists to prove the routes wire
 * up correctly through the real Express app.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

async function login(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.post("/api/auth/login", {
    data: { username: "admin", password: "password" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  return body.data.accessToken as string;
}

test.describe("SDK alignment (#165) @quarantine", () => {
  test("can create custom agent and list resumable sessions", async () => {
    const ctx = await request.newContext({ baseURL: API_BASE });
    try {
      const token = await login(ctx);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

      const slug = `sdk-${Date.now()}`;
      const projRes = await ctx.post("/api/projects", {
        headers,
        data: { name: `SDK ${slug}`, slug, description: "v1.1 SDK alignment e2e" },
      });
      expect(projRes.status()).toBeLessThan(400);
      const project = (await projRes.json()).data;

      const agentRes = await ctx.post("/api/custom-agents", {
        headers,
        data: {
          projectId: project.id,
          name: `Reviewer-${Date.now()}`,
          description: "e2e",
          systemPrompt: "Review code",
          tools: [],
        },
      });
      expect(agentRes.status()).toBeLessThan(400);

      const list = await ctx.get(`/api/custom-agents?projectId=${project.id}`, { headers });
      expect(list.status()).toBe(200);
      const agents = (await list.json()).data as unknown[];
      expect(agents.length).toBeGreaterThanOrEqual(5); // 4 built-ins + 1 custom

      const resumable = await ctx.get("/api/ai/sessions?status=resumable", { headers });
      expect(resumable.status()).toBe(200);
      const list2 = (await resumable.json()).data;
      expect(Array.isArray(list2)).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });
});
