/**
 * Chat page object for the prompt/context compression e2e suite.
 *
 * Encapsulates the workbench chat pane interactions — sending messages,
 * waiting for responses, and inspecting the response stream. Uses
 * accessible locators so DOM changes don't break tests.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class ChatPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly projectPicker: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly messageList: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Workbench" });
    // `exact` matters: the header ProjectSwitcher is labelled
    // "Active project: <name>", which a substring match also selects.
    this.projectPicker = page.getByLabel("Active project", { exact: true });
    this.chatInput = page.getByLabel("Message");
    this.sendButton = page.getByTestId("workbench-send");
    this.messageList = page.getByTestId("workbench-center-panel");
  }

  async goto(): Promise<void> {
    await this.page.goto("/workbench", { waitUntil: "load" });
    await expect(this.heading).toBeVisible();
  }

  async selectProject(name: string): Promise<void> {
    await this.projectPicker.selectOption({ label: name });
  }

  /** Wait for the session to be ready (no "starting…" indicator). */
  async waitForSessionReady(): Promise<void> {
    await expect(this.messageList.getByText("starting…")).not.toBeVisible({ timeout: 30_000 });
  }

  /** Send a chat message and wait for a response to appear. */
  async sendMessage(text: string): Promise<void> {
    await this.chatInput.fill(text);
    await this.sendButton.click();
  }

  /** Get the last assistant response in the chat. */
  lastAssistantMessage(): Locator {
    return this.messageList.locator('[data-role="assistant"]').last();
  }

  /** Wait for a new assistant response to appear in the message list. */
  async waitForResponse(opts?: { timeout?: number }): Promise<string> {
    const timeout = opts?.timeout ?? 60_000;
    const msg = this.lastAssistantMessage();
    await expect(msg).toBeVisible({ timeout });
    // Wait until the message has content (streaming has completed)
    await expect(msg).not.toHaveText("", { timeout });
    return (await msg.textContent()) ?? "";
  }

  /** Count the number of assistant messages visible in the chat. */
  async assistantMessageCount(): Promise<number> {
    return this.messageList.locator('[data-role="assistant"]').count();
  }
}
