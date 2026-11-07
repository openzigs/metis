/**
 * #1889 — a page title is never squeezed to nothing by its header's actions.
 *
 * `agents-skills.spec.ts:57` failed twice on one runner because `getByRole("heading",
 * { name: "Chat" })` stayed "hidden" for 15 s, while the failure screenshot showed
 * the word "Chat" on screen with the "Agent:" label drawn over it. The shared
 * `PageHeader` let its title column shrink to zero width (`min-w-0`) beside an
 * actions block that could not shrink (`shrink-0`). The chat page's actions are an
 * agent picker as wide as its longest agent name, "New chat" and a hint, and in the
 * chat column at 1280 px they did not fit beside the title once the agent list had
 * loaded. The `<h1>` then had a zero-width box, which Playwright reports as hidden
 * and a reader sees as a title overlapped by the agent picker. The spec only passed
 * when its first check landed before the agent list and the session hint arrived.
 *
 * This spec waits for that fully loaded state on purpose, with an agent whose name
 * is as long as a real one can be, and checks the title is visible, shows all of
 * its text, and does not share space with the actions.
 */
import { test, expect, request, type APIRequestContext, type Locator } from "@playwright/test";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import { apiBase } from "../fixtures/api-base.js";
import { createProjectViaApi } from "../fixtures/project-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { AgentChatPage } from "../pages/agent-chat.page.js";

const API_BASE = apiBase();

async function api(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, "element has a layout box").not.toBeNull();
  return b!;
}

test.describe("#1889 — page header title beside wide actions", () => {
  test("the Chat title stays readable beside an agent with a long name", async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    const client = await api(primed.accessToken);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const agentKey = `e2e-long-name-${stamp}`;
    // Wider than the whole chat column on its own (an agent name may run to 120).
    const agentName = `Requirements analyst for the payments, settlements and reconciliation team in finance ${stamp}`;
    try {
      const agent = await client.post("/api/agents", {
        data: {
          key: agentKey,
          source: [
            "---",
            `name: ${agentName}`,
            "description: Reviews requirements.",
            "---",
            "You review requirements.",
          ].join("\n"),
        },
      });
      expect(agent.status(), await agent.text()).toBe(201);
      const projectId = (await createProjectViaApi(API_BASE, primed.accessToken, "e2e-header")).id;

      const login = new LoginPage(page);
      await login.goto();
      await login.login(ADMIN_USER.username, ADMIN_USER.password);

      const chat = new AgentChatPage(page);
      await chat.gotoProjectChat(projectId);
      // The state the flaky spec could land in: the agent list and the hint are in.
      await expect(chat.agentPicker.locator(`option[value="${agentKey}"]`)).toHaveText(agentName);
      await expect(page.getByTestId("chat-new-session-hint")).toBeVisible();

      const heading = page.getByRole("heading", { name: "Chat", exact: true });
      await expect(heading).toBeVisible();
      // The whole word fits inside the heading's own box: nothing spills over.
      const overflow = await heading.evaluate((h) => h.scrollWidth - h.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      const title = await box(heading);
      const actions = await box(page.locator('[data-slot="page-header-actions"]'));
      const intersects =
        title.x < actions.x + actions.width &&
        actions.x < title.x + title.width &&
        title.y < actions.y + actions.height &&
        actions.y < title.y + title.height;
      expect(intersects, "the title and the header actions do not overlap").toBe(false);

      // The long name narrows the picker; it does not widen the chat column and
      // push the Skills panel past the right edge of the window.
      const skills = await box(page.getByRole("complementary", { name: "Session skills" }));
      expect(skills.x + skills.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      // And every header control stays in the chat column, clear of that panel.
      for (const control of [
        chat.agentPicker,
        page.getByRole("button", { name: "New chat" }),
        page.getByTestId("chat-new-session-hint"),
      ]) {
        const b = await box(control);
        expect(b.x + b.width).toBeLessThanOrEqual(skills.x);
      }
    } finally {
      await client.dispose();
    }
  });
});
