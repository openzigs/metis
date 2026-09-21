/**
 * Page object for the #235 generative-loop e2e (epic #209):
 * ambiguous input → clarifying questions → answers → persisted refined
 * requirement → refinement visible in the regenerated spec.
 *
 * Encapsulates both halves of the flow:
 *   - the UI surface (the project Analysis page) via accessible locators, so the
 *     test exercises the real authenticated browser path; and
 *   - the analysis/clarification API the page drives behind the scenes.
 *
 * The clarification rounds the offline harness produces are sourced from the
 * deterministic replay fixtures (#234), so this page object talks to the same
 * endpoints the UI calls (`/clarify`, `/agents/:key/regenerate`) and reads the
 * resulting snapshot back through `GET /api/analyses/:id`.
 */
import { expect, request, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type {
  ClarificationAnswer,
  ClarificationState,
  StructuredRequirements,
} from "../../server/src/lib/analysis/types/requirements.js";

export interface AnalysisSnapshotLite {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  requirements: Array<{ id: string; title: string; body: string }>;
}

export class ClarifyLoopPage {
  readonly page: Page;
  readonly heading: Locator;

  constructor(
    page: Page,
    private readonly apiBaseUrl: string,
    private readonly token: string,
  ) {
    this.page = page;
    // The Analysis config card renders this heading once the page loads.
    this.heading = page.getByRole("heading", { name: "Start a new analysis" });
  }

  /** Navigate the authenticated browser to the project's Analysis page (UI path). */
  async gotoAnalysis(projectId: string): Promise<void> {
    await this.page.goto(`/projects/${projectId}/analysis`);
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
  }

  private async api(): Promise<APIRequestContext> {
    return request.newContext({
      baseURL: this.apiBaseUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${this.token}` },
    });
  }

  /**
   * Start (or continue) a clarification dialog round. Returns the dialog state,
   * including the round's generated questions (ids are server-assigned).
   */
  async startClarification(
    projectId: string,
    analysisId: string,
    requirements: StructuredRequirements,
  ): Promise<ClarificationState> {
    const api = await this.api();
    try {
      const res = await api.post(`/api/projects/${projectId}/analyses/${analysisId}/clarify`, {
        data: { requirements },
      });
      expect(res.ok(), `start clarify failed: ${res.status()} ${await res.text()}`).toBe(true);
      const body = await res.json();
      return (body.data ?? body) as ClarificationState;
    } finally {
      await api.dispose();
    }
  }

  /**
   * Submit answers for the current round. The clarify route persists the
   * refined requirements to `Analysis.metadata` before responding.
   */
  async submitAnswers(
    projectId: string,
    analysisId: string,
    answers: ClarificationAnswer[],
    requirements: StructuredRequirements,
  ): Promise<{ state: ClarificationState; updatedRequirements: StructuredRequirements }> {
    const api = await this.api();
    try {
      const res = await api.post(`/api/projects/${projectId}/analyses/${analysisId}/clarify`, {
        data: { answers, requirements },
      });
      expect(res.ok(), `submit answers failed: ${res.status()} ${await res.text()}`).toBe(true);
      const body = await res.json();
      return (body.data ?? body) as {
        state: ClarificationState;
        updatedRequirements: StructuredRequirements;
      };
    } finally {
      await api.dispose();
    }
  }

  /** Read the durable dialog state the server persisted (rehydration path). */
  async getClarificationState(
    projectId: string,
    analysisId: string,
  ): Promise<ClarificationState | null> {
    const api = await this.api();
    try {
      const res = await api.get(`/api/projects/${projectId}/analyses/${analysisId}/clarify`);
      expect(res.ok()).toBe(true);
      const body = await res.json();
      return ((body.data ?? body).state ?? null) as ClarificationState | null;
    } finally {
      await api.dispose();
    }
  }

  /** Kick off a single-agent regenerate, which re-runs synthesis afterwards. */
  async regenerateAgent(analysisId: string, agentKey: string): Promise<void> {
    const api = await this.api();
    try {
      const res = await api.post(`/api/analyses/${analysisId}/agents/${agentKey}/regenerate`);
      expect(res.status(), `regenerate failed: ${res.status()} ${await res.text()}`).toBe(202);
    } finally {
      await api.dispose();
    }
  }

  /** Fetch the analysis snapshot (the generated/regenerated spec). */
  async getSnapshot(analysisId: string): Promise<AnalysisSnapshotLite> {
    const api = await this.api();
    try {
      const res = await api.get(`/api/analyses/${analysisId}`);
      expect(res.ok()).toBe(true);
      const body = await res.json();
      return (body.data ?? body) as AnalysisSnapshotLite;
    } finally {
      await api.dispose();
    }
  }

  /**
   * Poll the snapshot until `predicate` holds or the budget elapses. Used to
   * await the async regenerate → synthesis pipeline without sleeping blindly.
   */
  async waitForSnapshot(
    analysisId: string,
    predicate: (snap: AnalysisSnapshotLite) => boolean,
    opts: { attempts?: number; intervalMs?: number } = {},
  ): Promise<AnalysisSnapshotLite> {
    const attempts = opts.attempts ?? 60;
    const intervalMs = opts.intervalMs ?? 1000;
    let last: AnalysisSnapshotLite | null = null;
    for (let i = 0; i < attempts; i++) {
      last = await this.getSnapshot(analysisId);
      if (predicate(last)) return last;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `waitForSnapshot: predicate never held for ${analysisId} after ${attempts} attempts. ` +
        `Last snapshot: ${JSON.stringify(last)}`,
    );
  }
}
