/**
 * #1762 — the impact result says why each file to edit was chosen, and says
 * "not found" honestly.
 *
 * Acceptance criteria covered:
 *   AC1 — each edit candidate shows "Found by"; a verified one also shows "Why"
 *         and its code line. An unverified reason is never shown as fact.
 *   AC2 — doubtful candidates are visible and labelled, never removed.
 *   AC3 — "not found" renders when the result has no confident edit candidate.
 *   AC4 — with every lever flag off (no `seedEvidence`), the card is unchanged.
 *
 * Seeding strategy: `seedEvidence` is written only when an off-by-default seed
 * lever ran with a live model (#1754, #1756, #1759, #1798), which the offline
 * e2e stack cannot reproduce. So the spec creates a real project, then serves
 * the analysis detail (`GET /api/impact-analyses/:id`) as the read route
 * returns it, and drives the real page and React rendering.
 */
import { test, expect, request, type Page } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { ImpactEditCandidatesPage } from "../pages/impact-edit-candidates.page.js";

const API_BASE = apiBase();

const NOTIFY = "src/orders/notify-repo.ts";
const MAILER = "src/mail/mailer.ts";
const ORDERS = "src/orders/orders.ts";
const ROUTES = "src/api/routes.ts";
const oneRepoFile = (filePath: string) => ({ repoConnectionId: null, filePath });

const json = (data: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

function sym(id: string, filePath: string, over: Record<string, unknown> = {}) {
  return {
    id,
    codeSymbolId: `cs-${id}`,
    filePath,
    qualifiedName: `${filePath}::${id}`,
    startLine: 10,
    endLine: 20,
    relation: "direct",
    depth: 0,
    confidence: 0.9,
    ...over,
  };
}

const SYMBOLS = [
  sym("o1", ORDERS, { confidence: 1 }),
  sym("n1", NOTIFY, { confidence: 0.7 }),
  sym("m1", MAILER, { confidence: 0.5 }),
  sym("r1", ROUTES, { relation: "caller", depth: 1, confidence: 0.4 }),
];

const EVIDENCE = {
  editCandidates: [
    { filePath: NOTIFY, channels: ["code-agent"] },
    {
      filePath: MAILER,
      channels: ["edit-verifier"],
      baseScore: 0.4,
      verdict: {
        kind: "promoted",
        reason: "Sends the receipt email when an order is paid",
        line: 11,
        verified: true,
      },
    },
    {
      filePath: ORDERS,
      channels: ["hybrid"],
      baseScore: 1,
      verdict: { kind: "doubtful", reason: "Lists orders; sends nothing" },
    },
  ],
};

function detail(id: string, projectId: string, item: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id,
    status: "completed",
    documentId: null,
    sourceText: "Send a receipt when an order is paid",
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: 4,
    startedAt: now,
    completedAt: now,
    projectIds: [projectId],
    projectOutcomes: [{ projectId, outcome: "affected" }],
    startedById: "u-admin",
    sharedTableImpacts: [],
    rerunOfId: null,
    items: [
      {
        id: `${id}-item`,
        projectId,
        requirementId: null,
        requirementTitle: "Send a receipt when an order is paid",
        changeType: "added",
        severity: "medium",
        impactScore: 0.5,
        confidence: 0.7,
        matchQuality: "strong",
        matchQualityReason: null,
        affectedFileCount: 4,
        affectedSymbolCount: 4,
        summary: null,
        affectedSymbols: SYMBOLS,
        affectedTests: [],
        // #1965 — a file is (repository, path); this fixture's project has one repository.
        editCandidateFiles: [ORDERS, NOTIFY, MAILER].map(oneRepoFile),
        blastRadiusFiles: [ORDERS, NOTIFY, MAILER, ROUTES].map(oneRepoFile),
        writePathGaps: [],
        affectedTables: [],
        affectedTablesSecondary: [],
        droppedColumnProposals: [],
        optionalColumnProposals: [],
        uncheckedColumnProposals: [],
        feedback: [],
        ...item,
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

test.describe("Impact result: why each file to edit was chosen (#1762)", () => {
  test.describe.configure({ timeout: 120_000 });
  let projectId: string;
  const projectName = `Shop backend ${Date.now()}`;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-impact-why-1762-${Date.now()}`;
    const res = await api.post("/api/projects", {
      data: { name: projectName, slug, description: "#1762 e2e" },
    });
    expect(res.status()).toBe(201);
    const created = (await res.json()) as { data?: { id?: string; project?: { id?: string } } };
    projectId = (created.data?.project?.id ?? created.data?.id) as string;
    expect(projectId).toBeTruthy();
    await api.dispose();

    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("an analyst sees what found each file, the checked reason and line, and the doubt", async ({
    page,
  }) => {
    const id = `e2e-1762-why-${Date.now()}`;
    await serveDetail(page, detail(id, projectId, { seedEvidence: EVIDENCE }));
    const pom = new ImpactEditCandidatesPage(page);
    await pom.goto(id);
    await expect(pom.files).toHaveCount(3, { timeout: 30_000 });

    await test.step("the files are in the edit order, not by confidence", async () => {
      const paths = await pom.filePaths();
      expect(paths).toEqual([NOTIFY, MAILER, ORDERS]);
    });

    await test.step("Found by names the source in business wording", async () => {
      await expect(pom.foundBy(NOTIFY)).toHaveText("Found by:Code agent");
      await expect(pom.foundBy(MAILER)).toHaveText("Found by:AI edit check");
      await expect(pom.foundBy(ORDERS)).toHaveText("Found by:Keyword and meaning search");
    });

    await test.step("a verified promotion shows Why and its code line", async () => {
      await expect(pom.why(MAILER)).toHaveText("Why:Sends the receipt email when an order is paid");
      await expect(pom.code(MAILER)).toHaveText("Code:mailer.ts:11");
      await expect(pom.why(NOTIFY)).toHaveCount(0);
      await expect(pom.why(ORDERS)).toHaveCount(0);
    });

    await test.step("a doubtful file stays listed, badged, and is not counted", async () => {
      await expect(pom.doubtfulBadge(ORDERS)).toHaveText("Doubtful");
      await expect(pom.file(ORDERS)).toContainText("Lists orders; sends nothing");
      await expect(pom.headline).toContainText("2 files to edit");
      await expect(pom.notFound).toHaveCount(0);
    });
  });

  test('"not found" is said plainly, naming the project, when only doubtful files remain', async ({
    page,
  }) => {
    const id = `e2e-1762-none-${Date.now()}`;
    await serveDetail(
      page,
      detail(id, projectId, {
        affectedSymbols: [sym("o1", ORDERS), SYMBOLS[3]],
        seedEvidence: { editCandidates: [EVIDENCE.editCandidates[2]] },
      }),
    );
    const pom = new ImpactEditCandidatesPage(page);
    await pom.goto(id);
    await expect(pom.notFound).toBeVisible({ timeout: 30_000 });
    await expect(pom.notFound).toContainText(
      `METIS could not find the code this change touches in ${projectName}.`,
    );
    await expect(pom.headline).toContainText("0 files to edit");
    // The doubtful file is still shown, labelled; the blast radius keeps its own heading.
    await expect(pom.doubtfulBadge(ORDERS)).toBeVisible();
    await expect(pom.editCandidates).not.toContainText("most likely has to touch");
    await expect(pom.blastRadius).toBeVisible();
  });

  test("with every lever flag off the card renders as before", async ({ page }) => {
    const id = `e2e-1762-off-${Date.now()}`;
    await serveDetail(page, detail(id, projectId, {}));
    const pom = new ImpactEditCandidatesPage(page);
    await pom.goto(id);
    await expect(pom.files).toHaveCount(3, { timeout: 30_000 });
    // The pre-#1762 order (by confidence), heading and headline; no why panel.
    const paths = await pom.filePaths();
    expect(paths).toEqual([ORDERS, NOTIFY, MAILER]);
    await expect(pom.editCandidates).toContainText(
      "Files to edit — the code this change most likely has to touch",
    );
    await expect(pom.headline).toContainText("3 files to edit");
    await expect(pom.card.getByTestId("edit-candidate-found-by")).toHaveCount(0);
    await expect(pom.card.getByTestId("edit-candidate-doubtful")).toHaveCount(0);
    await expect(pom.notFound).toHaveCount(0);
  });
});
