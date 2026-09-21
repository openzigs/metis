/**
 * Epic #728 / Issue #738 — Concurrent edit conflict + 3-way merge.
 *
 * Acceptance criteria covered:
 *   AC2: Given two users open the same Requirement and both edit
 *        simultaneously, when the second submits, they get HTTP 409 with a
 *        VERSION_CONFLICT error and a server diff payload so the UI can show
 *        the MergeConflictModal.
 *
 * Strategy:
 *   - API tests: two `request.newContext()` instances submit concurrent PUTs.
 *   - Browser test: navigate to the spec-kit editor and simulate the conflict
 *     by pre-bumping the server version via API, then submit through the UI;
 *     verify the MergeConflictModal appears.
 *
 * Closes #738
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER } from "../../fixtures/seed-user.js";
import { apiBase } from "../../fixtures/api-base.js";
import { LoginPage } from "../../pages/login.page.js";
import { MergeConflictPage } from "../../pages/MergeConflict.page.js";
import { AnalysisPage } from "../../pages/analysis-inline.page.js";
import { RequirementCollabPage } from "../../pages/RequirementCollab.page.js";

const API_BASE = apiBase();

// ---- Helpers ----------------------------------------------------------------

const COORDINATOR = { username: "coordinator", password: "password" };

async function loginAs(
  username: string,
  password: string,
): Promise<{ userId: string; accessToken: string; api: APIRequestContext }> {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login failed for ${username}: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as {
    data: { user: { id: string }; accessToken: string };
  };
  await ctx.dispose();
  const api = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${body.data.accessToken}` },
  });
  return { userId: body.data.user.id, accessToken: body.data.accessToken, api };
}

/**
 * Run a server-side seed script against the e2e SQLite DB and return its parsed
 * JSON stdout. Shared by the requirement + analysis seeders below; bypasses the
 * AI pipeline so the tests stay deterministic.
 */
async function runSeedScript(scriptName: string, args: string[]): Promise<{ id: string }> {
  const { spawnSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const repoRoot = resolve(new URL(import.meta.url).pathname, "../../../../..");
  const dbFile = process.env.E2E_DB_FILE;
  if (!dbFile) throw new Error("E2E_DB_FILE not set");
  const scriptPath = resolve(repoRoot, "server", "scripts", scriptName);
  const result = spawnSync(
    "pnpm",
    ["--filter", "@metis/server", "exec", "tsx", scriptPath, ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: `file:${dbFile}`, DATABASE_PROVIDER: "sqlite" },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`Seed (${scriptName}) failed:\n${result.stderr}\n${result.stdout}`);
  }
  return JSON.parse(result.stdout) as { id: string };
}

/**
 * Seed a single Requirement by shelling out to the server-side seed script
 * so we bypass the AI pipeline. Returns `{ id, version }`. When `analysisId`
 * is provided the requirement is linked to that analysis so it renders in the
 * analysis page's requirements list; otherwise it is created standalone.
 */
async function seedRequirement(
  projectId: string,
  analysisId = "none",
): Promise<{ id: string; version: number }> {
  const parsed = await runSeedScript("e2e-seed-requirement.ts", [projectId, analysisId]);
  return { id: parsed.id, version: 0 };
}

/**
 * Seed a completed Analysis snapshot for `projectId` (started by `startedById`)
 * and return its id. Used so the analysis page auto-selects a run and renders
 * requirement cards (where the AssigneePicker / SLA badge / merge-conflict
 * editor are mounted).
 */
async function seedAnalysis(projectId: string, startedById: string): Promise<string> {
  const parsed = await runSeedScript("e2e-seed-analysis-grounding.ts", [projectId, startedById]);
  return parsed.id;
}

// ---- Suite ------------------------------------------------------------------

test.describe("Epic #728 / Issue #738 — Concurrent edit conflict (optimistic lock)", () => {
  let adminApi: APIRequestContext;
  let coordinatorApi: APIRequestContext;
  let adminUserId: string;
  let projectId: string;

  test.beforeAll(async () => {
    const [adminPrimed, coordPrimed] = await Promise.all([
      loginAs(ADMIN_USER.username, ADMIN_USER.password),
      loginAs(COORDINATOR.username, COORDINATOR.password),
    ]);
    adminApi = adminPrimed.api;
    coordinatorApi = coordPrimed.api;
    adminUserId = adminPrimed.userId;

    const res = await adminApi.post("/api/projects", {
      data: { name: `collab-conflict-${Date.now()}`, description: "E2E #738" },
    });
    expect(res.status()).toBe(201);
    projectId = (await res.json()).data.id as string;
  });

  test.afterAll(async () => {
    await Promise.all([adminApi?.dispose(), coordinatorApi?.dispose()]);
  });

  // AC2 — happy path: first PUT succeeds and increments version
  test("first PUT with correct version succeeds and increments version", async () => {
    const { id: reqId, version } = await seedRequirement(projectId);

    const res = await adminApi.put(`/api/requirements/${reqId}`, {
      data: { title: "Admin updated title", version },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.version).toBe(version + 1);
  });

  // AC2 — second PUT with stale version returns 409 VERSION_CONFLICT
  test("returns 409 VERSION_CONFLICT when second PUT uses stale version", async () => {
    const { id: reqId, version } = await seedRequirement(projectId);

    // User A submits first — succeeds, server now at version+1.
    const firstRes = await adminApi.put(`/api/requirements/${reqId}`, {
      data: { title: "User A title", version },
    });
    expect(firstRes.status(), await firstRes.text()).toBe(200);

    // User B submits with the original (now stale) version.
    const secondRes = await coordinatorApi.put(`/api/requirements/${reqId}`, {
      data: { title: "User B title", version }, // stale version
    });
    expect(secondRes.status()).toBe(409);
    const body = await secondRes.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("VERSION_CONFLICT");
  });

  // AC2 — 409 payload contains full server diff for 3-way merge modal
  test("409 payload contains serverVersion and clientVersion for merge modal", async () => {
    const { id: reqId, version } = await seedRequirement(projectId);

    // Admin bumps the server version.
    await adminApi.put(`/api/requirements/${reqId}`, {
      data: { title: "Server title (admin)", version },
    });

    // Coordinator sends a conflicting update with stale version.
    const conflictRes = await coordinatorApi.put(`/api/requirements/${reqId}`, {
      data: {
        title: "Coordinator title (stale)",
        body: "Coordinator body",
        version, // stale
      },
    });
    expect(conflictRes.status()).toBe(409);
    const conflictBody = (await conflictRes.json()) as {
      success: boolean;
      error: {
        code: string;
        conflict: boolean;
        serverVersion: Record<string, unknown>;
        clientVersion: Record<string, unknown>;
      };
    };

    // The payload must carry both sides for the MergeConflictModal.
    expect(conflictBody.error.conflict).toBe(true);
    expect(conflictBody.error.serverVersion).toBeDefined();
    expect(conflictBody.error.clientVersion).toBeDefined();
    expect(typeof conflictBody.error.serverVersion.version).toBe("number");
    expect(conflictBody.error.serverVersion.version).toBeGreaterThan(version);
    // The server title should reflect what admin wrote.
    expect(conflictBody.error.serverVersion.title).toBe("Server title (admin)");
    // The client version echoes back what coordinator sent.
    expect(conflictBody.error.clientVersion).toMatchObject({
      title: "Coordinator title (stale)",
      body: "Coordinator body",
      version,
    });
  });

  // AC2 — resubmit using server version resolves the conflict
  test("resubmitting with server version from 409 payload resolves the conflict", async () => {
    const { id: reqId, version } = await seedRequirement(projectId);

    // Admin updates first.
    await adminApi.put(`/api/requirements/${reqId}`, {
      data: { title: "Admin wrote this", version },
    });

    // Coordinator's first attempt (stale version) → 409.
    const conflictRes = await coordinatorApi.put(`/api/requirements/${reqId}`, {
      data: { title: "Coordinator override", version },
    });
    expect(conflictRes.status()).toBe(409);
    const serverVersion = (await conflictRes.json()).error.serverVersion.version as number;

    // Coordinator re-submits using the server version returned in the 409.
    const resolvedRes = await coordinatorApi.put(`/api/requirements/${reqId}`, {
      data: { title: "Coordinator override (resolved)", version: serverVersion },
    });
    expect(resolvedRes.status(), await resolvedRes.text()).toBe(200);
    const resolvedBody = await resolvedRes.json();
    expect(resolvedBody.data.version).toBe(serverVersion + 1);
  });

  // AC2 — update without a version field skips optimistic lock (backwards compat)
  test("PUT without version field skips optimistic lock check", async () => {
    const { id: reqId } = await seedRequirement(projectId);

    const res = await adminApi.put(`/api/requirements/${reqId}`, {
      data: { title: "No-version update" }, // no version field
    });
    expect(res.status(), await res.text()).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  // ---- Browser test: MergeConflictModal appears after a 409 ----------------

  // AC2 — The MergeConflictModal is now wired into the analysis page's
  // requirement editor (ui/.../projects/[id]/analysis/page.tsx, commit
  // 38265fb): on save it reads the current version, PUTs with it, and a stale
  // version yields a 409 whose server diff seeds the 3-way merge modal.
  //
  // We seed a completed analysis + a linked requirement so the page renders a
  // requirement card with the Edit button. Admin opens the editor; a second
  // actor (coordinator) bumps the server version via the API mid-edit; admin's
  // save therefore submits a stale version and the modal appears.
  test("AC2: editing a requirement after a concurrent server bump opens the 3-way merge modal", async ({
    page,
  }) => {
    // Seed an analysis (so a run auto-selects) and a requirement under it.
    const analysisId = await seedAnalysis(projectId, adminUserId);
    const { id: reqId } = await seedRequirement(projectId, analysisId);

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const analysisPage = new AnalysisPage(page);
    await analysisPage.goto(projectId);

    const collab = new RequirementCollabPage(page, reqId);
    await collab.waitForVisible();

    // Open the edit modal and stage a new title.
    const editModal = await collab.openEditModal();
    await editModal.getByLabel("Title").fill("Admin's edited title");

    // While admin's editor is open, a concurrent actor bumps the server
    // version → admin's pending save will now be stale (version 0 vs 1).
    const bump = await coordinatorApi.put(`/api/requirements/${reqId}`, {
      data: { title: "Coordinator changed this first", version: 0 },
    });
    expect(bump.status(), await bump.text()).toBe(200);

    // Admin saves → 409 → MergeConflictModal.
    await editModal.getByRole("button", { name: "Save" }).click();

    const mergeModal = new MergeConflictPage(page);
    await mergeModal.expectVisible();

    // The server-side value is shown for the conflicting field.
    await expect(mergeModal.modal).toContainText("Coordinator changed this first");

    // Resolve by accepting the server version; the modal closes.
    await mergeModal.resolveWithServer();
    await expect(mergeModal.modal).not.toBeVisible();
  });
});
