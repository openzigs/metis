/**
 * Workbench page object for the e2e suite.
 *
 * Encapsulates the project picker, three-pane layout, and chat interaction
 * on `/workbench`. Uses accessible locators and data-testid attributes that
 * are part of the public test contract (see
 * `ui/src/app/(authed)/workbench/page.tsx`).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class WorkbenchPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly projectPicker: Locator;
  readonly leftPanel: Locator;
  readonly centerPanel: Locator;
  readonly rightPanel: Locator;
  readonly chatInput: Locator;
  readonly sendButton: Locator;
  readonly resetLayoutButton: Locator;
  /** #584 — the Documents panel's own scroll container (the virtualiser's viewport). */
  readonly docScroll: Locator;
  /** #584 — the tree rows currently mounted (the virtualiser renders only these). */
  readonly docRows: Locator;
  /** #584 — the divider between the Documents and Chat panes. */
  readonly leftSeparator: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Workbench", exact: true });
    // `exact` matters: the header ProjectSwitcher is labelled
    // "Active project: <name>", which a substring match also selects.
    this.projectPicker = page.getByLabel("Active project", { exact: true });
    this.leftPanel = page.getByTestId("workbench-left-panel");
    this.centerPanel = page.getByTestId("workbench-center-panel");
    this.rightPanel = page.getByTestId("workbench-right-panel");
    this.chatInput = page.getByLabel("Message");
    this.sendButton = page.getByTestId("workbench-send");
    this.resetLayoutButton = page.getByTestId("workbench-reset-layout");
    this.docScroll = page.getByTestId("workbench-doc-scroll");
    this.docRows = this.docScroll.getByRole("treeitem");
    this.leftSeparator = page.getByRole("separator", { name: "Resize documents panel" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/workbench", { waitUntil: "load" });
    await expect(this.heading).toBeVisible();
  }

  /** Returns the <option> elements inside the project picker (excluding "— none —"). */
  projectOptions(): Locator {
    return this.projectPicker.locator("option:not([value=''])");
  }

  async selectProject(projectName: string): Promise<void> {
    await this.projectPicker.selectOption({ label: projectName });
  }

  async expectProjectCount(count: number): Promise<void> {
    await expect(this.projectOptions()).toHaveCount(count, { timeout: 15_000 });
  }

  async expectEmptyDocumentsState(): Promise<void> {
    await expect(this.leftPanel.getByText("No documents yet")).toBeVisible({ timeout: 10_000 });
  }

  async expectChooseProjectPrompt(): Promise<void> {
    await expect(this.leftPanel.getByText("Choose a project")).toBeVisible({ timeout: 10_000 });
  }

  /**
   * #361 — the session is now created on the first send, not on page load, so
   * "ready" means the composer is usable: the input is enabled and the header
   * reads "new session" (or provider · model once a session exists). The old
   * check waited for a "starting…" label that no longer exists, so it passed
   * without asserting anything.
   */
  async expectChatReady(): Promise<void> {
    await expect(this.centerPanel.getByTestId("workbench-input")).toBeEnabled({ timeout: 30_000 });
    await expect(this.centerPanel.getByText(/new session| · /).first()).toBeVisible({
      timeout: 30_000,
    });
  }
}
