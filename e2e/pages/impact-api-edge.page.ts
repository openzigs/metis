/**
 * Impact result "API-edge impact" page object — #2115, #2120, #2127.
 *
 * The cross-project block of one project's section on `/impact-analyses/:id`:
 * the consumer row (a project that calls this project's API, which the change
 * touched), the low-confidence banner on a consumer's card, and the lines that
 * say the API-edge read failed or is still pending.
 *
 * Locators are role- and text-first where the markup exposes them, and fall
 * back to the components' stable `data-testid` hooks for structure.
 */
import { type Locator, type Page } from "@playwright/test";

export class ImpactApiEdgePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async goto(analysisId: string): Promise<void> {
    await this.page.goto(`/impact-analyses/${analysisId}`, { waitUntil: "load" });
  }

  /** One project's section of the result. */
  section(projectId: string): Locator {
    return this.page.locator(
      `[data-testid="project-impact-section"][data-project-id="${projectId}"]`,
    );
  }

  /** The projects that call this project's API, as listed in its section. */
  consumerRows(projectId: string): Locator {
    return this.section(projectId).getByTestId("api-consumer-row");
  }

  apiSurfaceFiles(projectId: string): Locator {
    return this.consumerRows(projectId).getByTestId("api-surface-files");
  }

  citingMethods(projectId: string): Locator {
    return this.consumerRows(projectId).getByTestId("api-citing-method");
  }

  /** One change's card in a project's section, by the change's title. */
  card(projectId: string, changeTitle: string): Locator {
    return this.section(projectId)
      .getByTestId("changed-requirement-group")
      .filter({ hasText: changeTitle });
  }

  /** The low-confidence banner on one change's card. */
  untouchedBanner(projectId: string, changeTitle: string): Locator {
    return this.card(projectId, changeTitle).getByRole("status").filter({
      hasText: "Low-confidence match",
    });
  }

  /** "No other projects in this workspace are affected by this change." */
  noImpact(projectId: string): Locator {
    return this.section(projectId).getByTestId("cross-project-impact-empty");
  }

  apiEdgeUnavailable(projectId: string): Locator {
    return this.section(projectId).getByTestId("api-edge-impact-error");
  }

  apiEdgeChecking(projectId: string): Locator {
    return this.section(projectId).getByTestId("api-edge-impact-loading");
  }
}
