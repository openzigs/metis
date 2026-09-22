/**
 * Inference-profile picker page object — Issue #127.
 *
 * Encapsulates the InferenceProfileCard rendered on the project Settings page
 * (`/projects/:id`). Uses accessible label locators + the card's data-testid
 * hooks (part of the test contract — see
 * `ui/src/components/projects/inference-profile-card.tsx`).
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class InferenceProfilePanel {
  readonly page: Page;
  readonly card: Locator;
  readonly arnInput: Locator;
  readonly modelInput: Locator;
  readonly costCenterInput: Locator;
  readonly environmentInput: Locator;
  readonly saveButton: Locator;
  readonly savedToast: Locator;
  readonly formError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.card = page.getByTestId("inference-profile-card");
    this.arnInput = page.getByTestId("inference-profile-arn");
    this.modelInput = page.getByTestId("inference-profile-model");
    this.costCenterInput = page.getByTestId("inference-profile-cost-center");
    this.environmentInput = page.getByTestId("inference-profile-environment");
    this.saveButton = page.getByTestId("inference-profile-save");
    this.savedToast = page.getByTestId("inference-profile-saved-toast");
    this.formError = page.getByTestId("inference-profile-form-error");
  }

  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/settings`);
    await expect(this.card).toBeVisible({ timeout: 15_000 });
  }

  async fillAndSave(arn: string, modelId: string): Promise<void> {
    await this.arnInput.fill(arn);
    await this.modelInput.fill(modelId);
    await this.saveButton.click();
  }
}
