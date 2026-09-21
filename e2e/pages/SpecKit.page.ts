/**
 * SpecKit page object — Epic #34 (collaboration mounts) / Epic #193.
 *
 * Encapsulates the `/projects/:id/spec-kit` workspace where the collaboration
 * components were mounted in commit 38265fb:
 *   - PresenceAvatars in the selected-artifact header
 *     (artifactType "spec-kit-artifact", artifactId `${projectId}:${name}`).
 *   - A "Comments" toggle opening the CommentPanel scoped to that artifact.
 *
 * Selectors prefer the stable `data-testid`s already present on the page
 * (e.g. `spec-kit-comments-button`, `spec-kit-artifact-<name>`) and fall back
 * to accessible role/name locators.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class SpecKitPage {
  readonly page: Page;
  /** The three-column root container. */
  readonly root: Locator;
  /** The "Comments" toggle in the artifact header. */
  readonly commentsButton: Locator;
  /** Spec Kit Mode enable/disable switch. */
  readonly enableToggle: Locator;
  /** The project-level tab bar (source of truth: project-tabs.tsx). */
  readonly tabs: Locator;
  /**
   * Phase 4 (#371/#377) — the relocated primary "Spec Kit" tab. It sits as a
   * direct link in the tab bar BESIDE Analysis, not inside the "Docs" group
   * dropdown. We scope the locator to the tab bar so it never matches the
   * in-page `<h1>Spec Kit</h1>` heading.
   */
  readonly specKitTab: Locator;
  /** The BA/PM "author the intent" subtitle on the page (#372). */
  readonly subtitle: Locator;
  /** The BA/PM onboarding empty-state card shown before any artifact exists. */
  readonly onboarding: Locator;

  constructor(page: Page) {
    this.page = page;
    this.root = page.getByTestId("spec-kit-root");
    this.commentsButton = page.getByTestId("spec-kit-comments-button");
    this.enableToggle = page.getByTestId("spec-kit-toggle");
    this.tabs = page.getByTestId("project-tabs");
    this.specKitTab = this.tabs.getByRole("link", { name: "Spec Kit", exact: true });
    this.subtitle = page.getByTestId("spec-kit-subtitle");
    this.onboarding = page.getByTestId("spec-kit-onboarding");
  }

  /**
   * Navigate to the spec-kit workspace for a project and wait for it to render.
   */
  async goto(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/spec-kit`, { waitUntil: "load" });
    await expect(this.root).toBeVisible({ timeout: 30_000 });
  }

  /**
   * Phase 4 (#377) — reach the Spec Kit workspace the way a BA/PM does: open
   * the project, then click the primary "Spec Kit" tab beside Analysis. This
   * exercises the NEW placement (out of the "Docs" group) rather than a direct
   * URL hit.
   */
  async openViaPrimaryTab(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}`, { waitUntil: "load" });
    await expect(this.tabs).toBeVisible({ timeout: 30_000 });
    await this.specKitTab.click();
    await this.page.waitForURL((url) => url.pathname.endsWith("/spec-kit"), { timeout: 30_000 });
    await expect(this.root).toBeVisible({ timeout: 30_000 });
  }

  /** Toggle Spec Kit Mode on (idempotent-ish — only clicks when currently off). */
  async enable(): Promise<void> {
    if ((await this.enableToggle.getAttribute("aria-checked")) !== "true") {
      await this.enableToggle.click();
      await expect(this.enableToggle).toHaveAttribute("aria-checked", "true");
    }
  }

  /**
   * Select an artifact in the left-hand tree by its file name (e.g. "spec.md").
   * Changing the selection re-targets both the PresenceAvatars room and the
   * CommentPanel scope.
   */
  async selectArtifact(name: string): Promise<void> {
    await this.page.getByTestId(`spec-kit-artifact-${name}`).click();
  }

  /**
   * Open the comment panel for the currently-selected artifact.
   */
  async openComments(): Promise<void> {
    await this.commentsButton.click();
  }

  /**
   * The presence avatar bar container in the artifact header.
   * (PresenceAvatars renders `aria-label="N user(s) viewing"` once populated.)
   */
  presenceContainer(): Locator {
    return this.page.locator('[aria-label$="user(s) viewing"]');
  }
}
