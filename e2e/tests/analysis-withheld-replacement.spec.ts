/**
 * E2E — a path forward when a re-synthesis is withheld (Issue #780).
 *
 * #769 refuses to let a re-synthesis replace requirements that carry review
 * work. The analyst now sees what the withheld result would change and can
 * apply it (after a confirmation naming the reviewed requirements it rewords)
 * or dismiss it.
 *
 * Determinism: the offline-stub AI provider cannot produce a re-synthesis that
 * is withheld, so the analysis snapshot and the withheld-replacement endpoints
 * are stubbed at the route level, as the coverage / requirement-diff suites do.
 * The stubs are stateful: once the analyst answers, the snapshot no longer
 * carries the refusal, as the server's does. Storage, the comparison and what
 * applying does to each requirement are covered against a real database by
 * `server/tests/withheld-replacement-780.sqlite.test.ts`.
 *
 * Acceptance criteria covered (#780)
 *   - Review changes shows a readable comparison by title (added, changed with
 *     before / after, kept because reviewed), with no ids.
 *   - Apply changes asks for confirmation naming the reviewed requirement it
 *     rewords, sends the refusal it answers, and clears the notice.
 *   - Dismiss changes sends the refusal it answers and clears the notice.
 */
import { test, expect, request, type Page, type Request } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { WithheldReplacementPage } from "../pages/withheld-replacement.page.js";

const API_BASE = apiBase();
const ANALYSIS_ID = "an-e2e-780";
const WITHHELD_AT = "2026-10-23T09:00:00.000Z";

const json = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

const WITHHELD = {
  reason: "reviewed-work",
  existingCount: 2,
  reviewedCount: 1,
  proposedCount: 2,
  at: WITHHELD_AT,
  proposalStored: true,
};

function snapshot(projectId: string, withheld: boolean): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: ANALYSIS_ID,
    projectId,
    startedById: "u-admin",
    status: "completed",
    startedAt: now,
    completedAt: now,
    totalTokens: 1000,
    inputTokens: 900,
    outputTokens: 100,
    errorMessage: null,
    metadata: withheld ? { requirementReplacementWithheld: WITHHELD } : {},
    agents: [],
    requirements: [
      {
        id: "r-feeds",
        type: "feature",
        title: "Feed listing",
        body: "Lists the user's feeds.",
        priority: "high",
        labels: [],
        storyPoints: 3,
        reviewStatus: "approved",
        evidenceFindingIds: [],
        coverage: null,
        acceptanceCriteria: ["GET /v1/feeds lists the user's feeds."],
        version: 1,
      },
    ],
    capability: null,
    affectedCode: null,
  };
}

const DIFF = {
  withheld: WITHHELD,
  added: [
    {
      title: "Export feeds as OPML",
      outcome: "add",
      reviewed: false,
      reviewStatus: null,
      changes: [],
      proposed: {
        type: "feature",
        priority: "medium",
        description: "Users can download their feeds as an OPML file.",
        acceptanceCriteria: ["An OPML file downloads."],
      },
    },
  ],
  changed: [
    {
      title: "Feed listing",
      outcome: "update",
      reviewed: true,
      reviewStatus: "approved",
      changes: [
        {
          field: "description",
          before: "Lists the user's feeds.",
          after: "Lists the user's feeds, 100 per page.",
        },
      ],
    },
  ],
  removed: [
    { title: "Dark mode", outcome: "keep", reviewed: true, reviewStatus: null, changes: [] },
  ],
  skipped: [],
  unchangedCount: 0,
};

/** Stub the analysis reads; the snapshot carries the refusal until it is answered. */
async function mockAnalysis(page: Page, projectId: string): Promise<{ answers: Request[] }> {
  const answers: Request[] = [];
  let answered = false;
  await page.route("**/api/analyses/personas", (route) => route.fulfill(json({ items: [] })));
  await page.route("**/api/analyses/cost-cap", (route) =>
    route.fulfill(
      json({
        monthlyCap: 0,
        monthlyUsed: 0,
        monthlyRemaining: 0,
        monthBucket: "2026-10",
        exceeded: false,
      }),
    ),
  );
  await page.route(`**/api/projects/${projectId}/analyses`, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill(
      json({
        items: [
          {
            id: ANALYSIS_ID,
            projectId,
            startedById: "u-admin",
            status: "completed",
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            totalTokens: 1000,
            errorMessage: null,
          },
        ],
      }),
    );
  });
  await page.route(`**/api/analyses/${ANALYSIS_ID}`, (route) =>
    route.fulfill(json(snapshot(projectId, !answered))),
  );
  await page.route(`**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/approvals`, (route) =>
    route.fulfill(
      json({ items: [], ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 } }),
    ),
  );
  await page.route(
    `**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/withheld-replacement`,
    (route) => route.fulfill(json(DIFF)),
  );
  await page.route(
    `**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/withheld-replacement/*`,
    (route) => {
      answers.push(route.request());
      answered = true;
      return route.fulfill(
        json(
          route.request().url().endsWith("/apply")
            ? { added: 1, replaced: 0, updated: 1, deleted: 0, kept: 1 }
            : { discarded: 2 },
        ),
      );
    },
  );
  return { answers };
}

test.describe("Withheld re-synthesis: review, apply or dismiss (#780)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-withheld-780-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Withheld 780 ${slug}`, slug, description: "#780 e2e" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as { data?: { id?: string }; id?: string };
    projectId = (body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await ctx.dispose();

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login("admin", "password");
  });

  test("see the changes, then apply them after confirming", async ({ page }) => {
    const { answers } = await mockAnalysis(page, projectId);
    const pom = new WithheldReplacementPage(page);
    await pom.goto(projectId);

    await test.step("the notice says why and offers a way forward", async () => {
      await expect(pom.notice).toContainText(/1 of them carries review work/);
      await expect(pom.reviewButton).toBeVisible();
    });

    await test.step("Review changes shows what would change, by title", async () => {
      await pom.reviewChanges();
      await expect(pom.comparison).toContainText(
        "Applying would add 1 requirement, change 1, remove 0.",
      );
      await expect(pom.section("New requirements")).toContainText("Export feeds as OPML");
      const changed = pom.section("Changed requirements");
      await expect(changed).toContainText("Feed listing");
      await expect(changed).toContainText("Approved");
      await expect(changed).toContainText("Lists the user's feeds, 100 per page.");
      await expect(changed).toContainText(/new version you can restore from History/);
      await expect(pom.section("Not in the new result")).toContainText(
        /Dark mode.*Kept, because it has review work/,
      );
      await expect(pom.comparison).not.toContainText(ANALYSIS_ID);
    });

    await test.step("Apply asks first, naming the reviewed requirement it rewords", async () => {
      await pom.applyButton.click();
      await expect(pom.confirmDialog).toBeVisible();
      await expect(pom.confirmDialog).toContainText("Nothing with review work is deleted.");
      await expect(pom.confirmDialog.getByRole("listitem")).toHaveText("Feed listing (Approved)");
      expect(answers).toHaveLength(0);
      await pom.confirmApplyButton.click();
    });

    await test.step("the answer names the refusal it applies, and the notice clears", async () => {
      await expect(pom.notice).toBeHidden();
      expect(answers).toHaveLength(1);
      expect(answers[0]!.url()).toMatch(/\/withheld-replacement\/apply$/);
      expect(answers[0]!.postDataJSON()).toEqual({ at: WITHHELD_AT });
      await expect(
        page.getByText(/Applied the new requirements: 1 added, 1 changed/),
      ).toBeVisible();
    });
  });

  test("dismiss keeps the current requirements", async ({ page }) => {
    const { answers } = await mockAnalysis(page, projectId);
    const pom = new WithheldReplacementPage(page);
    await pom.goto(projectId);

    await expect(pom.dismissButton).toBeVisible();
    await pom.dismissButton.click();

    await expect(pom.notice).toBeHidden();
    expect(answers).toHaveLength(1);
    expect(answers[0]!.url()).toMatch(/\/withheld-replacement\/dismiss$/);
    expect(answers[0]!.postDataJSON()).toEqual({ at: WITHHELD_AT });
    await expect(page.getByText("Kept your current requirements.", { exact: false })).toBeVisible();
    await expect(page.getByText("Feed listing", { exact: true }).first()).toBeVisible();
  });
});
