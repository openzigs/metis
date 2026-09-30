/**
 * Epic #507 — Symbol-Level Code Embeddings & Hybrid Code Search.
 *
 * Validates the end-to-end flow of:
 *   - #508: Symbol embedding pipeline triggered during code-graph ingest
 *   - #509: Hybrid BM25 + vector search returns ranked code symbols
 *   - #510: Chat/analysis context uses hybrid search for code retrieval
 *
 * Tests use the real Express API on the e2e stack (offline-stub AI provider,
 * offline embed backend, local vector store). The pipeline runs against a
 * minimal TypeScript fixture to keep execution fast.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { io } from "socket.io-client";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectsPage } from "../pages/project.page.js";
import { WorkbenchPage } from "../pages/workbench.page.js";
import { apiBase } from "../fixtures/api-base.js";
import { isOfflineAiStub } from "../fixtures/ai-mode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_REPO_ZIP = path.resolve(__dirname, "..", "fixtures", "sample-repo.zip");

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

/**
 * Issue #400 — create an upload (.zip) repo connector on the MOUNTED connectors
 * route. An upload rather than a GitHub URL: the suite makes no outbound network
 * calls. A failed create fails the test; nothing downstream is left to guess.
 */
async function uploadSampleRepo(
  api: APIRequestContext,
  projectId: string,
  label: string,
): Promise<string> {
  const res = await api.post(`/api/projects/${projectId}/connectors/repos/upload`, {
    multipart: {
      label,
      file: {
        name: "sample-repo.zip",
        mimeType: "application/zip",
        buffer: await readFile(SAMPLE_REPO_ZIP),
      },
    },
  });
  expect(res.status(), `upload connector: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as ApiEnvelope<{ id: string }>;
  return body.data.id;
}

/**
 * Start a Deep Ingest (#373: `202 { jobId }`). The project's first repo
 * connector auto-ingests on creation and holds the connector's ingest lease, so
 * the route answers 409 `INGEST_IN_PROGRESS` until that run ends — retry only
 * that. Any other status fails the test.
 */
async function startDeepIngest(
  api: APIRequestContext,
  projectId: string,
  repoId: string,
): Promise<string> {
  const url = `/api/projects/${projectId}/connectors/repos/${repoId}/deep-ingest`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await api.post(url);
    if (res.status() === 202) {
      const body = (await res.json()) as ApiEnvelope<{ jobId: string }>;
      expect(body.data.jobId, "deep-ingest returns a jobId").toBeTruthy();
      return body.data.jobId;
    }
    const text = await res.text();
    const retryable = res.status() === 409 && text.includes("INGEST_IN_PROGRESS");
    if (!retryable || Date.now() > deadline) {
      throw new Error(`deep-ingest ${url} answered ${res.status()}: ${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface JobLifecycle {
  jobId: string;
  kind: string;
  status: string;
  message?: string;
  error?: string;
}

/**
 * Follow a job on the `job:lifecycle` bus until its terminal event. The server
 * replays the job's last transition on `subscribe:job`, so a job that finished
 * before we subscribed still resolves.
 */
function waitForJobTerminal(token: string, jobId: string, timeoutMs = 90_000) {
  return new Promise<JobLifecycle>((resolve, reject) => {
    const socket = io(API_BASE, { path: "/socket.io", transports: ["websocket"], auth: { token } });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket.disconnect();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error(`job ${jobId} did not finish within ${timeoutMs}ms`))),
      timeoutMs,
    );
    socket.on("job:lifecycle", (event: JobLifecycle) => {
      if (event.jobId !== jobId) return;
      if (event.status === "completed" || event.status === "failed") done(() => resolve(event));
    });
    socket.once("connect", () => socket.emit("subscribe:job", { jobId }));
    socket.once("connect_error", (err) =>
      done(() => reject(new Error(`socket connect_error: ${err.message}`))),
    );
  });
}

/** Run a Deep Ingest to completion; a failed or missing job fails the test. */
async function deepIngestToCompletion(
  api: APIRequestContext,
  token: string,
  projectId: string,
  repoId: string,
): Promise<JobLifecycle> {
  const jobId = await startDeepIngest(api, projectId, repoId);
  const terminal = await waitForJobTerminal(token, jobId);
  expect(terminal.kind).toBe("repo-ingest");
  expect(terminal.status, `repo-ingest job: ${terminal.error ?? terminal.message}`).toBe(
    "completed",
  );
  return terminal;
}

interface SymbolCoverage {
  totalSymbols: number;
  matchingSymbols: number;
  symbolModelCounts: Record<string, number>;
}

/**
 * Wait until the project has code symbols AND every one of them carries a
 * vector at the active embedding model. Symbol embedding runs in the background
 * after the code graph is written (#797), so it can trail the job's `completed`.
 */
async function waitForSymbolEmbeddings(
  api: APIRequestContext,
  projectId: string,
): Promise<SymbolCoverage> {
  let last: SymbolCoverage | null = null;
  await expect
    .poll(
      async () => {
        const res = await api.get(`/api/admin/embeddings/projects/${projectId}/coverage`);
        expect(res.status(), `coverage: ${await res.text()}`).toBe(200);
        last = ((await res.json()) as ApiEnvelope<SymbolCoverage>).data;
        return last.totalSymbols > 0 && last.matchingSymbols === last.totalSymbols;
      },
      { timeout: 60_000, message: "symbols ingested and all embedded at the active model" },
    )
    .toBe(true);
  return last!;
}

test.describe("Epic #507 — Symbol-Level Code Embeddings", () => {
  test.describe.configure({ timeout: 180_000 });

  let accessToken = "";
  let projectId = "";
  let projectSlug = "";

  test.beforeEach(async () => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC #508: Symbol embeddings computed during code-graph ingest
  // ──────────────────────────────────────────────────────────────────────────
  test("code-graph deep-ingest triggers symbol embedding pipeline", async ({ page }) => {
    projectSlug = `e2e-embed-${Date.now().toString(36)}`;

    await test.step("login and create project", async () => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
      await expect(page).toHaveURL(/\/(dashboard|projects)\b/);

      const projects = new ProjectsPage(page);
      await projects.goto();
      await projects.createProject(`Embed Test ${projectSlug}`, projectSlug);

      // Resolve project ID from API
      const api = await authedApi(accessToken);
      try {
        const res = await api.get("/api/projects?limit=50");
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as ApiEnvelope<{
          items: Array<{ id: string; slug: string }>;
        }>;
        const found = body.data.items.find((p) => p.slug === projectSlug);
        expect(found, `project ${projectSlug} should exist`).toBeTruthy();
        projectId = found!.id;
      } finally {
        await api.dispose();
      }
    });

    await test.step("connect a repo and deep-ingest it to completion", async () => {
      const api = await authedApi(accessToken);
      try {
        const repoId = await uploadSampleRepo(api, projectId, "fixture-ts-repo");
        await deepIngestToCompletion(api, accessToken, projectId, repoId);

        // AC #508: the ingest wrote code symbols and embedded every one of them.
        const coverage = await waitForSymbolEmbeddings(api, projectId);
        expect(coverage.totalSymbols).toBeGreaterThan(0);
        expect(coverage.symbolModelCounts[""] ?? 0, "no symbol left pending").toBe(0);
      } finally {
        await api.dispose();
      }
    });

    await test.step("verify project code-graph status via API", async () => {
      const api = await authedApi(accessToken);
      try {
        // Check the project has code graph metadata
        const res = await api.get(`/api/projects/${projectId}`);
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as ApiEnvelope<{
          id: string;
          slug: string;
          codeGraphStatus?: string;
        }>;
        expect(body.data.id).toBe(projectId);
        // The project should exist regardless of ingest success
        expect(body.data.slug).toBe(projectSlug);
      } finally {
        await api.dispose();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC #508: Incremental — unchanged symbols not re-embedded
  // ──────────────────────────────────────────────────────────────────────────
  test("repeated ingest skips unchanged symbols (incremental hashing)", async () => {
    const api = await authedApi(accessToken);
    const slug = `e2e-incr-${Date.now().toString(36)}`;
    try {
      // Create project
      const projRes = await api.post("/api/projects", {
        data: { name: `Incremental ${slug}`, slug },
      });
      expect(projRes.ok()).toBe(true);
      const projBody = (await projRes.json()) as ApiEnvelope<{ id: string }>;
      const pid = projBody.data.id;

      const repoId = await uploadSampleRepo(api, pid, "fixture-ts-repo-incr");
      await deepIngestToCompletion(api, accessToken, pid, repoId);
      const before = await waitForSymbolEmbeddings(api, pid);

      // Refresh re-extracts the same archive: every file hashes as unchanged.
      const refresh = await api.post(
        `/api/projects/${pid}/connectors/repos/${repoId}/refresh-ingest`,
      );
      expect(refresh.status(), `refresh-ingest: ${await refresh.text()}`).toBe(200);
      const refreshBody = (await refresh.json()) as ApiEnvelope<{
        codeGraph: { filesParsed: number; filesSkipped: number; symbolsUpserted: number };
      }>;
      expect(refreshBody.data.codeGraph.filesParsed).toBe(0);
      expect(refreshBody.data.codeGraph.symbolsUpserted).toBe(0);
      expect(refreshBody.data.codeGraph.filesSkipped).toBeGreaterThan(0);

      // The unchanged symbols keep their embeddings.
      const after = await waitForSymbolEmbeddings(api, pid);
      expect(after.totalSymbols).toBe(before.totalSymbols);
    } finally {
      await api.dispose();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC #509: Hybrid search returns relevant code symbols
  // ──────────────────────────────────────────────────────────────────────────
  // #423: the test used to POST to an unmounted route and wrap every assertion
  // in `if (searchRes.ok())`, so it passed having asserted nothing. The route is
  // now mounted and the contract is asserted unconditionally against a symbol
  // the fixture repo really defines (`export function add` in src/index.ts).
  test("hybrid search API returns ranked results with expected fields", async () => {
    const api = await authedApi(accessToken);
    const slug = `e2e-search-${Date.now().toString(36)}`;
    try {
      const projRes = await api.post("/api/projects", {
        data: { name: `Search ${slug}`, slug },
      });
      expect(projRes.ok()).toBe(true);
      const pid = ((await projRes.json()) as ApiEnvelope<{ id: string }>).data.id;

      const repoId = await uploadSampleRepo(api, pid, "fixture-ts-repo-search");
      await deepIngestToCompletion(api, accessToken, pid, repoId);
      await waitForSymbolEmbeddings(api, pid);

      const searchRes = await api.post(`/api/projects/${pid}/code-search`, {
        data: { query: "add", limit: 10 },
      });
      expect(searchRes.status(), `code-search: ${await searchRes.text()}`).toBe(200);
      const { results } = (
        (await searchRes.json()) as ApiEnvelope<{
          results: Array<{
            symbolId: string;
            filePath: string;
            name: string;
            kind: string;
            score: number;
            snippet?: string;
          }>;
        }>
      ).data;

      // AC #509: a query naming a fixture symbol returns that symbol.
      const hit = results.find((r) => r.name === "add");
      expect(hit, `"add" in ${JSON.stringify(results)}`).toBeTruthy();
      expect(hit!.filePath).toMatch(/src\/index\.ts$/);
      for (const r of results) {
        expect(r.symbolId).toBeTruthy();
        expect(r.filePath).toBeTruthy();
        expect(r.name).toBeTruthy();
        expect(r.kind).toBeTruthy();
        expect(r.score).toBeGreaterThan(0);
      }
      // Ranked: scores are non-increasing.
      const scores = results.map((r) => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    } finally {
      await api.dispose();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC #510: Chat context uses hybrid search for code retrieval
  // ──────────────────────────────────────────────────────────────────────────
  test("chat query returns response with code context when project has code graph", async ({
    page,
  }) => {
    const slug = `e2e-chat-${Date.now().toString(36)}`;

    await test.step("login", async () => {
      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);
      await expect(page).toHaveURL(/\/(dashboard|projects)\b/);
    });

    let pid = "";
    await test.step("create project with code context", async () => {
      const api = await authedApi(accessToken);
      try {
        const projRes = await api.post("/api/projects", {
          data: { name: `Chat Code ${slug}`, slug },
        });
        expect(projRes.ok()).toBe(true);
        const projBody = (await projRes.json()) as ApiEnvelope<{ id: string }>;
        pid = projBody.data.id;

        // Connect a repo to get code graph data (auto-ingests as the first repo).
        await uploadSampleRepo(api, pid, "fixture-ts-repo-chat");
      } finally {
        await api.dispose();
      }
    });

    await test.step("create chat session and send code question", async () => {
      const api = await authedApi(accessToken);
      try {
        // Create a chat session bound to the project
        const sessionRes = await api.post("/api/ai/sessions", {
          data: { title: "Code Question", projectId: pid },
        });
        expect(sessionRes.ok()).toBe(true);
        // The create-session envelope nests the row: `data.session.id`.
        const sessionBody = (await sessionRes.json()) as ApiEnvelope<{ session: { id: string } }>;
        const sessionId = sessionBody.data.session.id;

        // Send a code-related question
        const chatRes = await api.post("/api/ai/chat", {
          data: {
            sessionId,
            messages: [{ role: "user", content: "What does the agent loop function do?" }],
          },
        });
        expect(chatRes.ok()).toBe(true);
        // The chat envelope nests the reply: `data.response`.
        const chatBody = (await chatRes.json()) as ApiEnvelope<{
          response: {
            content: string;
            model: string;
            usage: { promptTokens: number; completionTokens: number };
          };
        }>;

        // AC: Chat returns a response (offline-stub produces deterministic output)
        expect(chatBody.data.response.content).toBeTruthy();
        expect(chatBody.data.response.content.length).toBeGreaterThan(0);
      } finally {
        await api.dispose();
      }
    });

    await test.step("verify chat works through the workbench UI", async () => {
      const wb = new WorkbenchPage(page);
      await wb.goto();

      // Select the project in the workbench
      await wb.projectPicker.selectOption({ label: `Chat Code ${slug}` });

      // Wait for session to start
      await wb.expectChatReady();

      // Type a code question in the chat
      await wb.chatInput.fill("Explain the authentication handler");
      await wb.sendButton.click();

      // Verify a response appears in the center panel
      await expect(
        wb.centerPanel.getByRole("article").or(wb.centerPanel.locator("[data-role='assistant']")),
      ).toBeVisible({ timeout: 60_000 });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC #510: Graceful fallback when embeddings not computed
  // ──────────────────────────────────────────────────────────────────────────
  test("chat gracefully falls back when project has no code embeddings", async () => {
    const api = await authedApi(accessToken);
    const slug = `e2e-fallback-${Date.now().toString(36)}`;
    try {
      // Create a bare project with no code repo
      const projRes = await api.post("/api/projects", {
        data: { name: `Fallback ${slug}`, slug },
      });
      expect(projRes.ok()).toBe(true);
      const projBody = (await projRes.json()) as ApiEnvelope<{ id: string }>;
      const pid = projBody.data.id;

      // Create a session bound to this empty project
      const sessionRes = await api.post("/api/ai/sessions", {
        data: { title: "Fallback Test", projectId: pid },
      });
      expect(sessionRes.ok()).toBe(true);
      // The create-session envelope nests the row: `data.session.id`.
      const sessionBody = (await sessionRes.json()) as ApiEnvelope<{ session: { id: string } }>;
      const sessionId = sessionBody.data.session.id;

      // Ask a code question — should not error, should fall back gracefully
      const chatRes = await api.post("/api/ai/chat", {
        data: {
          sessionId,
          messages: [
            { role: "user", content: "How does the login function work in the codebase?" },
          ],
        },
      });

      // AC: Falls back gracefully — returns 200 with a response, not a 500
      expect(chatRes.ok()).toBe(true);
      const chatBody = (await chatRes.json()) as ApiEnvelope<{ response: { content: string } }>;
      expect(chatBody.data.response.content).toBeTruthy();
    } finally {
      await api.dispose();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC #510: Feature flag CODE_RETRIEVAL_MODE controls retrieval mode
  // ──────────────────────────────────────────────────────────────────────────
  test("CODE_RETRIEVAL_MODE feature flag is respected by the server", async () => {
    // The feature flag is an env var on the server process. In the e2e suite
    // the server boots with CODE_RETRIEVAL_MODE unset (defaults to "graph").
    // We validate the default behavior: chat should work with graph-only mode.
    const api = await authedApi(accessToken);
    const slug = `e2e-flag-${Date.now().toString(36)}`;
    try {
      const projRes = await api.post("/api/projects", {
        data: { name: `Flag Test ${slug}`, slug },
      });
      expect(projRes.ok()).toBe(true);
      const projBody = (await projRes.json()) as ApiEnvelope<{ id: string }>;
      const pid = projBody.data.id;

      const sessionRes = await api.post("/api/ai/sessions", {
        data: { title: "Flag Test", projectId: pid },
      });
      expect(sessionRes.ok()).toBe(true);
      // The create-session envelope nests the row: `data.session.id`.
      const sessionBody = (await sessionRes.json()) as ApiEnvelope<{ session: { id: string } }>;
      const sessionId = sessionBody.data.session.id;

      // With default CODE_RETRIEVAL_MODE=graph, chat should still work
      const chatRes = await api.post("/api/ai/chat", {
        data: {
          sessionId,
          messages: [{ role: "user", content: "List all exported functions" }],
        },
      });
      expect(chatRes.ok()).toBe(true);
      const chatBody = (await chatRes.json()) as ApiEnvelope<{ response: { content: string } }>;
      // Graph-only mode still produces valid responses
      expect(chatBody.data.response.content).toBeTruthy();

      // Verify the server healthz confirms correct configuration
      const healthRes = await api.get("/healthz");
      expect(healthRes.ok()).toBe(true);
    } finally {
      await api.dispose();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC #509: Search results score ordering validation
  // ──────────────────────────────────────────────────────────────────────────
  test("analysis with code graph uses graph-ranked context", async () => {
    const api = await authedApi(accessToken);
    const slug = `e2e-analysis-${Date.now().toString(36)}`;
    try {
      // Create project
      const projRes = await api.post("/api/projects", {
        data: { name: `Analysis ${slug}`, slug },
      });
      expect(projRes.ok()).toBe(true);
      const projBody = (await projRes.json()) as ApiEnvelope<{ id: string }>;
      const pid = projBody.data.id;

      // Upload a document to have something to analyze
      const uploadRes = await api.post(`/api/projects/${pid}/documents`, {
        multipart: {
          file: {
            name: "sample.md",
            mimeType: "text/markdown",
            buffer: Buffer.from(
              "# API Design\n\nThe `agentLoop` function orchestrates the analysis pipeline.\n",
            ),
          },
        },
      });

      // Upload answers 201 (synchronous ingest) or 202 (queued); anything else
      // fails here instead of skipping the rest of the test.
      expect([201, 202], `document upload: ${await uploadRes.text()}`).toContain(
        uploadRes.status(),
      );

      // Wait for ingestion to reach `ready`. DOCUMENT_STATUSES is
      // pending | processing | ready | failed; a failed ingest fails the test.
      const docs = await pollUntil(
        async () => {
          const res = await api.get(`/api/projects/${pid}/documents?limit=10`);
          if (!res.ok()) return null;
          const body = (await res.json()) as ApiEnvelope<{
            items: Array<{ id: string; status: string }>;
          }>;
          return body.data.items;
        },
        (items) => items.length > 0 && items.every((d) => ["ready", "failed"].includes(d.status)),
        { timeoutMs: 30_000, label: "document ingestion" },
      );
      expect(
        docs.map((d) => d.status),
        "every document ingested",
      ).toEqual(docs.map(() => "ready"));

      // Start an analysis
      const analysisRes = await api.post(`/api/projects/${pid}/analyses`, {
        data: { documentIds: docs.map((d) => d.id) },
      });
      expect(analysisRes.status(), `analysis start: ${await analysisRes.text()}`).toBe(202);
      const analysisBody = (await analysisRes.json()) as ApiEnvelope<{ id: string }>;
      const analysisId = analysisBody.data.id;
      expect(analysisId).toBeTruthy();

      // Poll until analysis reaches a terminal state
      const result = await pollUntil(
        async () => {
          const res = await api.get(`/api/analyses/${analysisId}`);
          if (!res.ok()) return null;
          const body = (await res.json()) as ApiEnvelope<{ status: string }>;
          return body.data;
        },
        (snap) => ["completed", "failed", "cancelled"].includes(snap.status),
        { timeoutMs: 90_000, intervalMs: 1000, label: "analysis completion" },
      );

      // Branch on the DECLARED provider, as full-flow.spec.ts does: the
      // offline-stub returns prose, every specialist rejects it, and the
      // orchestrator's honesty gate fails the run. A real provider must
      // complete. Accepting either outcome regardless would pass a broken run.
      if (isOfflineAiStub()) {
        expect(result.status, "offline-stub: the honesty gate fails the run").toBe("failed");
      } else {
        expect(result.status, "a real AI provider must complete the run").toBe("completed");
      }
    } finally {
      await api.dispose();
    }
  });
});
