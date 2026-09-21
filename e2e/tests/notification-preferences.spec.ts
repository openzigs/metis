/**
 * Epic #608 / Issue #615 — server-side notification preferences, end to end.
 *
 * Acceptance criteria covered:
 *   AC1: disabling the `mention × inApp` cell in Settings → Notifications
 *        suppresses the in-app notification a discussion @mention would
 *        otherwise create; re-enabling the cell restores delivery.
 *   AC2: preferences survive reload AND re-login — they are stored
 *        server-side (`NotificationPreference`), not in localStorage.
 *
 * Strategy: the browser drives the real Settings page as the COORDINATOR user
 * (toggle → Save → PUT /api/users/me/notification-preferences), while API
 * request contexts provide the dispatch trigger and the observation point:
 *   - the coordinator creates the project, so the fan-out's member check
 *     (`isProjectMember` — project creator or admin-role) passes for them via
 *     the `createdById` branch. (The admin-ROLE branch reads the `UserRole`
 *     table, which mock logins never populate, so the creator branch is the
 *     deterministic one.)
 *   - the ADMIN user posts thread messages that @mention the coordinator
 *     (the admin JWT role passes `actorCanAccessProject` for any project);
 *   - the coordinator's API context polls GET /api/notifications for the
 *     persisted `discussion_mention` row — the durable artefact the fan-out
 *     (`server/src/lib/discussions/notify.ts`) writes AFTER the #614
 *     `shouldNotify(userId, "inApp", "mention")` preference gate.
 *
 * Suppression is proven without a race: after the suppressed mention we (1)
 * give the fire-and-forget fan-out a grace window, (2) re-enable the cell and
 * post a SECOND mention, (3) wait until the second mention's notification
 * arrives — demonstrating the whole pipeline works — and only then assert the
 * first mention never produced a row.
 */
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { LoginPage } from "../pages/login.page.js";
import { SettingsNotificationsPage } from "../pages/settings-notifications.page.js";
import { watchForDoubleApiPrefix } from "../fixtures/no-double-api-prefix.js";

const API_BASE = apiBase();

/** Second seeded mock user — has `project.create`, so it can own the project. */
const COORDINATOR = { username: "coordinator", password: "password" };

/** Legacy localStorage key of the pre-#608 page — must stay unused. */
const LEGACY_STORAGE_KEY = "metis.settings.notifications";

// ---- API helpers --------------------------------------------------------------

async function loginViaApi(
  username: string,
  password: string,
): Promise<{ userId: string; api: APIRequestContext }> {
  const ctx = await request.newContext({ baseURL: API_BASE });
  const res = await ctx.post("/api/auth/login", { data: { username, password } });
  expect(res.status(), `login failed for ${username}: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as {
    data: { user: { id: string }; accessToken: string };
  };
  await ctx.dispose();

  const api = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${body.data.accessToken}` },
  });
  return { userId: body.data.user.id, api };
}

interface PreferenceEntry {
  channel: string;
  event: string;
  enabled: boolean;
  isDefault: boolean;
}

/** Resolved matrix straight from the API — the server-side source of truth. */
async function getPreferences(api: APIRequestContext): Promise<PreferenceEntry[]> {
  const res = await api.get("/api/users/me/notification-preferences");
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { data: { preferences: PreferenceEntry[] } };
  return body.data.preferences;
}

function findCell(
  preferences: PreferenceEntry[],
  channel: string,
  event: string,
): PreferenceEntry | undefined {
  return preferences.find((p) => p.channel === channel && p.event === event);
}

/** Post a discussion message; returns the message id. */
async function postMessage(
  api: APIRequestContext,
  threadId: string,
  body: string,
): Promise<string> {
  const res = await api.post(`/api/discussions/threads/${threadId}/messages`, {
    data: { body },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

/** Ids of the messages the caller's persisted discussion-mention rows point at. */
async function mentionedMessageIds(api: APIRequestContext): Promise<string[]> {
  const res = await api.get("/api/notifications");
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as {
    data: { notifications: Array<{ type: string; payload: string | null }> };
  };
  return body.data.notifications
    .filter((n) => n.type === "discussion_mention" && typeof n.payload === "string")
    .map((n) => {
      try {
        return (JSON.parse(n.payload as string) as { messageId?: string }).messageId ?? "";
      } catch {
        return "";
      }
    })
    .filter((id) => id.length > 0);
}

// ---- Suite ----------------------------------------------------------------------

test.describe("Epic #608 / Issue #615 — notification preferences e2e", () => {
  test.describe.configure({ timeout: 180_000 });

  let adminApi: APIRequestContext;
  let coordinatorApi: APIRequestContext;
  let threadId: string;

  test.beforeAll(async () => {
    // Prime both mock users (upserts the User rows so `@coordinator` resolves).
    await primeAdminUser(API_BASE);
    const [admin, coordinator] = await Promise.all([
      loginViaApi(ADMIN_USER.username, ADMIN_USER.password),
      loginViaApi(COORDINATOR.username, COORDINATOR.password),
    ]);
    adminApi = admin.api;
    coordinatorApi = coordinator.api;

    // The coordinator creates the project (becoming its creator → a deliverable
    // mention target for the fan-out's member check) and the thread. The admin
    // posts into it via the admin JWT role.
    const suffix = Date.now();
    const projectRes = await coordinatorApi.post("/api/projects", {
      data: {
        name: `notif-prefs-e2e-${suffix}`,
        slug: `notif-prefs-e2e-${suffix}`,
        description: "E2E #615",
      },
    });
    expect(projectRes.status(), await projectRes.text()).toBe(201);
    const projectId = ((await projectRes.json()) as { data: { id: string } }).data.id;

    const threadRes = await coordinatorApi.post("/api/discussions/threads", {
      data: { projectId, title: "Preference enforcement thread" },
    });
    expect(threadRes.status(), await threadRes.text()).toBe(201);
    threadId = ((await threadRes.json()) as { data: { id: string } }).data.id;
  });

  test.afterAll(async () => {
    await Promise.all([adminApi?.dispose(), coordinatorApi?.dispose()]);
  });

  test.beforeEach(async ({ page }) => {
    const login = new LoginPage(page);
    await login.goto();
    await login.login(COORDINATOR.username, COORDINATOR.password);
  });

  // AC1 — disabling mention × inApp suppresses the notification end to end;
  // re-enabling restores delivery.
  test("disabling mention × inApp suppresses a discussion @mention; re-enabling restores it", async ({
    page,
  }) => {
    const settings = new SettingsNotificationsPage(page);
    let suppressedMessageId = "";
    let deliveredMessageId = "";

    await test.step("coordinator disables the mention × inApp cell and saves", async () => {
      await settings.goto();
      await settings.expectLoaded();
      await settings.setCell("inApp", "mention", false);
      await settings.save();

      // Server-side confirmation: the cell is now a stored override, off.
      const cell = findCell(await getPreferences(coordinatorApi), "inApp", "mention");
      expect(cell).toBeDefined();
      expect(cell!.enabled).toBe(false);
      expect(cell!.isDefault).toBe(false);
    });

    await test.step("a discussion @mention now produces NO in-app notification", async () => {
      suppressedMessageId = await postMessage(
        adminApi,
        threadId,
        "@coordinator this ping must be suppressed by your preferences.",
      );
      // The fan-out is fire-and-forget; give it a grace window to run to
      // completion before we flip the preference back on.
      await page.waitForTimeout(4_000);
      expect(await mentionedMessageIds(coordinatorApi)).not.toContain(suppressedMessageId);
    });

    await test.step("coordinator re-enables the cell and saves", async () => {
      await settings.goto();
      await settings.expectLoaded();
      await settings.setCell("inApp", "mention", true);
      await settings.save();

      const cell = findCell(await getPreferences(coordinatorApi), "inApp", "mention");
      expect(cell!.enabled).toBe(true);
    });

    await test.step("a fresh @mention is delivered again — and the suppressed one never lands", async () => {
      deliveredMessageId = await postMessage(
        adminApi,
        threadId,
        "@coordinator this ping must be delivered again.",
      );
      // The second mention arriving proves the whole pipeline (parse →
      // member check → preference gate → Notification row) is live…
      await expect
        .poll(async () => mentionedMessageIds(coordinatorApi), { timeout: 30_000 })
        .toContain(deliveredMessageId);
      // …so the first mention's absence is a real suppression, not lag.
      expect(await mentionedMessageIds(coordinatorApi)).not.toContain(suppressedMessageId);
    });
  });

  // AC2 — settings survive reload and re-login: server-side persistence,
  // not localStorage.
  test("preference toggles survive reload and re-login (server-side, not localStorage)", async ({
    page,
  }) => {
    const settings = new SettingsNotificationsPage(page);
    const guard = watchForDoubleApiPrefix(page);

    await test.step("coordinator disables email × analysisCompleted and saves", async () => {
      await settings.goto();
      await settings.expectLoaded();
      await expect(settings.cell("email", "analysisCompleted")).toBeChecked();
      await settings.setCell("email", "analysisCompleted", false);
      await settings.save();
    });

    await test.step("nothing was written to localStorage", async () => {
      const legacyValue = await page.evaluate(
        (key) => window.localStorage.getItem(key),
        LEGACY_STORAGE_KEY,
      );
      expect(legacyValue).toBeNull();
    });

    await test.step("the toggle survives a reload with localStorage wiped", async () => {
      await page.evaluate(() => window.localStorage.clear());
      await page.reload({ waitUntil: "load" });
      await settings.expectLoaded();
      await expect(settings.cell("email", "analysisCompleted")).not.toBeChecked();
    });

    await test.step("the toggle survives a full re-login in a clean session", async () => {
      await page.context().clearCookies();
      await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      });

      const login = new LoginPage(page);
      await login.goto();
      await login.login(COORDINATOR.username, COORDINATOR.password);

      await settings.goto();
      await settings.expectLoaded();
      await expect(settings.cell("email", "analysisCompleted")).not.toBeChecked();

      // And the API agrees: a stored, non-default override.
      const cell = findCell(await getPreferences(coordinatorApi), "email", "analysisCompleted");
      expect(cell!.enabled).toBe(false);
      expect(cell!.isDefault).toBe(false);
    });

    await test.step("restore the default so later specs see pristine settings", async () => {
      await settings.setCell("email", "analysisCompleted", true);
      await settings.save();
    });

    guard.assertClean();
  });
});
