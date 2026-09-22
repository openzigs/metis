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

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Workbench" });
    // `exact` matters: the header ProjectSwitcher is labelled
    // "Active project: <name>", which a substring match also selects.
    this.projectPicker = page.getByLabel("Active project", { exact: true });
    this.leftPanel = page.getByTestId("workbench-left-panel");
    this.centerPanel = page.getByTestId("workbench-center-panel");
    this.rightPanel = page.getByTestId("workbench-right-panel");
    this.chatInput = page.getByLabel("Message");
    this.sendButton = page.getByTestId("workbench-send");
    this.resetLayoutButton = page.getByTestId("workbench-reset-layout");
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

  async expectSessionStarted(): Promise<void> {
    // The chat center panel shows provider · model when a session is open.
    // "starting…" disappears once the session resolves.
    await expect(this.centerPanel.getByText("starting…")).not.toBeVisible({ timeout: 30_000 });
  }
}
