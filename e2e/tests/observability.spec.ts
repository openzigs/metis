/**
 * Epic #158 — observability + interop e2e spec.
 *
 * Flow under test:
 *   1. Login.
 *   2. Create a project.
 *   3. Seed an AgentRun + steps directly into the e2e SQLite DB (the
 *      offline-stub provider does not produce real OTel traces or replay
 *      rows; we exercise the routes/UI, not the orchestrator).
 *   4. Hit GET /api/runs and GET /api/runs/:id and assert the payloads.
 *   5. Visit /runs in the UI and assert the run appears.
 *   6. Visit /runs/:id and assert the timeline renders.
 *   7. Hit GET /api/projects/:id/agents-md and assert the markdown contains
 *      the built-in specialist names.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test, expect, request } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { apiBase } from "../fixtures/api-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SEED_AGENT_RUN_SCRIPT = path.resolve(REPO_ROOT, "server", "scripts", "e2e-seed-agent-run.ts");

const API_BASE = apiBase();

interface ApiEnvelope<T> {
  success: true;
  data: T;
}

function seedAgentRunViaCli(projectId: string): string {
  const databaseUrl = `file:${process.env.E2E_DB_FILE ?? path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db")}`;
  const result = spawnSync(
    "pnpm",
    ["--filter", "@metis/server", "exec", "tsx", SEED_AGENT_RUN_SCRIPT, projectId],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATABASE_PROVIDER: "sqlite",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `e2e-seed-agent-run.ts failed (status=${result.status}):\n${result.stderr}\n${result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { id: string };
  return parsed.id;
}

test.describe("Epic #158 observability + interop", () => {
  test.beforeAll(async () => {
    await primeAdminUser(API_BASE);
  });

  test("runs list, replay, and AGENTS.md export", async ({ page }) => {
    const ctx = await request.newContext({ baseURL: API_BASE });

    // ---- Login (UI) ----
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
    await page.waitForURL(/dashboard|projects|workbench/);

    // ---- Login via API to get a token for direct REST calls ----
    const loginRes = await ctx.post("/api/auth/login", {
      data: { username: ADMIN_USER.username, password: ADMIN_USER.password },
    });
    expect(loginRes.status()).toBe(200);
    const loginBody = (await loginRes.json()) as ApiEnvelope<{ accessToken: string }>;
    const token = loginBody.data.accessToken;

    const authedHeaders = { Authorization: `Bearer ${token}` };

    // ---- Create a project ----
    const slug = `obs-${Date.now()}`;
    const projRes = await ctx.post("/api/projects", {
      data: { name: `Observability ${slug}`, slug, description: "epic #158 e2e" },
      headers: authedHeaders,
    });
    expect(projRes.status()).toBe(201);
    const projBody = (await projRes.json()) as ApiEnvelope<{ id: string }>;
    const projectId = projBody.data.id;

    // ---- Seed an AgentRun row directly into the e2e DB ----
    const runId = seedAgentRunViaCli(projectId);
    expect(runId).toMatch(/^run_/);

    // ---- API: GET /api/runs ----
    const listRes = await ctx.get(`/api/runs?projectId=${projectId}`, {
      headers: authedHeaders,
    });
    expect(listRes.status()).toBe(200);
    const listBody = (await listRes.json()) as ApiEnvelope<{
      items: Array<{ id: string; stepCount: number }>;
    }>;
    const seeded = listBody.data.items.find((r) => r.id === runId);
    expect(seeded, "seeded run must appear in /api/runs").toBeDefined();
    expect(seeded?.stepCount).toBe(3);

    // ---- API: GET /api/runs/:id ----
    const detailRes = await ctx.get(`/api/runs/${runId}`, { headers: authedHeaders });
    expect(detailRes.status()).toBe(200);
    const detailBody = (await detailRes.json()) as ApiEnvelope<{
      run: { id: string; status: string };
      steps: Array<{ ord: number; kind: string }>;
    }>;
    expect(detailBody.data.run.id).toBe(runId);
    expect(detailBody.data.steps.map((s) => s.kind)).toEqual([
      "agent_phase",
      "tool_call",
      "synthesis",
    ]);

    // ---- UI: /runs page renders the seeded run ----
    await page.goto("/runs");
    await expect(page.getByTestId("runs-page")).toBeVisible();
    await expect(page.getByTestId("runs-table")).toBeVisible({ timeout: 10_000 });

    // ---- UI: /runs/:id page renders the timeline ----
    await page.goto(`/runs/${runId}`);
    await expect(page.getByTestId("run-detail-page")).toBeVisible();
    await expect(page.getByTestId("run-timeline")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("run-step-0")).toBeVisible();
    await expect(page.getByTestId("run-step-1")).toBeVisible();
    await expect(page.getByTestId("run-step-2")).toBeVisible();

    // ---- API: AGENTS.md export ----
    const mdRes = await ctx.get(`/api/projects/${projectId}/agents-md`, {
      headers: authedHeaders,
    });
    expect(mdRes.status()).toBe(200);
    expect(mdRes.headers()["content-type"]).toContain("text/markdown");
    const mdText = await mdRes.text();
    expect(mdText).toContain("## business-analyst");
    expect(mdText).toContain("## architect");
    expect(mdText).toContain("## product-owner");
    expect(mdText).toContain("## quality-engineer");

    // ---- API: AGENTS.md preview returns structured JSON ----
    const previewRes = await ctx.get(`/api/projects/${projectId}/agents-md/preview`, {
      headers: authedHeaders,
    });
    expect(previewRes.status()).toBe(200);
    const previewBody = (await previewRes.json()) as ApiEnvelope<{
      agents: Array<{ name: string }>;
    }>;
    expect(previewBody.data.agents.length).toBeGreaterThanOrEqual(4);

    await ctx.dispose();
  });
});
