/**
 * E2E — the analysis view's Governing rules panel (Epic #1866, #1876), with
 * governing documents on (the default since #1878). Issue #2060.
 *
 * Covers:
 *   - each status (Compliant, Gap, Needs BA input) renders with its control id
 *     and its quoted clause, under the requirement it was judged for;
 *   - Accept and Reject with a note survive a reload, with who decided;
 *   - an `uncertain` rule's "Answer the clarifying question" link lands on its
 *     question in the Questions tab.
 *
 * Determinism: the offline-stub provider's prose reaches no rule extraction,
 * applicability or findings check, so the governing document, its extracted
 * rules and the analysis's findings are seeded (`seedGoverningAnalysisViaCli`,
 * `server/scripts/e2e-seed-governing.ts`) from `fixtures/governing-fixture.ts`.
 * No model is called. Each test seeds into a workspace of its own, so the
 * seeded rules reach no other spec's analyses.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { seedGoverningAnalysisViaCli } from "../fixtures/seed-helpers.js";
import {
  GOVERNING_FIXTURE,
  GOVERNING_RULES,
  fixtureRule,
  rulesWithFindings,
} from "../fixtures/governing-fixture.js";
import { LoginPage } from "../pages/login.page.js";
import {
  GoverningFindingsPage,
  type GoverningStatusLabel,
} from "../pages/governing-findings.page.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = apiBase();

const STATUS_LABELS: Record<"compliant" | "gap" | "needs-ba-input", GoverningStatusLabel> = {
  compliant: "Compliant",
  gap: "Gap",
  "needs-ba-input": "Needs BA input",
};

function dbUrl(): string {
  return `file:${
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db")
  }`;
}

async function created<T>(res: Awaited<ReturnType<APIRequestContext["post"]>>, what: string) {
  expect(res.status(), `${what}: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { data?: T };
  if (!body.data) throw new Error(`${what}: no data in the response`);
  return body.data;
}

test.describe("Analysis view — Governing rules panel (#1876, #2060)", () => {
  test.describe.configure({ timeout: 120_000 });

  let api: APIRequestContext;
  let projectId: string;
  let workspaceId: string;
  let documentId: string;

  test.beforeEach(async ({ page }) => {
    // #2143 — this test's ids only: a seed that fails must not leave afterEach
    // deleting the previous test's workspace again.
    workspaceId = "";
    documentId = "";
    const primed = await primeAdminUser(API_BASE);
    api = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${primed.accessToken}` },
    });

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workspace = await created<{ id: string }>(
      await api.post("/api/workspaces", {
        data: { name: `Governing e2e ${stamp}`, slug: `e2e-governing-${stamp}` },
      }),
      "create the workspace",
    );
    // #2143 — set at once, so afterEach deletes it even when a later step fails.
    workspaceId = workspace.id;
    const project = await created<{ id?: string; project?: { id?: string } }>(
      await api.post("/api/projects", {
        data: {
          name: `Governing Findings ${stamp}`,
          slug: `e2e-governing-findings-${stamp}`,
          description: "governing findings e2e (#2060)",
          workspaceId: workspace.id,
        },
      }),
      "create the project",
    );
    projectId = (project.project?.id ?? project.id) as string;
    expect(projectId).toBeTruthy();

    const seeded = seedGoverningAnalysisViaCli({
      projectId,
      startedById: primed.userId,
      databaseUrl: dbUrl(),
    });
    expect(seeded.workspaceId).toBe(workspace.id);
    documentId = seeded.documentId;

    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // Best-effort, as workspaces.spec.ts: a failed delete is annotated, not a failure.
  test.afterEach(async ({}, testInfo) => {
    if (!api) return;
    if (workspaceId) {
      const res = await api.delete(`/api/workspaces/${workspaceId}`).catch(() => null);
      if (!res?.ok()) {
        testInfo.annotations.push({
          type: "cleanup",
          description: `workspace ${workspaceId} not deleted (${res ? `HTTP ${res.status()}` : "request failed"})`,
        });
      }
    }
    await api.dispose();
  });

  // AC: the fixture seeds a workspace governing document with extracted rules.
  test("the workspace's governing document carries its extracted rules", async () => {
    const res = await api.get(
      `/api/workspaces/${workspaceId}/governing-documents/${documentId}/rules`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      data: {
        revision: { revisionLabel: string; extractionState: string; isCurrent: boolean };
        rules: Array<{ controlId: string; clauseExcerpt: string }>;
      };
    };
    expect(body.data.revision).toMatchObject({
      revisionLabel: GOVERNING_FIXTURE.revisionLabel,
      extractionState: "done",
      isCurrent: true,
    });
    expect(body.data.rules.map((r) => r.controlId).sort()).toEqual(
      GOVERNING_RULES.map((r) => r.controlId).sort(),
    );
  });

  // AC: each status renders with its control id and quoted clause.
  test("each status renders with its control id and quoted clause", async ({ page }) => {
    const governing = new GoverningFindingsPage(page);
    await governing.goto(projectId);

    await test.step("the summary counts the rules that apply", async () => {
      const applying = rulesWithFindings().length;
      await expect(
        governing.summary(
          `${applying} of ${GOVERNING_RULES.length} rules in ${GOVERNING_FIXTURE.documentTitle} ${GOVERNING_FIXTURE.revisionLabel} apply.`,
        ),
      ).toBeVisible();
    });

    const group = governing.requirementGroup(GOVERNING_FIXTURE.requirementId);
    await expect(group).toBeVisible();
    await expect(group).toContainText(GOVERNING_FIXTURE.requirementText);

    for (const rule of rulesWithFindings()) {
      const status = STATUS_LABELS[rule.finding!.status];
      await test.step(`${rule.controlId} reads ${status}`, async () => {
        const finding = governing.finding(rule.controlId, status);
        await expect(finding).toBeVisible();
        await expect(governing.statusBadge(finding, status)).toBeVisible();
        await expect(governing.controlId(finding, rule.controlId)).toBeVisible();
        await expect(governing.clause(finding, rule.clauseRef)).toHaveText(rule.clauseExcerpt);
        await expect(finding).toContainText(rule.finding!.reasoning);
      });
    }

    await test.step("a rule that does not apply has no finding", async () => {
      const logging = fixtureRule("logging");
      await expect(governing.panel).not.toContainText(logging.controlId);
    });
  });

  // AC: Accept and Reject with a note survive a reload, with who decided.
  test("Accept and Reject with a note survive a reload, with who decided", async ({ page }) => {
    const governing = new GoverningFindingsPage(page);
    await governing.goto(projectId);

    const access = fixtureRule("access");
    const retention = fixtureRule("retention");
    const accepted = governing.finding(access.controlId, "Compliant");
    const rejected = governing.finding(retention.controlId, "Gap");

    await governing.decide(
      accepted,
      access.controlId,
      "Accepted",
      GOVERNING_FIXTURE.acceptNote,
      ADMIN_USER.displayName,
    );
    await governing.decide(
      rejected,
      retention.controlId,
      "Rejected",
      GOVERNING_FIXTURE.rejectNote,
      ADMIN_USER.displayName,
    );

    await governing.reload();

    await test.step("the acceptance and its note are read back", async () => {
      await expect(
        governing.decisionLine(accepted, "Accepted", ADMIN_USER.displayName),
      ).toBeVisible();
      await expect(governing.decisionNote(accepted)).toHaveText(GOVERNING_FIXTURE.acceptNote);
      await expect(governing.noteInput(accepted, access.controlId)).toHaveValue(
        GOVERNING_FIXTURE.acceptNote,
      );
    });

    await test.step("the rejection and its note are read back", async () => {
      await expect(
        governing.decisionLine(rejected, "Rejected", ADMIN_USER.displayName),
      ).toBeVisible();
      await expect(governing.decisionNote(rejected)).toHaveText(GOVERNING_FIXTURE.rejectNote);
    });

    await test.step("the undecided finding stays undecided", async () => {
      const transfer = governing.finding(fixtureRule("transfer").controlId, "Needs BA input");
      await expect(transfer.getByText(/^(Accepted|Rejected) by /)).toHaveCount(0);
    });
  });

  // AC: an uncertain rule's "Answer the clarifying question" link lands on its question.
  test("an uncertain rule's link lands on its clarifying question", async ({ page }) => {
    const governing = new GoverningFindingsPage(page);
    await governing.goto(projectId);

    const transfer = fixtureRule("transfer");
    expect(transfer.verdict).toBe("uncertain");
    const finding = governing.finding(transfer.controlId, "Needs BA input");
    await expect(finding).toContainText(transfer.finding!.businessQuestion!);

    const link = governing.clarifyingQuestionLink(finding);
    // Resolved once the Questions tab's dialog state is read (#2032).
    await expect(link).toHaveAttribute("href", `#clarify-question-${GOVERNING_FIXTURE.questionId}`);
    await link.click();

    await expect(governing.questionsTab).toBeVisible();
    const answer = governing.questionAnswer(GOVERNING_FIXTURE.question);
    await expect(answer).toBeVisible();
    await expect(answer).toBeInViewport();
  });

  // #2339 AC: the panel links to the workspace's Governing documents.
  test("the panel's link opens the workspace's governing documents", async ({ page }) => {
    const governing = new GoverningFindingsPage(page);
    await governing.goto(projectId);

    await governing.workspaceDocumentsLink.click();
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/governing$`));
    await expect(
      page.getByRole("heading", { level: 1, name: "Governing documents", exact: true }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(GOVERNING_FIXTURE.documentTitle).first()).toBeVisible();
  });
});
