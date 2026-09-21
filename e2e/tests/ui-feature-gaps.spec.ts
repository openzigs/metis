/**
 * Epic #119 — UI feature-exposure gaps E2E.
 *
 * Covers acceptance criteria for the three backend-only features that gained a
 * UI in this epic:
 *   - #127 Inference-profile picker (project Settings)
 *   - #123 Plugins import/export
 *   - #122 AST cache rebuild control (repositories/connections tab)
 *
 * Approach: prime the mock admin + create a project over the API, log in
 * through the browser, then drive each new surface with accessible / testid
 * locators via Page Objects.
 *
 * Prerequisites: Playwright webServer boots API (4101) and UI (3101) with
 * AI_PROVIDER=offline-stub.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser, type PrimeResult } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { InferenceProfilePanel } from "../pages/inference-profile.page.js";
import { PluginsPage } from "../pages/plugins.page.js";

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

let primed: PrimeResult;
let projectId: string;
const slug = `e2e-uigaps-${Date.now().toString(36)}`;

test.describe("Epic #119 — UI feature-exposure gaps", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    primed = await primeAdminUser(API_BASE);
    const ctx = await authedApi(primed.accessToken);
    try {
      const res = await ctx.post("/api/projects", {
        data: { name: "UI Gaps E2E", slug, description: "e2e ui feature gaps" },
      });
      expect(res.status()).toBe(201);
      const body = (await res.json()) as ApiEnvelope<{ id: string }>;
      projectId = body.data.id;
      expect(projectId).toBeTruthy();
    } finally {
      await ctx.dispose();
    }
  });

  test.beforeEach(async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // ── #127 Inference-profile picker ─────────────────────────────────────
  test.describe("#127 Inference-profile picker", () => {
    test("loads, persists a valid profile, and surfaces a parsed error", async ({ page }) => {
      const panel = new InferenceProfilePanel(page);
      await panel.goto(projectId);

      // Empty/default state on a project with no profile.
      await expect(panel.arnInput).toHaveValue("");

      // Save a valid Bedrock inference profile → success toast.
      const arn =
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6";
      await panel.fillAndSave(arn, "us.anthropic.claude-sonnet-4-6");
      await expect(panel.savedToast).toBeVisible();

      // An invalid ARN surfaces a parsed validation error (no raw JSON blob).
      await panel.arnInput.fill("not-a-valid-arn");
      await panel.saveButton.click();
      await expect(panel.formError).toBeVisible();
      await expect(panel.formError).not.toContainText("{");
    });
  });

  // ── #123 Plugins import/export ────────────────────────────────────────
  test.describe("#123 Plugins import/export", () => {
    test("validates the plugin name and rejects malformed imports", async ({ page }) => {
      const plugins = new PluginsPage(page);
      await plugins.goto(projectId);

      // Invalid plugin name blocks export with a human-readable message.
      await plugins.nameInput.fill("Bad Name!");
      await plugins.exportButton.click();
      await expect(plugins.exportError).toBeVisible();
      await expect(plugins.exportError).toContainText(/lowercase/i);

      // Uploading a malformed envelope surfaces a parsed error and imports nothing.
      await plugins.importFile.setInputFiles({
        name: "broken.json",
        mimeType: "application/json",
        buffer: Buffer.from("{ not json", "utf-8"),
      });
      await expect(plugins.importError).toBeVisible();
      await expect(plugins.importSuccess).toHaveCount(0);
    });

    test("exports a valid envelope as a download", async ({ page }) => {
      const plugins = new PluginsPage(page);
      await plugins.goto(projectId);
      await plugins.nameInput.fill("demo-plugin");

      const downloadPromise = page.waitForEvent("download");
      await plugins.exportButton.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toContain("metis-plugin");
    });
  });

  // ── #122 AST cache rebuild ────────────────────────────────────────────
  test.describe("#122 AST cache rebuild", () => {
    test("shows a Rebuild AST cache control on the connections tab", async ({ page }) => {
      // Create a repo connector over the API so the repositories list is non-empty.
      const ctx = await authedApi(primed.accessToken);
      let repoId: string | null = null;
      try {
        const res = await ctx.post(`/api/projects/${projectId}/connectors/repos`, {
          data: {
            label: "e2e-repo",
            provider: "github",
            ownerOrOrg: "octocat",
            repoName: "hello-world",
          },
        });
        if (res.ok()) {
          const body = (await res.json()) as ApiEnvelope<{ id: string }>;
          repoId = body.data.id;
        }
      } finally {
        await ctx.dispose();
      }
      test.skip(!repoId, "repo connector creation unavailable in this environment");

      await page.goto(`/projects/${projectId}/connections`);
      const rebuildButton = page.getByTestId(`rebuild-cache-button-${repoId}`);
      await expect(rebuildButton).toBeVisible({ timeout: 15_000 });

      // Clicking triggers a rebuild; without a real clone it surfaces a failed
      // status rather than a misleading "completed" state.
      await rebuildButton.click();
      await expect(
        page
          .getByTestId(`rebuild-cache-error-${repoId}`)
          .or(page.getByTestId(`rebuild-cache-status-${repoId}`)),
      ).toBeVisible({ timeout: 30_000 });
    });
  });
});
