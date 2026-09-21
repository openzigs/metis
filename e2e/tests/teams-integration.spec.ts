/**
 * Epic #547 — Microsoft Teams integration settings walkthrough (e2e).
 *
 * Drives the new /settings/integrations/teams page end-to-end against the real
 * #548 backend (no live Azure traffic — the install endpoint only vaults the
 * bot credentials, it never calls Microsoft):
 *
 *   1. Seed a workspace via the API so the workspace-scoped page has a target.
 *   2. From the integrations hub, follow the Microsoft Teams card.
 *   3. Connect a bot (dummy MultiTenant credentials) and confirm it is stored
 *      + reflected as "Connected".
 *   4. Build the Teams app manifest and confirm the messaging endpoint carries
 *      the workspace id.
 *   5. Disconnect and confirm the install form returns.
 *
 * Security note asserted in-flow: the bot password is a write-only field — it
 * is never rendered back into the DOM after the install round-trips.
 */
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { primeAdminUser } from "../fixtures/seed-user";
import { apiBase } from "../fixtures/api-base";
import { LoginPage } from "../pages/login.page";
import { TeamsIntegrationPage } from "../pages/teams-integration.page";

const API_BASE = apiBase();

test.describe("Epic #547 — Microsoft Teams integration page", () => {
  test("connect a Teams bot, build the manifest, then disconnect", async ({ page }) => {
    // ── Seed a workspace so the workspace selector has a manageable target. ──
    const { accessToken } = await primeAdminUser(API_BASE);
    const ctx: APIRequestContext = await request.newContext({
      baseURL: API_BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
    });
    const suffix = Date.now();
    const workspaceName = `Teams E2E ${suffix}`;
    let workspaceId = "";
    try {
      const wsRes = await ctx.post("/api/workspaces", {
        data: { name: workspaceName, slug: `teams-e2e-${suffix}` },
      });
      expect(wsRes.status(), await wsRes.text()).toBe(201);
      workspaceId = (await wsRes.json()).data.id as string;

      const teams = new TeamsIntegrationPage(page);

      await test.step("navigate from the integrations hub via the Teams card", async () => {
        const login = new LoginPage(page);
        await login.goto();
        await login.login("admin", "password");

        await page.goto("/settings/integrations", { waitUntil: "load" });
        const card = page.getByTestId("settings-integrations-link-teams");
        await expect(card).toHaveAttribute("href", "/settings/integrations/teams");
        await card.click();
        await teams.expectLoaded();
      });

      await test.step("connect the Teams bot", async () => {
        await teams.selectWorkspace(workspaceName);
        await expect(teams.statusDisconnected).toBeVisible();
        await teams.install({
          appId: `e2e-app-${suffix}`,
          appPassword: "e2e-super-secret-password",
          label: "E2E bot",
        });
        await expect(teams.statusConnected).toBeVisible({ timeout: 20_000 });
        await expect(teams.installedView).toContainText(`e2e-app-${suffix}`);
        // The write-only password must never be rendered back into the DOM.
        await expect(page.getByText("e2e-super-secret-password")).toHaveCount(0);
      });

      await test.step("the connection is persisted server-side", async () => {
        const check = await ctx.get(
          `/api/integrations/teams/workspaces/${workspaceId}/installation`,
        );
        expect(check.status()).toBe(200);
        const summary = (await check.json()).data as { appId: string; status: string };
        expect(summary.appId).toBe(`e2e-app-${suffix}`);
      });

      await test.step("build the Teams app manifest", async () => {
        const endpoint = await teams.buildManifest({
          packageId: "com.metis.e2e",
          publicHost: "https://metis.example.com",
        });
        expect(endpoint).toContain("/api/integrations/teams/messages?workspaceId=");
        expect(endpoint).toContain(workspaceId);
        await expect(teams.manifestDownload).toBeVisible();
      });

      await test.step("disconnect the Teams bot", async () => {
        await teams.disconnect();
        await expect(teams.statusDisconnected).toBeVisible({ timeout: 20_000 });
        await expect(teams.installForm).toBeVisible();
      });

      await test.step("the installation is gone server-side", async () => {
        const gone = await ctx.get(
          `/api/integrations/teams/workspaces/${workspaceId}/installation`,
        );
        expect(gone.status()).toBe(404);
      });
    } finally {
      await ctx.dispose();
    }
  });
});
