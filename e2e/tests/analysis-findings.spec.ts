/**
 * E2E — Analysis findings: persona attribution + Deep Dive → Issue
 * (Epic #176, Issues #177 + #180).
 *
 * Layer 1 (#177): each finding card attributes the finding to a *persona*
 * (avatar + name + role, e.g. "🏛️ Winston · Solution Architect") instead of
 * the raw agent key, with a flat fallback to the raw key + 🤖 when no persona
 * resolves.
 *
 * Layer 2 (#180): a per-finding "Deep Dive → Issue" action opens a dialog that
 * runs the deep-dive endpoint (editable issue draft), publishes the draft to
 * the project's configured destination(s), and surfaces the resulting issue
 * link(s). The action is gated by the analysis approval checkpoint
 * (`ticketStatus.allowed`).
 *
 * Determinism: the offline-stub AI provider can't produce the structured
 * persona/finding/deep-dive payloads these states need, so the whole analysis
 * API surface (personas, runs list, snapshot, approvals) plus the deep-dive /
 * publish calls are stubbed at the route level — exactly the approach the AI
 * Bug Scanner suite (`ai-bug-scanner.spec.ts`) uses. No real LLM, GitHub, or
 * Jira is contacted; the server-side endpoints are covered by unit tests.
 *
 * Acceptance criteria covered
 *   #177-1  known agentKey → persona avatar + name + role (not raw key)
 *   #177-2  unknown agentKey → fallback 🤖 + raw key (no crash)
 *   #177-3  flat list of findings, each with its persona label (documented choice)
 *   #177-4  no new network calls — the personas query is fetched once and reused
 *   #180-1  click Deep Dive → deep-dive called + loading state shown
 *   #180-2  draft returns → editable title/problem/files/reqs/criteria/labels + persona
 *   #180-3  Create Issue → success → issue link(s) (one per destination for `both`) + toast
 *   #180-4  ticketStatus disallows → action disabled with explanatory tooltip
 *   #180-5  deep-dive / publish error → inline error, dialog stays open, retry keeps edits
 *   #180-6  data-testid hooks + keyboard-accessible dialog (Escape closes)
 */
import { test, expect, request, type Route } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { AnalysisFindingsPage } from "../pages/analysis-findings.page.js";

const API_BASE = apiBase();

const ANALYSIS_ID = "an-e2e-176";
const CODE_FINDING_ID = "finding-code-1";
const WEB_FINDING_ID = "finding-web-1";

const CODE_FINDING_TITLE = "Tight coupling in the billing module";
const WEB_FINDING_TITLE = "Unpinned third-party analytics script";

const json = (data: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ data }),
});

/** Personas deliberately omit `web` so the web finding exercises the fallback. */
const PERSONAS = [
  { agentKey: "document", name: "Mary", role: "Business Analyst", avatar: "📊", description: "" },
  { agentKey: "code", name: "Winston", role: "Solution Architect", avatar: "🏛️", description: "" },
  { agentKey: "database", name: "Sally", role: "Data Architect", avatar: "🗄️", description: "" },
];

function finding(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    category: "architecture",
    severity: "high",
    body: "Detail body for the finding.",
    tags: [],
    citations: [],
    derivation: "extracted",
    confidence: 1,
    requirementId: null,
    ...overrides,
  };
}

interface SnapshotOptions {
  withFindings?: boolean;
}

function snapshot({ withFindings = true }: SnapshotOptions = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: ANALYSIS_ID,
    projectId: "ignored",
    startedById: "u-admin",
    status: "completed",
    startedAt: now,
    completedAt: now,
    totalTokens: 4242,
    inputTokens: 4000,
    outputTokens: 242,
    errorMessage: null,
    metadata: null,
    agents: [
      {
        agentKey: "code",
        status: "completed",
        startedAt: now,
        completedAt: now,
        errorMessage: null,
        summary: null,
        findings: withFindings
          ? [
              finding({
                id: CODE_FINDING_ID,
                title: CODE_FINDING_TITLE,
                category: "architecture",
                severity: "high",
                agentResultId: "code",
              }),
            ]
          : [],
      },
      {
        agentKey: "web",
        status: "completed",
        startedAt: now,
        completedAt: now,
        errorMessage: null,
        summary: null,
        findings: withFindings
          ? [
              finding({
                id: WEB_FINDING_ID,
                title: WEB_FINDING_TITLE,
                category: "security",
                severity: "medium",
                agentResultId: "web",
              }),
            ]
          : [],
      },
      {
        agentKey: "synthesis",
        status: "completed",
        startedAt: now,
        completedAt: now,
        errorMessage: null,
        summary: null,
        findings: [],
      },
    ],
    requirements: [],
  };
}

interface MockOptions {
  ticketsAllowed?: boolean;
  withFindings?: boolean;
  onPersonasHit?: () => void;
}

/**
 * Register the read-side analysis mocks (personas, cost-cap, runs list,
 * snapshot, approvals) for a project. Deep-dive / publish are registered
 * per-test because their behaviour varies.
 */
async function mockAnalysisReads(
  page: import("@playwright/test").Page,
  projectId: string,
  opts: MockOptions = {},
): Promise<void> {
  const { ticketsAllowed = true, withFindings = true, onPersonasHit } = opts;

  await page.route("**/api/analyses/personas", (route) => {
    onPersonasHit?.();
    return route.fulfill(json({ items: PERSONAS }));
  });

  await page.route("**/api/analyses/cost-cap", (route) =>
    route.fulfill(
      json({
        monthlyCap: 0,
        monthlyUsed: 0,
        monthlyRemaining: 0,
        monthBucket: "2026-06",
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
            totalTokens: 4242,
            errorMessage: null,
          },
        ],
      }),
    );
  });

  await page.route(`**/api/analyses/${ANALYSIS_ID}`, (route) =>
    route.fulfill(json(snapshot({ withFindings }))),
  );

  await page.route(`**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/approvals`, (route) =>
    route.fulfill(
      json({
        items: [],
        ticketStatus: {
          allowed: ticketsAllowed,
          pendingCount: ticketsAllowed ? 0 : 2,
          rejectedCount: 0,
        },
      }),
    ),
  );
}

const DEEP_DIVE_DRAFT = {
  title: "Decouple billing from the order service",
  problemStatement: "The billing module imports the order service directly, creating a cycle.",
  affected: { files: ["src/billing/index.ts"], requirementIds: ["REQ-12"] },
  acceptanceCriteria: ["Billing no longer imports the order service", "Cycle check passes in CI"],
  suggestedLabels: ["architecture", "tech-debt"],
};

function deepDiveUrl(projectId: string, findingId = CODE_FINDING_ID): string {
  return `**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/findings/${findingId}/deep-dive`;
}

function publishUrl(projectId: string, findingId = CODE_FINDING_ID): string {
  return `**/api/projects/${projectId}/analyses/${ANALYSIS_ID}/findings/${findingId}/publish`;
}

test.describe("Analysis findings — persona attribution + Deep Dive → Issue (#176)", () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const slug = `e2e-findings-176-${Date.now()}`;
    const res = await ctx.post("/api/projects", {
      data: { name: `Findings 176 ${slug}`, slug, description: "epic-176 e2e" },
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

  // ── Layer 1 — persona attribution (#177) ───────────────────────────────

  // AC #177-1: a finding with a known agentKey shows the persona avatar + name
  // + role instead of the raw agent key.
  test("a known-persona finding shows avatar + name + role, not the raw key", async ({ page }) => {
    await mockAnalysisReads(page, projectId);
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });
    await expect(pom.findingTitle(CODE_FINDING_TITLE)).toBeVisible();

    await test.step("the code finding is attributed to Winston · Solution Architect", async () => {
      await expect(pom.personaTag("code")).toBeVisible();
      await expect(pom.personaName("code")).toHaveText("Winston");
      await expect(pom.personaRole("code")).toContainText("Solution Architect");
    });

    await test.step("the raw agent key is not shown as the attribution label", async () => {
      // The chip exposes the key only via the (non-visible) data-agent-key
      // hook + title attribute, never as the rendered persona name.
      await expect(pom.personaName("code")).not.toHaveText("code");
    });
  });

  // AC #177-2: a finding whose agentKey has no matching persona falls back to
  // the raw key (and the default 🤖 glyph) without crashing.
  test("a finding with no resolved persona falls back to the raw agent key", async ({ page }) => {
    await mockAnalysisReads(page, projectId);
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });
    await expect(pom.findingTitle(WEB_FINDING_TITLE)).toBeVisible();

    await test.step("the web finding falls back to the raw key as its name", async () => {
      await expect(pom.personaTag("web")).toBeVisible();
      await expect(pom.personaName("web")).toHaveText("web");
    });

    await test.step("no role segment is rendered for the fallback chip", async () => {
      await expect(pom.personaRole("web")).toHaveCount(0);
    });
  });

  // AC #177-3: the findings render as a flat list, each card carrying its own
  // persona label (the PR's documented choice over collapsible grouping).
  test("findings render as a flat list with a persona label on each card", async ({ page }) => {
    await mockAnalysisReads(page, projectId);
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });
    await expect(pom.findingTitle(CODE_FINDING_TITLE)).toBeVisible();
    await expect(pom.findingTitle(WEB_FINDING_TITLE)).toBeVisible();

    // One persona chip per finding card — resolved (code) and fallback (web).
    await expect(pom.allPersonaTags()).toHaveCount(2);
    await expect(pom.personaTag("code")).toBeVisible();
    await expect(pom.personaTag("web")).toBeVisible();
  });

  // AC #177-4: persona attribution reuses the already-fetched personas query —
  // opening the Deep Dive dialog (which also renders a persona chip) adds no
  // further personas request.
  test("the personas query is fetched once and reused (no new network calls)", async ({ page }) => {
    let personaHits = 0;
    await mockAnalysisReads(page, projectId, { onPersonasHit: () => (personaHits += 1) });
    await page.route(deepDiveUrl(projectId), (route) =>
      route.fulfill(json({ draft: DEEP_DIVE_DRAFT, meta: { tokensUsed: 100, model: "stub" } })),
    );

    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);
    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });
    await expect(pom.personaTag("code")).toBeVisible();

    await pom.openDeepDive(CODE_FINDING_TITLE);
    await expect(pom.dialogPersona).toBeVisible();

    expect(personaHits).toBe(1);
  });

  // ── Layer 2 — Deep Dive → Issue (#180) ──────────────────────────────────

  // AC #180-1 + #180-2: clicking Deep Dive runs the endpoint (loading state),
  // then renders the editable draft fields and the originating persona.
  test("Deep Dive shows a loading state, then an editable draft with the persona", async ({
    page,
  }) => {
    await mockAnalysisReads(page, projectId);

    // Gate the deep-dive response so the loading state is asserted
    // deterministically (no arbitrary timeout).
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(deepDiveUrl(projectId), async (route: Route) => {
      await gate;
      await route.fulfill(
        json({ draft: DEEP_DIVE_DRAFT, meta: { tokensUsed: 512, model: "stub" } }),
      );
    });

    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);
    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });

    await test.step("the loading state appears while the deep-dive runs", async () => {
      await pom.openDeepDive(CODE_FINDING_TITLE);
      await expect(pom.dialogLoading).toBeVisible();
      release();
    });

    await test.step("the editable draft fields are populated", async () => {
      await expect(pom.titleInput).toHaveValue(DEEP_DIVE_DRAFT.title);
      await expect(pom.problemInput).toHaveValue(DEEP_DIVE_DRAFT.problemStatement);
      await expect(pom.filesInput).toHaveValue("src/billing/index.ts");
      await expect(pom.reqsInput).toHaveValue("REQ-12");
      await expect(pom.criteriaInput).toHaveValue(/Cycle check passes in CI/);
      await expect(pom.labelsInput).toHaveValue("architecture, tech-debt");
    });

    await test.step("the originating persona is shown in the dialog header", async () => {
      await expect(pom.dialogPersona).toBeVisible();
      await expect(pom.dialogPersona.getByTestId("persona-tag-name")).toHaveText("Winston");
    });

    await test.step("the draft fields are editable", async () => {
      await pom.titleInput.fill("Edited title");
      await expect(pom.titleInput).toHaveValue("Edited title");
    });
  });

  // AC #180-3: editing then Create Issue publishes successfully and shows the
  // created issue link plus a success toast. Also asserts the edited draft is
  // what gets sent to the publish endpoint.
  test("publishing a draft surfaces the created GitHub issue link and a toast", async ({
    page,
  }) => {
    await mockAnalysisReads(page, projectId);
    await page.route(deepDiveUrl(projectId), (route) =>
      route.fulfill(json({ draft: DEEP_DIVE_DRAFT, meta: { tokensUsed: 512, model: "stub" } })),
    );

    let publishedTitle: string | null = null;
    await page.route(publishUrl(projectId), (route) => {
      const payload = route.request().postDataJSON() as { draft?: { title?: string } };
      publishedTitle = payload.draft?.title ?? null;
      return route.fulfill(
        json({
          links: [
            {
              provider: "github",
              url: "https://github.com/openzigs/metis/issues/4242",
              issueKey: "#4242",
            },
          ],
        }),
      );
    });

    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);
    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });

    await pom.openDeepDive(CODE_FINDING_TITLE);
    await expect(pom.titleInput).toHaveValue(DEEP_DIVE_DRAFT.title);

    await pom.fillDraft({ title: "Decouple billing — final" });
    await pom.publish();

    await test.step("the created issue link is shown", async () => {
      await expect(pom.links).toBeVisible();
      await expect(pom.link("github: #4242")).toBeVisible();
      await expect(pom.link("github: #4242")).toHaveAttribute(
        "href",
        "https://github.com/openzigs/metis/issues/4242",
      );
    });

    await test.step("a success toast confirms the issue creation", async () => {
      await expect(page.getByText("Issue created", { exact: true })).toBeVisible();
    });

    await test.step("the edited draft title is what was published", async () => {
      expect(publishedTitle).toBe("Decouple billing — final");
    });
  });

  // AC #180-3 (variant): a project whose publishDestination is `both` returns
  // one link per destination — the dialog renders all of them and a plural toast.
  test("publishing to both destinations shows one link per destination", async ({ page }) => {
    await mockAnalysisReads(page, projectId);
    await page.route(deepDiveUrl(projectId), (route) =>
      route.fulfill(json({ draft: DEEP_DIVE_DRAFT, meta: { tokensUsed: 512, model: "stub" } })),
    );
    // The destination is server-resolved from the project's publishDestination;
    // a `both` project yields a GitHub *and* a Jira link.
    await page.route(publishUrl(projectId), (route) =>
      route.fulfill(
        json({
          links: [
            {
              provider: "github",
              url: "https://github.com/openzigs/metis/issues/77",
              issueKey: "#77",
            },
            {
              provider: "jira",
              url: "https://example.atlassian.net/browse/MET-9",
              issueKey: "MET-9",
            },
          ],
        }),
      ),
    );

    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);
    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });

    await pom.openDeepDive(CODE_FINDING_TITLE);
    await expect(pom.titleInput).toHaveValue(DEEP_DIVE_DRAFT.title);
    await pom.publish();

    await expect(pom.linkItems).toHaveCount(2);
    await expect(pom.link("github: #77")).toBeVisible();
    await expect(pom.link("jira: MET-9")).toBeVisible();
    await expect(page.getByText("Created 2 issues", { exact: true })).toBeVisible();
  });

  // AC #180-4: when ticketStatus disallows creation, the action is disabled
  // with an explanatory tooltip and clicking it does not open the dialog.
  test("the Deep Dive action is disabled with a tooltip when tickets are gated", async ({
    page,
  }) => {
    await mockAnalysisReads(page, projectId, { ticketsAllowed: false });
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });
    await expect(pom.findingTitle(CODE_FINDING_TITLE)).toBeVisible();

    const button = pom.deepDiveButton(CODE_FINDING_TITLE);
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", /blocked until pending approvals are resolved/i);
    await expect(pom.dialog).toHaveCount(0);
  });

  // AC #180-5: a deep-dive error keeps the dialog open with an inline error and
  // a Retry that recovers without forcing the user to reopen the dialog.
  test("a deep-dive error shows an inline error and Retry recovers", async ({ page }) => {
    await mockAnalysisReads(page, projectId);

    let attempts = 0;
    await page.route(deepDiveUrl(projectId), (route) => {
      attempts += 1;
      if (attempts === 1) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ success: false, error: { message: "deep dive boom" } }),
        });
      }
      return route.fulfill(
        json({ draft: DEEP_DIVE_DRAFT, meta: { tokensUsed: 1, model: "stub" } }),
      );
    });

    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);
    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });

    await pom.openDeepDive(CODE_FINDING_TITLE);

    await test.step("the inline error is shown and the dialog stays open", async () => {
      await expect(pom.dialogError).toBeVisible();
      await expect(pom.dialog).toBeVisible();
      await expect(pom.dialogRetry).toBeVisible();
    });

    await test.step("Retry recovers and renders the editable draft", async () => {
      await pom.dialogRetry.click();
      await expect(pom.titleInput).toHaveValue(DEEP_DIVE_DRAFT.title);
    });
  });

  // AC #180-5: a publish error keeps the dialog open and preserves the user's
  // edits so they can retry without re-typing.
  test("a publish error keeps the dialog open and preserves edits", async ({ page }) => {
    await mockAnalysisReads(page, projectId);
    await page.route(deepDiveUrl(projectId), (route) =>
      route.fulfill(json({ draft: DEEP_DIVE_DRAFT, meta: { tokensUsed: 512, model: "stub" } })),
    );
    await page.route(publishUrl(projectId), (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: { message: "publish boom" } }),
      }),
    );

    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);
    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });

    await pom.openDeepDive(CODE_FINDING_TITLE);
    await expect(pom.titleInput).toHaveValue(DEEP_DIVE_DRAFT.title);

    await pom.fillDraft({ title: "My carefully edited title" });
    await pom.publish();

    await test.step("the inline error is shown and the dialog stays open", async () => {
      await expect(pom.dialogError).toBeVisible();
      await expect(pom.dialog).toBeVisible();
    });

    await test.step("the user's edits are preserved", async () => {
      await expect(pom.titleInput).toHaveValue("My carefully edited title");
    });
  });

  // Empty state: a completed run with no findings renders the empty note and
  // exposes no Deep Dive action.
  test("a completed run with no findings shows the empty state and no action", async ({ page }) => {
    await mockAnalysisReads(page, projectId, { withFindings: false });
    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);

    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });
    await expect(pom.noFindings).toBeVisible();
    await expect(page.getByTestId("deep-dive-action")).toHaveCount(0);
  });

  // AC #180-6: the dialog is keyboard-accessible — Escape closes it.
  test("the Deep Dive dialog is keyboard-accessible (Escape closes it)", async ({ page }) => {
    await mockAnalysisReads(page, projectId);
    await page.route(deepDiveUrl(projectId), (route) =>
      route.fulfill(json({ draft: DEEP_DIVE_DRAFT, meta: { tokensUsed: 1, model: "stub" } })),
    );

    const pom = new AnalysisFindingsPage(page);
    await pom.goto(projectId);
    await expect(pom.findingsHeading).toBeVisible({ timeout: 30_000 });

    await pom.openDeepDive(CODE_FINDING_TITLE);
    await expect(pom.titleInput).toHaveValue(DEEP_DIVE_DRAFT.title);

    await page.keyboard.press("Escape");
    await expect(pom.dialog).toHaveCount(0);
  });
});
