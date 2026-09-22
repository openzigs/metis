/**
 * Epic #609 / Issue #622 — API + login helpers for the review & approval
 * workflow e2e suite (`tests/review-approval.spec.ts`).
 *
 * The formal-review feature (#616–#621) ships a reviewer decision UI, a
 * baselines surface, and an approval publish gate — but NOT (yet) a create /
 * submit review UI (see #618). So these specs seed the review lifecycle up to
 * the point of a human decision through the REAL REST surface
 * (`server/src/routes/reviews.ts` + `baselines.ts`), then drive the reviewer's
 * decision, the baseline views, and the publish gate through the browser.
 *
 * Determinism notes carried over from the existing suite:
 *   - The offline-stub AI provider can't emit structured requirements, so a
 *     Requirement is seeded directly into the e2e SQLite DB via
 *     `seedRequirementViaCli` after a real (empty) analysis completes.
 *   - Mock logins upsert only the `User` row and drive permissions from the
 *     JWT role, so `coordinator` (review.decide + review.admin) is a valid
 *     reviewer distinct from the `admin` requester (self-review is forbidden).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { request, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiBase } from "./api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { seedGroundedAnalysisViaCli } from "./seed-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = apiBase();

/** Mock credentials for the users this suite drives. */
export const REQUESTER = { username: "admin", password: "password" } as const;
export const REVIEWER = { username: "coordinator", password: "password" } as const;

export interface PrimedUser {
  userId: string;
  accessToken: string;
}

/**
 * Prime an arbitrary mock user against the running API. Returns the server
 * user id + a bearer token. Idempotent — the login route upserts the `User`
 * row, so priming the same user twice is safe.
 */
export async function primeUser(creds: {
  username: string;
  password: string;
}): Promise<PrimedUser> {
  const ctx = await request.newContext({ baseURL: API_BASE });
  try {
    const res = await ctx.post("/api/auth/login", { data: creds });
    if (!res.ok()) {
      throw new Error(`primeUser(${creds.username}) failed (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as {
      data: { user: { id: string }; accessToken: string };
    };
    return { userId: body.data.user.id, accessToken: body.data.accessToken };
  } finally {
    await ctx.dispose();
  }
}

/** A bearer-authenticated API context bound to the e2e API base URL. */
export async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

/** Resolved SQLite DB path the webServer writes to (see playwright.config.ts). */
export function e2eDatabaseUrl(): string {
  const dbFile =
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db");
  return `file:${dbFile}`;
}

/** Create an isolated project; returns its id. */
export async function createProject(api: APIRequestContext, prefix: string): Promise<string> {
  const slug = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const res = await api.post("/api/projects", {
    data: { name: `Review E2E ${slug}`, slug, description: "epic-609 #622 e2e" },
  });
  expect(res.status(), `create project: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { data?: { id?: string; project?: { id?: string } } };
  const id = body.data?.id ?? body.data?.project?.id;
  expect(id, "project id present").toBeTruthy();
  return id as string;
}

/**
 * Start an analysis with no documents and poll it to a terminal state. The
 * offline-stub produces zero requirements, but a completed analysis id is
 * still required as the `analysisId` FK for a seeded Requirement.
 */
export async function seedCompletedAnalysis(
  api: APIRequestContext,
  projectId: string,
): Promise<string> {
  // Do NOT run the real pipeline here. The deterministic harness uses the
  // `offline-stub` provider, whose hash-derived prose every specialist agent
  // rejects as non-JSON, so a live run always ends `failed` — and a failed
  // analysis is rejected downstream (draft generation 400s, change analysis
  // 400s). Seed a COMPLETED analysis through the same CLI seam the grounding
  // and clarify-loop specs use.
  const meRes = await api.get("/api/auth/me");
  expect(meRes.ok(), `resolve current user: ${await meRes.text()}`).toBeTruthy();
  const me = (await meRes.json()) as { data: { user: { id: string } } };
  return seedGroundedAnalysisViaCli({
    projectId,
    startedById: me.data.user.id,
    databaseUrl: e2eDatabaseUrl(),
  });
}

/** Issue a REAL requirement update so the #771 service appends a version row. */
export async function updateRequirementTitle(
  api: APIRequestContext,
  requirementId: string,
  title: string,
): Promise<void> {
  const res = await api.put(`/api/requirements/${requirementId}`, { data: { title } });
  expect(res.ok(), `update requirement: ${await res.text()}`).toBeTruthy();
}

export interface CreateReviewInput {
  title: string;
  reviewerIds: string[];
  requirementIds: string[];
  description?: string;
}

/** Create a draft review request; returns the new review id. */
export async function createReview(
  api: APIRequestContext,
  projectId: string,
  input: CreateReviewInput,
): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/reviews`, {
    data: {
      title: input.title,
      description: input.description,
      reviewerIds: input.reviewerIds,
      items: input.requirementIds.map((requirementId) => ({ requirementId })),
    },
  });
  expect(res.status(), `create review: ${await res.text()}`).toBe(201);
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id;
  expect(id, "review id present").toBeTruthy();
  return id as string;
}

/** Submit a draft review (draft → in_review, pins item versions). */
export async function submitReview(api: APIRequestContext, reviewId: string): Promise<void> {
  const res = await api.post(`/api/reviews/${reviewId}/submit`);
  expect(res.ok(), `submit review: ${await res.text()}`).toBeTruthy();
}

/** Record a reviewer decision over the REST surface (used where the UI path is not under test). */
export async function recordDecision(
  api: APIRequestContext,
  reviewId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<{ status: string; baselineId: string | null }> {
  const res = await api.post(`/api/reviews/${reviewId}/decision`, {
    data: note ? { decision, note } : { decision },
  });
  expect(res.ok(), `decision: ${await res.text()}`).toBeTruthy();
  const data = ((await res.json()) as { data: { status: string; baselineId: string | null } }).data;
  return data;
}

/** Fetch a review's detail envelope (review + audit history). */
export async function getReview(
  api: APIRequestContext,
  reviewId: string,
): Promise<{ status: string; baseline: { id: string; name: string } | null }> {
  const res = await api.get(`/api/reviews/${reviewId}`);
  expect(res.ok(), `get review: ${await res.text()}`).toBeTruthy();
  return (
    (await res.json()) as {
      data: { review: { status: string; baseline: { id: string; name: string } | null } };
    }
  ).data.review;
}

/** Toggle the per-project `requireApprovedReview` publish/export gate. */
export async function setReviewGate(
  api: APIRequestContext,
  projectId: string,
  requireApprovedReview: boolean,
): Promise<void> {
  const res = await api.patch(`/api/projects/${projectId}/review-gate`, {
    data: { requireApprovedReview },
  });
  expect(res.ok(), `set review gate: ${await res.text()}`).toBeTruthy();
}

/** Create a manual, admin-gated baseline pinning the CURRENT version of each requirement. */
export async function createManualBaseline(
  api: APIRequestContext,
  projectId: string,
  name: string,
  requirementIds: string[],
): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/baselines`, {
    data: { name, requirementIds },
  });
  expect(res.status(), `create baseline: ${await res.text()}`).toBe(201);
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id;
  expect(id, "baseline id present").toBeTruthy();
  return id as string;
}

/** Poll the caller's persisted notifications until one of `type` exists. */
export async function waitForNotification(
  api: APIRequestContext,
  type: string,
  timeoutMs = 20_000,
): Promise<{ title: string; message: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api.get("/api/notifications");
    if (res.ok()) {
      const items =
        (
          (await res.json()) as {
            data?: { notifications?: Array<{ type: string; title: string; message: string }> };
          }
        ).data?.notifications ?? [];
      const found = items.find((n) => n.type === type);
      if (found) return { title: found.title, message: found.message };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`notification of type "${type}" did not arrive within ${timeoutMs}ms`);
}

/**
 * Log in through the real UI form with a short retry loop — cold Next.js dev
 * compiles of the login route handler can exceed a single wait window.
 *
 * When `nextPath` is given, we sign in and then perform a **hard** `page.goto`
 * to the target. This remounts `AuthProvider`, which re-hydrates identity from
 * `GET /auth/me` — the exact hard-reload path a real user hits. Since #642
 * `/auth/me` returns the `id`-shaped user (matching `/auth/login`), so
 * identity-gated affordances (the reviewer DecisionBar) render after a full
 * reload with no SPA-navigation workaround.
 */
export async function loginViaUi(
  page: Page,
  creds: { username: string; password: string } = REQUESTER,
  nextPath?: string,
): Promise<void> {
  const login = new LoginPage(page);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await login.goto();
      await login.login(creds.username, creds.password);
      if (nextPath) {
        await page.goto(nextPath, { waitUntil: "load" });
      }
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
    }
  }
}
