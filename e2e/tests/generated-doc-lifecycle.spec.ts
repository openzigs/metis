/**
 * E2E tests for reliable generated-document lifecycle surfacing.
 *
 * Browser-testable acceptance criteria covered from epic #1350 and children:
 *   - #1351 AC2: generation health and indexing health remain separate and observable.
 *   - #1356 AC6: degraded warnings remain visible and indexing stays gated.
 *   - delete/failure states where the current UI exposes them.
 *
 * Out of scope for browser coverage here: backend-only retry/idempotency,
 * authorization policy, repository-qualified provenance, regeneration diffing,
 * and benchmark/evaluation work from #1352-#1355 and #1357-#1358.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { seedGeneratedDocViaCli } from "../fixtures/seed-helpers.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { DocumentationPage } from "../pages/documentation.page.js";
import { LoginPage } from "../pages/login.page.js";

const API_BASE = apiBase();
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? `file:${process.env.E2E_DB_FILE ?? ""}`;

test.describe("Generated document lifecycle (#1350, #1351-#1358)", () => {
  let apiCtx: APIRequestContext;
  let projectId: string;
  let adminUserId: string;

  test.beforeAll(async () => {
    if (!DATABASE_URL || DATABASE_URL === "file:") {
      throw new Error("E2E database URL not set");
    }

    const primed = await primeAdminUser(API_BASE);
    adminUserId = primed.userId;
    apiCtx = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${primed.accessToken}` },
    });

    const slug = `generated-doc-lifecycle-${Date.now()}`;
    const createProject = await apiCtx.post("/api/projects", {
      data: {
        name: `Generated Doc Lifecycle ${slug}`,
        slug,
        description: "e2e generated-doc lifecycle",
      },
    });
    expect(createProject.status(), await createProject.text()).toBe(201);
    const projectBody = (await createProject.json()) as { data: { id: string } };
    projectId = projectBody.data.id;

    seedGeneratedDocViaCli({
      projectId,
      uploadedById: adminUserId,
      title: "Lifecycle Ready Indexed",
      generationStatus: "ready",
      indexState: "indexed",
      databaseUrl: DATABASE_URL,
    });
    seedGeneratedDocViaCli({
      projectId,
      uploadedById: adminUserId,
      title: "Lifecycle Needs Review",
      generationStatus: "degraded",
      indexState: "quarantined",
      databaseUrl: DATABASE_URL,
      warningJson: JSON.stringify([
        {
          kind: "section-ungrounded",
          section: "Overview",
          message: "Overview needs verification before publication.",
          severity: "warning",
          ratio: 0.55,
          threshold: 0.8,
          tier: "literal",
        },
      ]),
    });
    seedGeneratedDocViaCli({
      projectId,
      uploadedById: adminUserId,
      title: "Lifecycle Index Rejected",
      generationStatus: "ready",
      indexState: "rejected",
      databaseUrl: DATABASE_URL,
      errorMessage: "Indexing was rejected.",
    });
    seedGeneratedDocViaCli({
      projectId,
      uploadedById: adminUserId,
      title: "Lifecycle Generation Failed",
      generationStatus: "failed",
      indexState: "pending",
      databaseUrl: DATABASE_URL,
      errorMessage: "Generation failed after evidence capture",
    });
  });

  test.afterAll(async () => {
    await apiCtx?.dispose();
  });

  test.beforeEach(async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC #1351.2 and #1356.6
  test("shows separate generation and indexing states in the document list", async ({ page }) => {
    const docPage = new DocumentationPage(page);
    await docPage.goto(projectId);

    await test.step("ready indexed document shows terminal generation and indexing states", async () => {
      const card = docPage.card("Lifecycle Ready Indexed");
      await expect(card).toContainText("ready");
      await expect(card).toContainText("indexed");
    });

    await test.step("degraded document keeps generation warning separate from indexing quarantine", async () => {
      const card = docPage.card("Lifecycle Needs Review");
      await expect(card).toContainText("needs review");
      await expect(card).toContainText("quarantined");
    });

    await test.step("rejected indexing is visible without claiming indexed", async () => {
      const card = docPage.card("Lifecycle Index Rejected");
      await expect(card).toContainText("ready");
      await expect(card).toContainText("rejected");
      await expect(card).not.toContainText("indexed");
    });
  });

  // AC #1351.2
  test("surfaces rejected indexing details on the document detail view", async ({ page }) => {
    const docPage = new DocumentationPage(page);
    await docPage.goto(projectId);

    await test.step("open the document with rejected indexing", async () => {
      await docPage.openDocumentFromList("Lifecycle Index Rejected");
    });

    await test.step("detail keeps generation ready while indexing shows rejection summary", async () => {
      await expect(docPage.generationSummary).toBeVisible();
      await expect(page.getByText("Indexing", { exact: true })).toBeVisible();
      await expect(page.getByText("ready", { exact: true })).toBeVisible();
      await expect(page.getByTestId("doc-indexing-badge")).toContainText("rejected");
      await expect(docPage.indexingSummary).toContainText("Indexing was rejected.");
    });
  });

  // AC #1356.6
  test("shows degraded-generation warnings alongside quarantined indexing", async ({ page }) => {
    const docPage = new DocumentationPage(page);
    await docPage.goto(projectId);

    await test.step("open the degraded document", async () => {
      await docPage.openDocumentFromList("Lifecycle Needs Review");
    });

    await test.step("detail preserves the warning banner and approval-gated indexing summary", async () => {
      await expect(page.getByText("needs review", { exact: true })).toBeVisible();
      await expect(docPage.degradedBanner).toContainText(
        /worth verifying|grounded within normal tolerance/i,
      );
      await expect(docPage.degradedBanner).toContainText(
        "Overview needs verification before publication.",
      );
      await expect(page.getByTestId("doc-indexing-badge")).toContainText("quarantined");
      await expect(docPage.indexingSummary).toContainText("Awaiting approval before indexing.");
    });
  });

  // AC #1351.2, delete exposed by current UI
  test("deletes a failed generated document from the detail view", async ({ page }) => {
    const docPage = new DocumentationPage(page);
    await docPage.goto(projectId);

    await test.step("open the failed-generation document", async () => {
      await docPage.openDocumentFromList("Lifecycle Generation Failed");
    });

    await test.step("the failure is explicit before deletion", async () => {
      await expect(page.getByText("failed", { exact: true })).toBeVisible();
      await expect(docPage.indexingSummary).toContainText("Queued for indexing.");
    });

    await test.step("delete removes the failed document from the list", async () => {
      await docPage.deleteButton.click();
      await docPage.goto(projectId);
      await expect(docPage.card("Lifecycle Generation Failed")).toHaveCount(0);
    });
  });

  // #2369 — this project has no repository, so a Business Requirements document
  // has no code to read. The form says so up front; a run anyway ends failed
  // with an error toast that says why, never "Documentation ready" over a stub
  // that is then indexed.
  test("a documents-only project: BRD warns first, then fails with a reason", async ({ page }) => {
    const docPage = new DocumentationPage(page);
    // #2377 — the symptom #2369 reported: the Overview's document count grew
    // and a document waited in quarantine. The Overview reads both from
    // `GET /documents`, so that is what is compared before and after.
    const knowledge = async () => {
      const res = await apiCtx.get(`/api/projects/${projectId}/documents?limit=100`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        data: { total: number; items: Array<{ indexState?: string | null }> };
      };
      return {
        total: body.data.total,
        quarantined: body.data.items.filter((d) => d.indexState === "quarantined").length,
      };
    };
    const before = await knowledge();
    await docPage.goto(projectId);

    await test.step("the form warns that the document type needs source code", async () => {
      await docPage.openGenerateForm();
      await expect(docPage.noSourceCodeWarning).toBeVisible();
      await expect(docPage.noSourceCodeWarning).toContainText(
        "Business Requirements needs connected source code",
      );
    });

    await test.step("generating anyway fails with an error toast, not a success", async () => {
      await docPage.titleInput.fill("Lifecycle No Source Code");
      await docPage.submitGenerate.click();
      const failure = page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "This document type needs connected source code" });
      await expect(failure).toBeVisible({ timeout: 30_000 });
      await expect(failure).toHaveAttribute("data-type", "error");
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: "Documentation ready" }),
      ).toHaveCount(0);
    });

    await test.step("the document reads failed, with no content and the reason", async () => {
      const list = await apiCtx.get(`/api/projects/${projectId}/docs`);
      expect(list.status()).toBe(200);
      const docs = ((await list.json()) as { data: Array<{ id: string; title: string }> }).data;
      const created = docs.find((d) => d.title === "Lifecycle No Source Code");
      expect(created, "the generated document row").toBeDefined();
      const detailUrl = `/api/projects/${projectId}/docs/${created!.id}`;
      await expect
        .poll(
          async () =>
            ((await (await apiCtx.get(detailUrl)).json()) as { data: { status: string } }).data
              .status,
        )
        .toBe("failed");
      const detail = (await (await apiCtx.get(detailUrl)).json()) as {
        data: { content: string; errorMessage: string | null };
      };
      expect(detail.data.content).toBe("");
      expect(detail.data.errorMessage).toContain("needs connected source code");
      // #2377 — never queued for indexing, so no indexing state at all.
      expect((detail.data as { indexing?: unknown }).indexing).toBeNull();
    });

    await test.step("the project's knowledge does not grow and nothing waits in quarantine", async () => {
      // At most equal, not equal: the delete test before this one removes its
      // document's index entry asynchronously, which can only lower the count.
      const after = await knowledge();
      expect(after.total).toBeLessThanOrEqual(before.total);
      expect(after.quarantined).toBeLessThanOrEqual(before.quarantined);
    });

    await test.step("the failed document's card shows no indexing badge", async () => {
      await docPage.goto(projectId);
      const card = docPage.card("Lifecycle No Source Code");
      await expect(card).toContainText("failed");
      await expect(card.getByTestId("doc-indexing-badge")).toHaveCount(0);
    });
  });
});
