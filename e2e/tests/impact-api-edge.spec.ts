/**
 * #2115 / #2120 / #2127 — cross-project impact through product API edges, on
 * the real detail page.
 *
 * Acceptance criteria covered:
 *   AC1 — the provider's section names the consumer that calls its API, the
 *         API files the change touched, and the consumer's citing method (#2115).
 *   AC2 — the consumer's card carries the low-confidence banner when a
 *         provider's change left its API untouched (#2115).
 *   AC3 — a failed API-edge read says that part is unavailable, never "no other
 *         project is affected" (#2120).
 *   AC4 — a pending API-edge read says it is checking, never "no other project
 *         is affected", and the answer replaces it once it arrives (#2127).
 *
 * Seeding strategy: an API-edge result needs a product with a declared `api`
 * edge between two indexed repositories and a completed run over both, which
 * the offline e2e stack cannot index. So the spec creates two real projects,
 * then serves the run's detail, its API-edge read and each project's
 * cross-project read as the routes return them, and drives the real page and
 * React rendering. The server side is covered by
 * `server/src/lib/cross-project/api-edge-impact.test.ts` and
 * `server/src/routes/api-edge-impact-route.test.ts`.
 */
import { test, expect, request, type Page, type Route } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ImpactApiEdgePage } from "../pages/impact-api-edge.page.js";

const API_BASE = apiBase();

const json = (data: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

function sym(qualifiedName: string, filePath: string, confidence: number, startLine = 10) {
  return {
    id: `s-${qualifiedName}`,
    codeSymbolId: null,
    filePath,
    qualifiedName,
    startLine,
    endLine: startLine + 20,
    relation: "direct",
    depth: 0,
    confidence,
  };
}

// Two requests of one run: miniflux/v2#2846 (an API change) and #4386 (a web-UI fix).
const API_CHANGE = "Update Entry API takes more fields";
const UI_CHANGE = "Pagination breaks on the unread page";

function item(
  id: string,
  projectId: string,
  requirementTitle: string,
  symbols: ReturnType<typeof sym>[],
) {
  const files = [...new Set(symbols.map((s) => s.filePath))];
  return {
    id,
    projectId,
    requirementId: null,
    requirementTitle,
    changeType: "modified",
    severity: "medium",
    impactScore: 0.6,
    confidence: 0.9,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: files.length,
    affectedSymbolCount: symbols.length,
    summary: null,
    affectedSymbols: symbols,
    affectedTests: [],
    editCandidateFiles: files.map((filePath) => ({ repoConnectionId: null, filePath })),
    blastRadiusFiles: files.map((filePath) => ({ repoConnectionId: null, filePath })),
    writePathGaps: [],
    affectedTables: [],
    affectedTablesSecondary: [],
    droppedColumnProposals: [],
    optionalColumnProposals: [],
    uncheckedColumnProposals: [],
    feedback: [],
  };
}

function detail(id: string, provider: string, consumer: string) {
  const now = new Date().toISOString();
  return {
    id,
    status: "completed",
    documentId: null,
    sourceText: `${API_CHANGE}. ${UI_CHANGE}.`,
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: 5,
    startedAt: now,
    completedAt: now,
    projectIds: [provider, consumer],
    projectOutcomes: [
      { projectId: provider, outcome: "affected" },
      { projectId: consumer, outcome: "affected" },
    ],
    startedById: "u-admin",
    sharedTableImpacts: [],
    rerunOfId: null,
    items: [
      item(`${id}-v2-api`, provider, API_CHANGE, [
        sym("api.(*handler).updateEntry", "internal/api/entry.go", 0.95),
        sym("storage.(*Storage).UpdateEntry", "internal/storage/entry.go", 0.9),
      ]),
      item(`${id}-v2-ui`, provider, UI_CHANGE, [
        sym("ui.(*handler).showUnreadPage", "internal/ui/unread_entries.go", 0.9),
      ]),
      item(`${id}-client-api`, consumer, API_CHANGE, [
        sym("Client::update_entry", "miniflux.py", 0.97, 658),
      ]),
      item(`${id}-client-ui`, consumer, UI_CHANGE, [
        sym("Client::flush_history", "miniflux.py", 0.93, 700),
      ]),
    ],
  };
}

function apiEdgeResult(
  id: string,
  provider: { id: string; name: string },
  consumer: { id: string; name: string },
) {
  return {
    impactAnalysisId: id,
    consumers: [
      {
        edgeId: "e-declared",
        edgeOrigin: "declared",
        edgeStrength: "contract",
        providerProjectId: provider.id,
        providerProjectName: provider.name,
        providerItemId: `${id}-v2-api`,
        changeTitle: API_CHANGE,
        consumerProjectId: consumer.id,
        consumerProjectName: consumer.name,
        apiSurfaceFiles: ["internal/api/entry.go"],
        citingMethods: [
          {
            qualifiedName: "Client::update_entry",
            filePath: "miniflux.py",
            startLine: 658,
            endLine: 685,
            confidence: 0.97,
            source: "run",
          },
        ],
      },
    ],
    // The UI fix matched v2 off its API, so the client's match for it is flagged.
    untouched: [
      {
        consumerItemId: `${id}-client-ui`,
        consumerProjectId: consumer.id,
        providerProjectId: provider.id,
        providerProjectName: provider.name,
        edgeId: "e-declared",
      },
    ],
  };
}

/** Serve one analysis detail, exactly that path; everything else hits the real API. */
async function serveDetail(page: Page, body: ReturnType<typeof detail>): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith(`/api/impact-analyses/${body.id}`),
    (route) => (route.request().method() === "GET" ? route.fulfill(json(body)) : route.fallback()),
  );
}

/** Each project shares no database object: the API edge is the only cross-project reach. */
async function serveNoSharedObjects(page: Page, projectIds: string[]): Promise<void> {
  for (const pid of projectIds) {
    await page.route(
      (url) => url.pathname.endsWith(`/api/impact-analyses/projects/${pid}/cross-project-impact`),
      (route) =>
        route.fulfill(json({ sourceProjectId: pid, workspaceId: "ws-e2e", affectedObjects: [] })),
    );
  }
}

async function serveApiEdge(
  page: Page,
  id: string,
  handler: (route: Route) => Promise<void> | void,
): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith(`/api/impact-analyses/${id}/api-edge-impact`),
    handler,
  );
}

test.describe("Impact result: projects that call this project's API (#2115, #2120, #2127)", () => {
  test.describe.configure({ timeout: 120_000 });
  const stamp = Date.now();
  const provider = { id: "", name: `miniflux v2 ${stamp}` };
  const consumer = { id: "", name: `miniflux python-client ${stamp}` };

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    for (const p of [provider, consumer]) {
      const res = await api.post("/api/projects", {
        data: {
          name: p.name,
          slug: `e2e-api-edge-2127-${p === provider ? "v2" : "client"}-${Date.now()}`,
          description: "#2127 e2e",
        },
      });
      expect(res.status()).toBe(201);
      const created = (await res.json()) as { data?: { id?: string; project?: { id?: string } } };
      p.id = (created.data?.project?.id ?? created.data?.id) as string;
      expect(p.id).toBeTruthy();
    }
    await api.dispose();

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("the provider names the consumer and its citing method; the consumer's card is flagged", async ({
    page,
  }) => {
    const id = `e2e-2127-edge-${Date.now()}`;
    await serveDetail(page, detail(id, provider.id, consumer.id));
    await serveNoSharedObjects(page, [provider.id, consumer.id]);
    await serveApiEdge(page, id, (route) =>
      route.fulfill(json(apiEdgeResult(id, provider, consumer))),
    );
    const pom = new ImpactApiEdgePage(page);
    await pom.goto(id);

    await test.step("the provider's section lists the consumer", async () => {
      await expect(pom.consumerRows(provider.id)).toHaveCount(1, { timeout: 30_000 });
      await expect(pom.consumerRows(provider.id)).toContainText(
        `${consumer.name} calls this project's API (declared, contract API edge)`,
      );
      await expect(pom.apiSurfaceFiles(provider.id)).toHaveText(
        "The change touches its API in internal/api/entry.go",
      );
      await expect(pom.citingMethods(provider.id)).toHaveText(
        "Client::update_entry miniflux.py:658-685 · 97%",
      );
      await expect(pom.noImpact(provider.id)).toHaveCount(0);
    });

    await test.step("the consumer's card for the UI fix carries the low-confidence banner", async () => {
      await expect(pom.untouchedBanner(consumer.id, UI_CHANGE)).toContainText(
        `this project uses ${provider.name} through its API, and this change touches none of that API`,
      );
      // The API change reached the client through the API: its card is not flagged.
      await expect(pom.card(consumer.id, API_CHANGE)).toHaveCount(1);
      await expect(pom.untouchedBanner(consumer.id, API_CHANGE)).toHaveCount(0);
      await expect(pom.untouchedBanner(provider.id, UI_CHANGE)).toHaveCount(0);
      await expect(pom.consumerRows(consumer.id)).toHaveCount(0);
    });
  });

  test("a failed API-edge read says that part is unavailable, not that no project is affected", async ({
    page,
  }) => {
    const id = `e2e-2127-fail-${Date.now()}`;
    await serveDetail(page, detail(id, provider.id, consumer.id));
    await serveNoSharedObjects(page, [provider.id, consumer.id]);
    await serveApiEdge(page, id, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }),
      }),
    );
    const pom = new ImpactApiEdgePage(page);
    await pom.goto(id);
    await expect(pom.apiEdgeUnavailable(provider.id)).toHaveText(
      "Impact on projects that call this project's API is unavailable right now.",
      { timeout: 30_000 },
    );
    await expect(pom.noImpact(provider.id)).toHaveCount(0);
    await expect(pom.noImpact(consumer.id)).toHaveCount(0);
  });

  test("a pending API-edge read says it is checking, then shows the answer", async ({ page }) => {
    const id = `e2e-2127-pending-${Date.now()}`;
    await serveDetail(page, detail(id, provider.id, consumer.id));
    await serveNoSharedObjects(page, [provider.id, consumer.id]);
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = false;
    await serveApiEdge(page, id, async (route) => {
      asked = true;
      await released;
      await route.fulfill(json({ impactAnalysisId: id, consumers: [], untouched: [] }));
    });
    const pom = new ImpactApiEdgePage(page);
    await pom.goto(id);

    await test.step("while the read is pending", async () => {
      await expect(pom.apiEdgeChecking(provider.id)).toHaveText(
        "Checking projects that call this project's API…",
        { timeout: 30_000 },
      );
      expect(asked).toBe(true);
      await expect(pom.noImpact(provider.id)).toHaveCount(0);
      await expect(pom.noImpact(consumer.id)).toHaveCount(0);
    });

    await test.step("once it answers with no consumer", async () => {
      release();
      await expect(pom.noImpact(provider.id)).toBeVisible({ timeout: 30_000 });
      await expect(pom.apiEdgeChecking(provider.id)).toHaveCount(0);
    });
  });
});
