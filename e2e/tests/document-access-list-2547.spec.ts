/**
 * E2E — Issue #2547: the per-document access list has a UI, driven by the
 * non-admin members the issue names (the mock `coordinator` and `developer`
 * roles, `server/src/lib/auth/mock-provider.ts`; both hold `document.upload`).
 *
 * | Acceptance criterion (#2547)                                       | Step                                        |
 * |--------------------------------------------------------------------|---------------------------------------------|
 * | restrict a document from its Documents row, as a non-admin         | Alice restricts payroll.md to coordinators  |
 * | a "Restricted" badge says who can read it                          | Alice sees the badge                        |
 * | a second member doesn't get it                                     | Bob: badge, no editor, no portfolio check   |
 * | the new-change-request picker marks it; Bob cannot select it       | Bob's change-request form                   |
 *
 * The document is seeded `ready` through the CLI seam the other suites use, so
 * no ingest has to finish; the access list does not need chunks to be saved.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import { ADMIN_USER } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { ProjectDocumentsPage } from "../pages/project-documents.page.js";
import { AnalysisPage } from "../pages/analysis-inline.page.js";
import { authedApi, e2eDatabaseUrl, primeUser } from "../fixtures/review-helpers.js";
import { seedDocumentViaCli } from "../fixtures/seed-helpers.js";

const ALICE = { username: "coordinator", password: "password" } as const;
const BOB = { username: "developer", password: "password" } as const;

async function signedIn(browser: Browser, creds: typeof ALICE | typeof BOB): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const login = new LoginPage(page);
  await login.goto();
  await login.login(creds.username, creds.password);
  return page;
}

test.describe("Document access list — restrict from the UI, as non-admins (#2547)", () => {
  test.describe.configure({ timeout: 150_000 });

  test("Alice restricts a document; Bob sees it marked and cannot use it", async ({ browser }) => {
    const filename = `payroll-${Date.now()}.md`;
    let projectId = "";
    let documentId = "";

    await test.step("seed a project and a ready document", async () => {
      const { accessToken: adminToken } = await primeUser({
        username: ADMIN_USER.username,
        password: ADMIN_USER.password,
      });
      const admin = await authedApi(adminToken);
      const slug = `e2e-acl-ui-${Date.now()}`;
      const res = await admin.post("/api/projects", {
        data: { name: `Access list ${slug}`, slug, description: "#2547 e2e" },
      });
      expect(res.status(), await res.text()).toBe(201);
      const body = (await res.json()) as {
        id?: string;
        data?: { id?: string; project?: { id?: string } };
      };
      projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
      await admin.dispose();
      const { userId: aliceId } = await primeUser(ALICE);
      await primeUser(BOB);
      documentId = seedDocumentViaCli({
        projectId,
        uploadedById: aliceId,
        filename,
        status: "ready",
        databaseUrl: e2eDatabaseUrl(),
      });
    });

    await test.step("Alice restricts it to coordinators from its Documents row", async () => {
      const page = await signedIn(browser, ALICE);
      const docs = new ProjectDocumentsPage(page);
      await docs.goto(projectId);
      await docs.expectLoaded();
      await expect(docs.restrictedBadge(documentId)).toHaveCount(0);
      await docs.restrictToRole(documentId, "coordinator");
      const badge = docs.restrictedBadge(documentId);
      await expect(badge).toContainText("Restricted", { timeout: 15_000 });
      await expect(badge).toContainText("Readable by role coordinator");
      // Alice is on the list, so she keeps the editor.
      await expect(docs.accessToggle(documentId)).toBeVisible();
      await page.context().close();
    });

    await test.step("Bob sees only Restricted, and no access editor or portfolio check on it", async () => {
      const page = await signedIn(browser, BOB);
      const docs = new ProjectDocumentsPage(page);
      await docs.goto(projectId);
      await docs.expectLoaded();
      const badge = docs.restrictedBadge(documentId);
      await expect(badge).toHaveText("Restricted", { timeout: 15_000 });
      // #2546 — a non-reader is told neither its name nor who reads it.
      const row = docs.documentRow(documentId);
      await expect(row).not.toContainText(filename);
      await expect(row).not.toContainText("coordinator");
      await expect(docs.accessToggle(documentId)).toHaveCount(0);
      await expect(
        row.getByRole("link", { name: "Check requirements across portfolio" }),
      ).toHaveCount(0);

      await test.step("and cannot pick it for a new change request", async () => {
        const analysis = new AnalysisPage(page);
        await analysis.goto(projectId);
        const pick = page.getByTestId(`add-documents-row-${documentId}`);
        await expect(pick).toContainText("Restricted");
        await expect(pick).not.toContainText(filename);
        await expect(pick.getByRole("checkbox")).toBeDisabled();
      });

      await test.step("and the server refuses him the access list", async () => {
        const { accessToken } = await primeUser(BOB);
        const api = await authedApi(accessToken);
        const res = await api.patch(`/api/projects/${projectId}/documents/${documentId}/acl`, {
          data: { aclSubjects: [{ kind: "role", value: "developer" }] },
        });
        expect(res.status(), await res.text()).toBe(403);
        // Owner policy — nor may he manage it otherwise (the spec toggle here).
        const spec = await api.patch(`/api/projects/${projectId}/documents/${documentId}/spec`, {
          data: { isSpec: true },
        });
        expect(spec.status(), await spec.text()).toBe(403);
        await api.dispose();
      });
      await page.context().close();
    });
  });
});
