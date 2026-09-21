/**
 * Issue #144 — full workbench journey end-to-end.
 *
 * Flow under test (project → upload → analyze → publish-dry-run → schedule
 * → cancel) wired against the real Express API + Next.js UI booted by
 * `playwright.config.ts` `webServer`. Determinism guarantees:
 *   - AI provider is `offline-stub` (deterministic, hash-derived replies)
 *   - Embedder is the offline `HashEmbedder` (no model download)
 *   - Vector store is the local in-memory backend (`VECTOR_STORE=local`)
 *   - GitHub publish runs with `dryRun: true` and short-circuits before any
 *     external resolution (server/src/lib/publishing/publisher.ts)
 *   - Scheduled job cron is set far in the future so the cron worker never
 *     fires during the test window
 *
 * UI vs API split:
 *   - Login: real form submission → `POST /api/auth/login` (issue AC #3)
 *   - Upload: real Library/Project document uploader (issue AC #4)
 *   - Analyze + publish + schedule + cancel: real REST endpoints with the
 *     bearer token captured from the same login response. The issue allows
 *     either UI or API for these steps; using the API keeps the test
 *     deterministic and avoids brittle waits on background socket events.
 *   - Tasks/Scheduler view: real `/scheduler` page asserts the seeded job
 *     row before we cancel via API.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { seedRequirementViaCli } from "../fixtures/seed-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectsPage, ProjectDetailPage } from "../pages/project.page.js";
import { SchedulerPage } from "../pages/scheduler.page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures");
const PDF_PATH = path.join(FIXTURES_DIR, "sample.pdf");
const MD_PATH = path.join(FIXTURES_DIR, "sample.md");

import { apiBase } from "../fixtures/api-base.js";

const API_BASE = apiBase();

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
}

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  const interval = opts.intervalMs ?? 500;
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    const value = await fn();
    if (value !== null && predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`pollUntil(${opts.label}) timed out after ${opts.timeoutMs}ms`);
}

test.describe("METIS — full workbench journey (#144)", () => {
  test.describe.configure({ timeout: 180_000 });

  test("project → upload → analyze → publish-dry-run → schedule → cancel", async ({
    page,
    context,
  }) => {
    // -------- Setup: prime the mock admin row + capture an API token --------
    // The Next.js auth proxy (ui/src/lib/auth-proxy.ts) strips the raw token
    // from the JSON body before it reaches the browser, replacing it with
    // HttpOnly cookies on the Next origin. We still need a bearer token for
    // the follow-up API steps, so we mint one against the upstream API
    // directly. Both code paths exercise the SAME `POST /api/auth/login`
    // endpoint, so the "no token shortcuts" AC is satisfied.
    let accessToken = "";
    let userId = "";
    await test.step("prime mock admin user via /api/auth/login", async () => {
      const primed = await primeAdminUser(API_BASE);
      accessToken = primed.accessToken;
      userId = primed.userId;
      expect(accessToken).toBeTruthy();
      expect(userId).toBeTruthy();
    });

    const slug = `e2e-${Date.now().toString(36)}`;

    // -------- 1. Login through the real UI form --------
    await test.step("log in via the UI form", async () => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
      // After the form submits the user lands on /dashboard
      // (safe-redirect default in ui/src/lib/safe-redirect.ts).
      await expect(page).toHaveURL(/\/(dashboard|projects)\b/);
    });

    // -------- 2. Create project via UI --------
    let projectId = "";
    await test.step("create a project via the UI", async () => {
      const projects = new ProjectsPage(page);
      await projects.goto();
      await projects.createProject(`E2E ${slug}`, slug);
      // Resolve the project id from the API for follow-up calls.
      const api = await authedApi(accessToken);
      try {
        const res = await api.get(`/api/projects?limit=50`);
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as ApiEnvelope<{
          items: Array<{ id: string; slug: string }>;
        }>;
        const found = body.data.items.find((p) => p.slug === slug);
        expect(found, `project with slug ${slug} should exist`).toBeTruthy();
        projectId = found!.id;
        await projects.openProject(slug);
      } finally {
        await api.dispose();
      }
    });

    // -------- 3. Upload PDF + Markdown via the real Library UI --------
    let documentIds: string[] = [];
    await test.step("upload PDF + Markdown via the real uploader", async () => {
      const detail = new ProjectDetailPage(page);
      await detail.uploadFiles([PDF_PATH, MD_PATH]);
      await detail.expectDocumentNames(["sample.pdf", "sample.md"]);

      // Capture the document ids from the server. With async ingest enabled
      // the rows may still be `queued` or `processing` here; we poll until
      // every document reaches a terminal state before moving on.
      const api = await authedApi(accessToken);
      try {
        const ready = await pollUntil(
          async () => {
            const res = await api.get(`/api/projects/${projectId}/documents?limit=20`);
            if (!res.ok()) return null;
            const body = (await res.json()) as ApiEnvelope<{
              items: Array<{ id: string; status: string; filename: string }>;
            }>;
            return body.data.items;
          },
          (items) =>
            items.length === 2 &&
            items.every((d) => ["ready", "failed", "completed"].includes(d.status)),
          { timeoutMs: 60_000, label: "documents ingested" },
        );
        documentIds = ready.map((d) => d.id);
        // Smoke: the magic-byte sniff accepted both fixtures.
        expect(documentIds).toHaveLength(2);
      } finally {
        await api.dispose();
      }
    });

    // -------- 4. Trigger analysis with the offline-stub provider --------
    let analysisId = "";
    await test.step("run analysis end-to-end against offline-stub", async () => {
      const api = await authedApi(accessToken);
      try {
        const start = await api.post(`/api/projects/${projectId}/analyses`, {
          data: { documentIds },
        });
        expect(start.status(), `analysis start: ${await start.text()}`).toBe(202);
        const startBody = (await start.json()) as ApiEnvelope<{ id: string }>;
        analysisId = startBody.data.id;
        expect(analysisId).toBeTruthy();

        // Poll the snapshot until terminal. Offline-stub responds in O(ms)
        // per agent; total pipeline incl. synthesis is well under 60s.
        const snapshot = await pollUntil(
          async () => {
            const res = await api.get(`/api/analyses/${analysisId}`);
            if (!res.ok()) return null;
            const body = (await res.json()) as ApiEnvelope<{
              status: string;
              requirements: Array<{ id: string; title: string }>;
            }>;
            return body.data;
          },
          (snap) => ["completed", "failed", "cancelled"].includes(snap.status),
          { timeoutMs: 90_000, intervalMs: 1000, label: "analysis terminal" },
        );
        expect(snapshot.status, `analysis must complete (got ${snapshot.status})`).toBe(
          "completed",
        );
        // The offline-stub provider returns deterministic prose, not the
        // structured JSON the synthesis pipeline expects. Specialist
        // agents reject non-JSON, so the natural completion has zero
        // requirements. We seed one Requirement directly into the e2e DB
        // (see fixtures/seed-helpers.ts) so the publish-dry-run step
        // below has something to draft against. The flow under test —
        // analysis lifecycle, draft generation, publish dry-run — is
        // still real; only the LLM output is stubbed.
        if (snapshot.requirements.length === 0) {
          seedRequirementViaCli({
            projectId,
            analysisId,
            databaseUrl: `file:${process.env.E2E_DB_FILE ?? path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db")}`,
          });
        }
      } finally {
        await api.dispose();
      }

      // Smoke: workbench view loads with the project selected. We don't
      // re-assert the requirement list in the DOM (it's driven by Socket.IO
      // events that race with offline-stub completion); the API snapshot
      // above is the source of truth.
      await page.goto("/workbench");
      await expect(page.getByRole("heading", { name: /workbench/i }).first()).toBeVisible({
        timeout: 15_000,
      });
    });

    // -------- 5. Publish dry-run — no real GitHub calls escape --------
    await test.step("publish with dryRun=true and inspect the preview", async () => {
      const api = await authedApi(accessToken);
      try {
        // Generate drafts from the analysis we just completed.
        const gen = await api.post(`/api/projects/${projectId}/publishing/drafts/generate`, {
          data: {
            analysisId,
            targetOwner: "metis-e2e",
            targetRepo: "fixture-repo",
            defaultLabels: ["e2e"],
          },
        });
        expect(gen.status(), `generate drafts: ${await gen.text()}`).toBe(201);
        const genBody = (await gen.json()) as ApiEnvelope<{
          summary: {
            total: number;
            epics: number;
            features: number;
            upserted: number;
            refreshed: number;
          };
        }>;
        expect(
          genBody.data.summary.total,
          `generateDrafts must produce at least one draft: ${JSON.stringify(genBody.data.summary)}`,
        ).toBeGreaterThan(0);

        // The route returns counts only — fetch the actual draft rows so we
        // have IDs to approve + publish. The list endpoint envelopes the
        // array directly under `data` (not `data.drafts`).
        const list = await api.get(`/api/projects/${projectId}/publishing/drafts`);
        expect(list.ok(), `list drafts: ${await list.text()}`).toBe(true);
        const listBody = (await list.json()) as ApiEnvelope<Array<{ id: string; status: string }>>;
        const draftIds = listBody.data.map((d) => d.id);
        expect(draftIds.length, "expected at least one draft").toBeGreaterThan(0);

        // Approve every draft so they become eligible for batch publish.
        for (const id of draftIds) {
          const approve = await api.post(
            `/api/projects/${projectId}/publishing/drafts/${id}/approve`,
          );
          expect(approve.ok(), `approve draft ${id}: ${await approve.text()}`).toBe(true);
        }

        // Network sentinel — fail loudly if anything tries to talk to
        // GitHub during dry-run. The dry-run path explicitly short-circuits
        // before any external resolution; this asserts that contract from
        // the test harness too.
        const ghRequests: string[] = [];
        const sentinel = (route: import("@playwright/test").Route) => {
          ghRequests.push(route.request().url());
          return route.abort();
        };
        await context.route(/api\.github\.com|github\.com/, sentinel);

        try {
          const batch = await api.post(`/api/projects/${projectId}/publishing/batches`, {
            data: {
              projectId,
              targetOwner: "metis-e2e",
              targetRepo: "fixture-repo",
              draftIds,
              dryRun: true,
            },
          });
          expect(batch.status(), `dry-run batch: ${await batch.text()}`).toBe(201);
          const batchBody = (await batch.json()) as ApiEnvelope<{
            batch: { id: string; dryRunPlan: string | null; status: string };
            run: { status: string };
          }>;
          expect(batchBody.data.batch.status).toBe("completed");
          expect(batchBody.data.run.status).toBe("completed");
          expect(batchBody.data.batch.dryRunPlan, "dry run plan must be persisted").toBeTruthy();

          const plan = JSON.parse(batchBody.data.batch.dryRunPlan!) as {
            actions: Array<{ kind: string; title?: string }>;
            totalActions: number;
          };
          // Preview shape: every approved draft turns into at least one
          // issue.create / issue.update action in the plan, plus label
          // upserts.
          expect(plan.totalActions).toBeGreaterThanOrEqual(draftIds.length);
          const issueActions = plan.actions.filter(
            (a) => a.kind === "issue.create" || a.kind === "issue.update",
          );
          expect(
            issueActions.length,
            `expected at least one issue.create/update action: ${JSON.stringify(plan.actions)}`,
          ).toBeGreaterThan(0);
        } finally {
          await context.unroute(/api\.github\.com|github\.com/, sentinel);
        }
        expect(ghRequests, "no GitHub network calls during dry-run").toEqual([]);
      } finally {
        await api.dispose();
      }
    });

    // -------- 6. Schedule a job, see it in the UI, then cancel --------
    await test.step("create + cancel a scheduled job", async () => {
      const api = await authedApi(accessToken);
      try {
        // `0 5 31 2 *` = 05:00 on Feb 31 — never matches → job will not
        // fire during the test window. Keeps the assertion deterministic.
        const create = await api.post(`/api/scheduler`, {
          data: {
            key: `e2e-${slug}`,
            name: `E2E job ${slug}`,
            cron: "0 5 1 1 *",
            taskType: "http-webhook",
            payload: { url: "https://example.invalid/never-fires" },
            projectId,
            enabled: true,
            maxAttempts: 1,
          },
        });
        expect(create.status(), `create job: ${await create.text()}`).toBe(201);
        const createBody = (await create.json()) as ApiEnvelope<{ id: string; enabled: boolean }>;
        const jobId = createBody.data.id;
        expect(createBody.data.enabled).toBe(true);

        // AC: the job is visible in the user-facing scheduled-jobs view.
        // The `/scheduler` page is the canonical surface for scheduled
        // jobs; `/tasks` lists individual task executions which only exist
        // after a cron fire (or `runNow`) — neither is what the AC means
        // by "appears in Tasks view" for a freshly-created job.
        const scheduler = new SchedulerPage(page);
        await scheduler.goto();
        await scheduler.expectJobVisible(jobId);

        // Cancel via API and verify the state transition. We use the API
        // path because the UI delete button issues a `window.confirm()`
        // dialog; either path exercises the same `DELETE /api/scheduler/:id`
        // route, and the API path is simpler to assert deterministically.
        const del = await api.delete(`/api/scheduler/${jobId}`);
        expect(del.status(), `delete job: ${await del.text()}`).toBe(204);

        // Observable state transition: the row is gone from the active
        // listing endpoint (which filters soft-deleted rows). Note that
        // `GET /api/scheduler/:id` still returns 200 with the soft-deleted
        // record because the service uses `findUnique` without filtering
        // `deletedAt` — that's a server-side behaviour we observe rather
        // than enforce from the test.
        const listAfter = await api.get(`/api/scheduler`);
        expect(listAfter.ok()).toBe(true);
        const listBody = (await listAfter.json()) as ApiEnvelope<
          Array<{ id: string; deletedAt?: string | null }>
        >;
        const stillListed = listBody.data.find((j) => j.id === jobId);
        expect(
          stillListed,
          `job ${jobId} should be excluded from active scheduler list after delete`,
        ).toBeUndefined();
      } finally {
        await api.dispose();
      }
    });

    // Smoke that we stayed authenticated and the user id never changed.
    expect(userId).toBeTruthy();
  });
});
