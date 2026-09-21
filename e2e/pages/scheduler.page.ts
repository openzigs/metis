/**
 * Scheduler page object.
 *
 * The METIS UI splits "scheduled jobs" (recurring, cron-driven) onto the
 * `/scheduler` page, and individual task executions onto `/tasks`. Issue
 * #144 calls this surface the "Tasks view"; the scheduled-job list at
 * `/scheduler` is the user-visible row that exposes the create/pause/resume/
 * cancel controls the test exercises.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export class SchedulerPage {
  readonly page: Page;
  readonly heading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Scheduler" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/scheduler");
    await expect(this.heading).toBeVisible();
  }

  jobRow(jobId: string): Locator {
    return this.page.getByTestId(`job-row-${jobId}`);
  }

  async expectJobVisible(jobId: string): Promise<void> {
    await expect(this.jobRow(jobId)).toBeVisible({ timeout: 15_000 });
  }

  async pauseJob(jobId: string): Promise<void> {
    await this.page.getByTestId(`pause-${jobId}`).click();
    await expect(this.page.getByTestId(`resume-${jobId}`)).toBeVisible({ timeout: 10_000 });
  }
}

export class TasksPage {
  readonly page: Page;
  readonly heading: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole("heading", { name: "Tasks" });
  }

  async goto(): Promise<void> {
    await this.page.goto("/tasks");
    await expect(this.heading).toBeVisible();
  }
}
