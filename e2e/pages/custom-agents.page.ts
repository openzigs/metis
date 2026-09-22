/**
 * Epic #260 — Custom Analyst Agents page objects.
 *
 * Covers two surfaces:
 *   - {@link AgentWizardPage} — the multi-step authoring wizard at
 *     `/workspaces/:id/agents/new` (Issue #84).
 *   - {@link CustomAgentsEnablementSection} — the per-project enablement card
 *     embedded in the project settings page `/projects/:id` (Issue #85).
 *
 * Both objects prefer accessible, role-based locators (heading / button /
 * textbox) and fall back to the `data-testid` hooks that ship with the UI
 * (see `ui/src/components/custom-agents/AgentAuthoringWizard.tsx` and
 * `ui/src/components/projects/custom-agents-enablement-card.tsx`). The testids
 * are part of the public test contract for these components.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/** Wizard step ids, in order. Mirrors the component's `STEPS` constant. */
export type WizardStep = "name" | "prompt" | "tools" | "model" | "playground";

/** Starter-template ids exposed by the template gallery (step 2). */
export type WizardTemplate = "requirements-analyst" | "risk-reviewer" | "doc-summarizer";

export class AgentWizardPage {
  readonly page: Page;
  readonly root: Locator;
  readonly heading: Locator;
  readonly nextButton: Locator;
  readonly backButton: Locator;

  // Step 1 — name + project
  readonly nameInput: Locator;
  readonly descriptionInput: Locator;
  readonly projectSelect: Locator;

  // Step 2 — prompt + template gallery
  readonly templateGallery: Locator;
  readonly promptInput: Locator;

  // Step 4 — model + reasoning
  readonly modelSelect: Locator;
  readonly reasoningSelect: Locator;

  // Step 5 — playground
  readonly playgroundInput: Locator;
  readonly playgroundRun: Locator;
  readonly playgroundOutput: Locator;
  readonly playgroundError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("agent-wizard-root");
    this.heading = page.getByRole("heading", { name: "New Custom Agent" });
    this.nextButton = page.getByTestId("wizard-next");
    this.backButton = page.getByTestId("wizard-back");

    this.nameInput = page.getByTestId("wizard-name-input");
    this.descriptionInput = page.getByTestId("wizard-description-input");
    this.projectSelect = page.getByTestId("wizard-project-select");

    this.templateGallery = page.getByTestId("wizard-template-gallery");
    this.promptInput = page.getByTestId("wizard-prompt-input");

    this.modelSelect = page.getByTestId("wizard-model-select");
    this.reasoningSelect = page.getByTestId("wizard-reasoning-select");

    this.playgroundInput = page.getByTestId("wizard-playground-input");
    this.playgroundRun = page.getByTestId("wizard-playground-run");
    this.playgroundOutput = page.getByTestId("wizard-playground-output");
    this.playgroundError = page.getByTestId("wizard-playground-error");
  }

  async goto(workspaceId: string): Promise<void> {
    await this.page.goto(`/workspaces/${workspaceId}/agents/new`, { waitUntil: "load" });
    await expect(this.root).toBeVisible({ timeout: 15_000 });
  }

  stepPanel(step: WizardStep): Locator {
    return this.page.getByTestId(`wizard-step-${step}`);
  }

  stepIndicator(step: WizardStep): Locator {
    return this.page.getByTestId(`wizard-step-indicator-${step}`);
  }

  templateButton(template: WizardTemplate): Locator {
    return this.page.getByTestId(`wizard-template-${template}`);
  }

  toolCheckbox(tool: string): Locator {
    return this.page.getByTestId(`wizard-tool-${tool}`);
  }

  /** Advance to the next step. The Next button is disabled until the current
   * step's validation passes, so Playwright auto-waits for it to be enabled. */
  async next(): Promise<void> {
    await this.nextButton.click();
  }

  async back(): Promise<void> {
    await this.backButton.click();
  }
}

export class CustomAgentsEnablementSection {
  readonly page: Page;
  readonly card: Locator;
  readonly heading: Locator;
  readonly empty: Locator;
  readonly error: Locator;

  constructor(page: Page) {
    this.page = page;
    this.card = page.getByTestId("custom-agents-enablement-card");
    this.heading = page.getByRole("heading", { name: "Custom agents" });
    this.empty = page.getByTestId("custom-agents-enablement-empty");
    this.error = page.getByTestId("custom-agents-enablement-error");
  }

  /** Navigate to the project settings page that hosts the enablement card. */
  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/settings`, { waitUntil: "load" });
    await expect(this.card).toBeVisible({ timeout: 15_000 });
  }

  row(agentId: string): Locator {
    return this.page.getByTestId(`ca-enablement-row-${agentId}`);
  }

  toggle(agentId: string): Locator {
    return this.page.getByTestId(`ca-enablement-toggle-${agentId}`);
  }
}
