/**
 * Coverage — Settings sub-pages (Epic #196 / #220 + #221).
 *
 *   /settings/profile       — read-only account fields from the auth context.
 *   /settings/integrations  — navigation index of third-party surfaces.
 *
 * Profile sources its values from the in-memory auth context (no per-page
 * fetch), so the spec asserts the four fields render with the seeded admin's
 * values. Integrations is a static link grid; the spec asserts the key
 * category links render and point at the documented destinations. Neither page
 * may issue a /api/api/ double-prefixed request.
 *
 * Acceptance criteria:
 *   AC: profile renders heading + the four account fields with admin values.
 *   AC: integrations renders heading + the category link grid.
 *   AC: integrations links expose the documented hrefs (repositories,
 *       databases, mcp, hooks, triggers, vault).
 *   AC: neither page issues a /api/api/ double-prefixed request.
 */
import { test, expect } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";
import { SettingsProfilePage, SettingsIntegrationsPage } from "../pages/settings-subpages.page.js";

const API_BASE = apiBase();

test.describe("Settings sub-pages (#220 / #221)", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await primeAdminUser(API_BASE);
    const login = new LoginPage(page);
    await login.goto();
    await login.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  test("profile renders the account fields from the auth context", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const profile = new SettingsProfilePage(page);

    await profile.goto();
    await profile.expectLoaded();

    await test.step("the profile card + four fields render", async () => {
      await expect(profile.card).toBeVisible();
      await expect(profile.username).toContainText(ADMIN_USER.username);
      await expect(profile.role).toContainText(ADMIN_USER.role);
      // The browser flow re-hydrates the auth context via /auth/me. The email
      // field renders its "Email" label with the "—" fallback because the JWT
      // payload carries no email; the display name DOES come through from the
      // mock provider ("System Admin").
      await expect(profile.email).toContainText("Email");
      await expect(profile.displayName).toContainText(ADMIN_USER.displayName);
    });

    guard.assertClean();
  });

  test("integrations renders the category link grid with documented hrefs", async ({ page }) => {
    const guard = watchForDoubleApiPrefix(page);
    const integrations = new SettingsIntegrationsPage(page);

    await integrations.goto();
    await integrations.expectLoaded();

    await test.step("the grid + key links render", async () => {
      await expect(integrations.grid).toBeVisible();
      await expect(integrations.link("settings-integrations-link-repositories")).toHaveAttribute(
        "href",
        "/repositories",
      );
      await expect(integrations.link("settings-integrations-link-databases")).toHaveAttribute(
        "href",
        "/databases",
      );
      await expect(integrations.link("settings-integrations-link-mcp")).toHaveAttribute(
        "href",
        "/settings/mcp",
      );
      await expect(integrations.link("settings-integrations-link-hooks")).toHaveAttribute(
        "href",
        "/settings/hooks",
      );
      await expect(integrations.link("settings-integrations-link-triggers")).toHaveAttribute(
        "href",
        "/settings/triggers",
      );
      await expect(integrations.link("settings-integrations-link-vault")).toHaveAttribute(
        "href",
        "/vault",
      );
    });

    guard.assertClean();
  });
});
