/**
 * Page Object for the Workspace Settings page.
 *
 * Epic #759, Issue #767.
 * Route: /admin/workspaces/[id]/settings
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class WorkspaceSettingsPage {
  readonly page: Page;
  readonly heading: Locator;
  readonly nameInput: Locator;
  readonly saveButton: Locator;
  readonly membersTitle: Locator;
  readonly dangerZoneTitle: Locator;
  readonly membersSection: Locator;
  readonly dangerZone: Locator;
  readonly deleteButton: Locator;
  readonly transferButton: Locator;
  readonly confirmDeleteButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Workspace Settings" });
    // `exact` matters: a workspace whose NAME contains "name" would otherwise
    // make the switcher button match this locator too.
    this.nameInput = page.getByLabel("Name", { exact: true });
    this.saveButton = page.getByRole("button", { name: "Save changes" });
    // shadcn's CardTitle renders a <div>, not a heading element (see
    // packages/ui-kit/src/components/card.tsx).
    this.membersTitle = page.getByText("Members", { exact: true });
    this.dangerZoneTitle = page.getByText("Danger Zone", { exact: true });
    this.membersSection = this.membersTitle.locator("..");
    this.dangerZone = this.dangerZoneTitle.locator("..");
    this.deleteButton = page.getByRole("button", { name: "Delete" }).first();
    this.transferButton = page.getByRole("button", { name: "Transfer" });
    this.confirmDeleteButton = page.getByRole("button", { name: "Delete workspace" });
  }

  async goto(workspaceId: string): Promise<void> {
    await this.page.goto(`/admin/workspaces/${workspaceId}/settings`);
    await expect(this.heading).toBeVisible();
  }

  /** Update the workspace name and save. */
  async updateName(newName: string): Promise<void> {
    await this.nameInput.clear();
    await this.nameInput.fill(newName);
    // Wait for the PATCH to land: the caller usually reloads straight after,
    // which otherwise races the in-flight request.
    await Promise.all([
      this.page.waitForResponse(
        (res) =>
          /\/api\/workspaces\/[^/]+$/.test(new URL(res.url()).pathname) &&
          res.request().method() === "PATCH",
        { timeout: 15_000 },
      ),
      this.saveButton.click(),
    ]);
  }

  /** Get a member row by display name. */
  getMemberRow(displayName: string): Locator {
    return this.page.locator("div").filter({ hasText: displayName }).first();
  }

  /** Get the role select for a member. */
  getMemberRoleSelect(displayName: string): Locator {
    return this.getMemberRow(displayName).getByRole("combobox");
  }

  /** Get the remove button for a member. */
  getMemberRemoveButton(displayName: string): Locator {
    return this.page.getByRole("button", { name: `Remove ${displayName}` });
  }

  /** Click delete workspace and confirm in the dialog. */
  async deleteWorkspace(): Promise<void> {
    await this.deleteButton.click();
    await expect(this.confirmDeleteButton).toBeVisible();
    await this.confirmDeleteButton.click();
  }

  /** Assert the save button is disabled (no changes made). */
  async expectSaveDisabled(): Promise<void> {
    await expect(this.saveButton).toBeDisabled();
  }

  /** Assert workspace not found state. */
  async expectNotFound(): Promise<void> {
    await expect(this.page.getByText("Workspace not found")).toBeVisible();
  }
}
