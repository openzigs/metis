import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { apiBase } from "../fixtures/api-base.js";
import {
  CLEANUP_ERROR,
  SHOWN_CLEANUP_ERROR,
  parkManualApprovalForReconciliation,
} from "../fixtures/manual-approval.js";
import { primeAdminUser } from "../fixtures/seed-user.js";
import { LoginPage } from "../pages/login.page.js";
import { QuarantinePage } from "./pages/quarantine.page.js";

test.describe("Manual approval reconciliation (#1350)", () => {
  let api: APIRequestContext;
  let projectId: string;
  let documentId: string;
  const filename = "manual-approval-retry.md";

  test.beforeEach(async ({ page }) => {
    projectId = "";
    const admin = await primeAdminUser(apiBase());
    api = await request.newContext({
      baseURL: apiBase(),
      extraHTTPHeaders: { Authorization: `Bearer ${admin.accessToken}` },
    });
    const project = await api.post("/api/projects", {
      data: { name: "Manual approval retry", slug: `approval-retry-${randomUUID()}` },
    });
    expect(project.status(), await project.text()).toBe(201);
    projectId = (await project.json()).data.id;
    const upload = await api.post(`/api/projects/${projectId}/documents/text`, {
      data: {
        filename,
        content: "# Manual approval\n\nOperators can retry indexing after approval cleanup fails.",
      },
    });
    expect([201, 202], await upload.text()).toContain(upload.status());
    const document = (await upload.json()).data.document;
    documentId = document.id;
    // Current ingest uses the durable queue even with INGEST_QUEUE=off.
    // Wait for the real quarantine list rather than assuming synchronous ingest.
    await expect
      .poll(async () => {
        const list = await api.get(`/api/projects/${projectId}/quarantine`);
        expect(list.status(), await list.text()).toBe(200);
        return (await list.json()).data.items.some(
          (item: { documentId: string; indexState: string }) =>
            item.documentId === documentId && item.indexState === "quarantined",
        );
      })
      .toBe(true);
    const approval = await api.post(`/api/projects/${projectId}/documents/${documentId}/approve`);
    expect(approval.status(), await approval.text()).toBe(200);
    expect((await approval.json()).data.document.indexState).toBe("indexed");
    parkManualApprovalForReconciliation(documentId);
    await new LoginPage(page).loginAsAdmin();
  });

  test.afterEach(async () => {
    try {
      if (projectId) {
        const deleted = await api.delete(`/api/projects/${projectId}`);
        expect(deleted.status(), await deleted.text()).toBe(204);
      }
    } finally {
      await api?.dispose();
    }
  });

  // AC #1350: a saved manual approval remains actionable as Retry indexing after refresh.
  test("keeps saved approval and cleanup error across a browser refresh", async ({ page }) => {
    const quarantine = new QuarantinePage(page, filename);
    await quarantine.goto(projectId);
    await quarantine.expectReconciling(SHOWN_CLEANUP_ERROR, CLEANUP_ERROR);
    await quarantine.reload();
    await quarantine.expectReconciling(SHOWN_CLEANUP_ERROR, CLEANUP_ERROR);
  });

  // AC #1350: failed retry stays actionable; successful retry clears quarantine durably.
  test("shows retry failure then completes a real indexing retry across refresh", async ({
    page,
  }) => {
    const quarantine = new QuarantinePage(page, filename);
    const approvePath = `/projects/${projectId}/documents/${documentId}/approve`;
    const listPath = `/projects/${projectId}/quarantine`;
    const failure = "E2E simulated approval cleanup failure";
    await quarantine.goto(projectId);
    await quarantine.expectReconciling(SHOWN_CLEANUP_ERROR, CLEANUP_ERROR);

    await test.step("failed HTTP retry shows pending and error states without losing saved approval", async () => {
      let release!: () => void;
      const responseGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Fault boundary: ONLY this browser POST is intercepted before the server.
      // It does not simulate a real vector/BM25 cleanup failure. List/auth calls
      // stay real; the following successful POST runs the actual reconciler.
      await page.route(
        (url) => url.pathname.endsWith(approvePath),
        async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await responseGate;
          await route.fulfill({
            // The real approve route maps cleanup exceptions to 409. A 5xx
            // would transparently retry via the app's normal mutation policy.
            status: 409,
            json: { success: false, error: { code: "DOCUMENT_APPROVE_FAILED", message: failure } },
          });
        },
        { times: 1 },
      );
      const failedResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith(approvePath) && response.request().method() === "POST",
      );
      const refreshedList = page.waitForResponse(
        (response) => response.url().endsWith(listPath) && response.request().method() === "GET",
      );
      try {
        await quarantine.retry.click();
        await expect(quarantine.retrying).toBeDisabled();
      } finally {
        release();
      }
      expect((await failedResponse).status()).toBe(409);
      await expect(quarantine.approvalError).toHaveText(
        `Unable to finish approval/indexing: ${failure}`,
      );
      expect((await refreshedList).status()).toBe(200);
      await quarantine.expectReconciling(SHOWN_CLEANUP_ERROR, CLEANUP_ERROR);
      await quarantine.reload();
      await quarantine.expectReconciling(SHOWN_CLEANUP_ERROR, CLEANUP_ERROR);
    });

    await test.step("real retry completes cleanup and stays absent after refresh", async () => {
      const completed = page.waitForResponse(
        (response) =>
          response.url().endsWith(approvePath) && response.request().method() === "POST",
      );
      await quarantine.retry.click();
      const response = await completed;
      expect(response.status(), await response.text()).toBe(200);
      expect((await response.json()).data.document).toMatchObject({
        id: documentId,
        indexState: "indexed",
        status: "ready",
        errorMessage: null,
      });
      await expect(quarantine.row).toHaveCount(0);
      await expect(quarantine.empty).toBeVisible();
      await expect(quarantine.approvalError).toHaveCount(0);
      await quarantine.reload();
      await expect(quarantine.empty).toBeVisible();
      await expect(quarantine.row).toHaveCount(0);
    });
  });
});
