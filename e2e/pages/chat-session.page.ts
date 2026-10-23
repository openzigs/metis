/**
 * The Chat page opened on one conversation (`/chat?sessionId=…`), as a chat
 * link or the Sessions page's Resume opens it. Accessible locators only.
 */
import { type Locator, type Page } from "@playwright/test";

export class ChatSessionPage {
  readonly page: Page;
  /** The conversation's transcript (`role="log"`, "Chat transcript"). */
  readonly transcript: Locator;
  /**
   * #1412 — the notice a link to a chat that cannot be opened shows. Filtered
   * by text: Next.js mounts its own route announcer with `role="alert"` too.
   */
  readonly notFound: Locator;

  constructor(page: Page) {
    this.page = page;
    this.transcript = page.getByRole("log", { name: "Chat transcript" });
    this.notFound = page.getByRole("alert").filter({ hasText: "Chat not found" });
  }

  async open(sessionId: string): Promise<void> {
    await this.page.goto(`/chat?sessionId=${encodeURIComponent(sessionId)}`, {
      waitUntil: "load",
    });
  }

  /** A message of the conversation, by its text. */
  message(text: string): Locator {
    return this.transcript.getByText(text);
  }
}
