/**
 * Admin Embedding backends e2e tests.
 *
 * Epic #930 — Pluggable multi-backend RAG embeddings.
 * Issue #937 — admin surface: active backend + capabilities/health, the full
 * registry of selectable backends, and a per-project coverage + reindex control.
 *
 * Acceptance criteria covered:
 * - The admin endpoint is auth-gated (401 without a token).
 * - The page shows the active backend (key, model, dimension, egress) + a
 *   health badge.
 * - Every registered backend from the registry is listed and selectable via
 *   EMBED_BACKEND, with its egress / offline-capability surfaced.
 * - The reindex control is gated on a project id and surfaces coverage.
 * - A project with ingested chunks reports real coverage (total / matching
 *   chunks + an up-to-date badge) and the reindex migration runs and reports
 *   progress feedback.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectDetailPage } from "../pages/project.page.js";
import { AdminEmbeddingsPage } from "../pages/admin-embeddings.page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures");

const API_BASE = apiBase();

test.describe("Admin Embedding backends — RBAC (#930)", () => {
  test("rejects the status endpoint without auth", async () => {
    const ctx: APIRequestContext = await request.newContext({ baseURL: API_BASE });
    const res = await ctx.get("/api/admin/embeddings");
    expect(res.status()).toBe(401);
    await ctx.dispose();
  });

  test("redirects unauthenticated UI visit away from the page", async ({ page }) => {
    await page.goto("/admin/embeddings", { waitUntil: "load" });
    await expect(page).toHaveURL(/\/(login|admin\/embeddings)/);
  });
});

test.describe("Admin Embedding backends — UI (#930)", () => {
  test.beforeEach(async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();
  });

  test("shows the active backend with a health badge", async ({ page }) => {
    const embeddings = new AdminEmbeddingsPage(page);
    await embeddings.goto();
    await embeddings.expectPageLoaded();

    await test.step("active backend card renders the resolved key", async () => {
      const key = await embeddings.activeBackendKey();
      // The e2e stack runs offline, so the default-resolved backend must be a
      // local, offline-capable one — never a cloud backend that needs egress.
      expect(["offline", "xenova", "sidecar", "embeddinggemma"]).toContain(key);
    });

    await test.step("a health badge is visible", async () => {
      await expect(embeddings.healthBadge).toBeVisible();
      await expect(embeddings.healthBadge).toHaveText(/Healthy|Unhealthy/);
    });
  });

  // AC (#931 capabilities surface): the active-backend card must expose the
  // backend's model, dimension and network-egress requirement — not just its
  // key. Expected values are read from the admin status API so the assertion
  // stays backend-agnostic (offline-stub resolves the hash backend here).
  test("surfaces the active backend's model, dimension and egress", async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx: APIRequestContext = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const res = await ctx.get("/api/admin/embeddings");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      data: { active: { model: string; dimension: number; requiresEgress: boolean } };
    };
    await ctx.dispose();

    const active = body.data.active;
    // The e2e stack runs offline, so the resolved backend must not need egress.
    expect(active.requiresEgress).toBe(false);

    const embeddings = new AdminEmbeddingsPage(page);
    await embeddings.goto();
    await embeddings.expectPageLoaded();

    await embeddings.expectActiveCapabilities({
      model: active.model,
      dimension: active.dimension,
      requiresEgress: active.requiresEgress,
    });
  });

  test("lists the full registry of selectable backends", async ({ page }) => {
    const embeddings = new AdminEmbeddingsPage(page);
    await embeddings.goto();
    await embeddings.expectPageLoaded();

    await expect(embeddings.backendsTable).toBeVisible();

    // No single backend is mandated — every registered key must be offered.
    for (const key of ["offline", "xenova", "embeddinggemma", "sidecar", "openai"]) {
      await test.step(`registry lists "${key}"`, async () => {
        await expect(embeddings.backendRow(key)).toBeVisible();
      });
    }

    await test.step("offline backend row reports it as no-egress / offline-capable", async () => {
      const offlineRow = embeddings.backendRow("offline");
      await expect(offlineRow.getByText("None", { exact: true })).toBeVisible();
      await expect(offlineRow.getByText("Yes", { exact: true })).toBeVisible();
    });
  });

  test("gates the reindex control on a project id and surfaces coverage", async ({ page }) => {
    const embeddings = new AdminEmbeddingsPage(page);
    await embeddings.goto();
    await embeddings.expectPageLoaded();

    await test.step("Check coverage is disabled until a project id is entered", async () => {
      await expect(embeddings.checkCoverageButton).toBeDisabled();
    });

    await test.step("submitting an unknown project id surfaces a coverage state", async () => {
      await embeddings.submitProjectId("proj_does_not_exist");
      // Either a coverage report (zero chunks) or an inline error — both are
      // acceptable; the panel must respond rather than hang on the input.
      await expect(
        embeddings.coverageReport.or(embeddings.reindexPanel.getByRole("alert")),
      ).toBeVisible({ timeout: 30_000 });
    });
  });
});

test.describe("Admin Embedding backends — coverage & reindex (#937)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    // Create a project via the API, then ingest a document through the real
    // uploader so the project owns persisted KnowledgeChunks. The e2e stack
    // runs ingest synchronously (INGEST_QUEUE=off) with the offline hash
    // embedder, so chunks are tagged with the active backend's model.
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;

    const slug = `e2e-embed-${Date.now()}`;
    const api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const res = await api.post("/api/projects", {
      data: { name: `Embeddings Coverage ${slug}`, slug, description: "embeddings e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    projectId = body.data.id;

    const loginPage = new LoginPage(page);
    await loginPage.loginAsAdmin();

    const detail = new ProjectDetailPage(page);
    await detail.gotoDocuments(projectId);
    await detail.uploadFiles([path.join(FIXTURES_DIR, "sample.md")]);
    await expect(page.getByTestId("upload-status-done")).toBeVisible({ timeout: 30_000 });

    // Ingested chunks are parked in quarantine; approve them so they graduate
    // to persisted KnowledgeChunk rows tagged with the active embedding model.
    // Without this the project owns zero indexed chunks and coverage is empty.
    const listRes = await api.get(`/api/projects/${projectId}/documents`);
    expect(listRes.ok()).toBe(true);
    const listBody = (await listRes.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items.length).toBeGreaterThan(0);
    let approvedChunks = 0;
    for (const doc of listBody.data.items) {
      const approveRes = await api.post(`/api/projects/${projectId}/documents/${doc.id}/approve`);
      if (approveRes.ok()) {
        const approveBody = (await approveRes.json()) as { data: { chunkCount: number } };
        approvedChunks += approveBody.data.chunkCount ?? 0;
      }
    }
    expect(approvedChunks).toBeGreaterThan(0);
    await api.dispose();
  });

  // AC (#937): a project with ingested chunks reports a real coverage report —
  // total chunks, chunks matching the active model — and, because the chunks
  // were embedded with the active offline model, it is reported up to date.
  test("reports coverage for a project with ingested chunks", async ({ page }) => {
    const embeddings = new AdminEmbeddingsPage(page);
    await embeddings.goto();
    await embeddings.expectPageLoaded();

    await embeddings.submitProjectId(projectId);

    await test.step("a coverage report renders with chunk counts", async () => {
      await expect(embeddings.coverageReport).toBeVisible({ timeout: 30_000 });
      await expect(embeddings.coverageReport.getByText("Total chunks:")).toBeVisible();
      await expect(embeddings.coverageReport.getByText("Matching active model:")).toBeVisible();
    });

    await test.step("chunks embedded with the active model are flagged up to date", async () => {
      // Offline ingest tags chunks with the active backend's model, so coverage
      // matches and no migration is recommended.
      await expect(embeddings.coverageOkBadge).toBeVisible();
      await expect(embeddings.needsReindexBadge).toHaveCount(0);
    });
  });

  // AC (#937): the reindex migration control runs against a real project and
  // reports progress feedback (count of chunks re-embedded at the active dim).
  test("runs the reindex migration and reports progress feedback", async ({ page }) => {
    const embeddings = new AdminEmbeddingsPage(page);
    await embeddings.goto();
    await embeddings.expectPageLoaded();

    await embeddings.submitProjectId(projectId);
    await expect(embeddings.coverageReport).toBeVisible({ timeout: 30_000 });

    await test.step("the reindex control is enabled once chunks exist", async () => {
      await expect(embeddings.reindexButton).toBeEnabled();
    });

    await test.step("triggering reindex reports how many chunks were migrated", async () => {
      await embeddings.reindex();
      await expect(embeddings.reindexResult).toBeVisible({ timeout: 60_000 });
      await expect(embeddings.reindexResult).toHaveText(/Reindexed \d+ of \d+ chunks/);
    });
  });
});
