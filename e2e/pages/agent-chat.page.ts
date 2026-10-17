/**
 * Epic #129 (#148) — the chat page as the agents-and-skills journey uses it:
 * pick an agent, send a message, answer tool approvals, read tool activity.
 * Accessible locators only (labels, roles); test ids only where the page
 * exposes no accessible name for a region.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class AgentChatPage {
  readonly page: Page;
  readonly agentPicker: Locator;
  readonly messageInput: Locator;
  readonly sendButton: Locator;
  readonly toolActivity: Locator;

  constructor(page: Page) {
    this.page = page;
    this.agentPicker = page.getByLabel("Agent", { exact: true });
    this.messageInput = page.getByLabel("Message");
    this.sendButton = page.getByRole("button", { name: "Send" });
    this.toolActivity = page.getByRole("list", { name: "Tool activity" });
  }

  async gotoProjectChat(projectId: string): Promise<void> {
    await this.page.goto(`/chat?projectId=${encodeURIComponent(projectId)}`, {
      waitUntil: "load",
    });
    await expect(this.page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
  }

  /**
   * Pick an agent. #1139 — no session exists yet: the page creates it on the
   * first send, for whichever agent is picked then (see {@link sendFirst}).
   */
  async pickAgent(agentKey: string): Promise<void> {
    await expect(this.agentPicker.locator(`option[value="${agentKey}"]`)).toHaveCount(1);
    await this.agentPicker.selectOption(agentKey);
    await expect(this.messageInput).toBeEnabled();
  }

  /**
   * Send the chat's first message and return the id of the session the send
   * created for `agentKey`. Matched on the agent, so a create for any other
   * agent can never satisfy the wait (seen on PR #255).
   */
  async sendFirst(text: string, agentKey: string): Promise<string> {
    const created = this.page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /\/api\/ai\/sessions$/.test(new URL(r.url()).pathname) &&
        r.status() === 201 &&
        (r.request().postDataJSON() as { agentKey?: string } | null)?.agentKey === agentKey,
    );
    await this.send(text);
    const res = await created;
    const body = (await res.json()) as { data: { session: { id: string; agentId: string } } };
    expect(body.data.session.agentId).toBeTruthy();
    return body.data.session.id;
  }

  async send(text: string): Promise<void> {
    await this.messageInput.fill(text);
    await this.sendButton.click();
  }

  /** One tool call's row in the live activity list, by the tool's name. */
  toolRow(toolName: string): Locator {
    return this.toolActivity.getByRole("listitem").filter({ hasText: toolName });
  }

  async approve(toolName: string): Promise<void> {
    const button = this.page.getByRole("button", { name: `Approve ${toolName}` });
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
  }

  assistantText(text: string): Locator {
    return this.page.getByText(text);
  }
}
