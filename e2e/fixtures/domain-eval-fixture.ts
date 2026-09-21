/**
 * Epic #803 (Epic 09) — Domain Eval fixture for the leaderboard "Domain Eval"
 * tab e2e suite (#807).
 *
 * The Domain Eval tab is file-backed: the page reads
 *   GET /api/eval/domain/runs?days=N   → { success, data: { runs: [summary] } }
 *   GET /api/eval/domain/runs/:id      → { success, data: { run: <detail> } }
 * which stream committed `eval-results/<runId>.json` envelopes. A real nightly
 * run only writes a single envelope, which is not enough to exercise the
 * trend chart (needs ≥2 runs), the drift badge, or a rich per-field diff.
 *
 * So instead of depending on the nightly job we intercept the read API with
 * `page.route(...)` and serve a deterministic, hand-built corpus. The shapes
 * mirror the shared `DomainEvalRun*` schemas and the REAL server envelope
 * (note the detail `{ run }` wrapper) so the tests stay faithful to production.
 */
import type { Page, Route } from "@playwright/test";

export interface DomainMatch {
  expectedId: string | null;
  predictedId: string | null;
  titleSimilarity: number;
  rougeL: number;
  confidence: number | null;
}

export interface DomainRequirement {
  id: string;
  type: string;
  title: string;
  description: string;
  priority: string;
  confidence?: number;
}

export interface DomainItemResult {
  itemId: string;
  docType: "prd" | "brd" | "user-story";
  title: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  meanRougeL: number;
  matches: DomainMatch[];
  expected: DomainRequirement[];
  predicted: DomainRequirement[];
}

export interface DomainCalibrationBin {
  bucket: string;
  lowerBound: number;
  upperBound: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
}

export interface DomainDrift {
  previousF1: number | null;
  deltaF1: number | null;
  thresholdPct: number;
  alert: boolean;
  reason: string;
}

export interface DomainEvalRunSummary {
  runId: string;
  schemaVersion: number;
  model: string;
  startedAt: string;
  completedAt: string;
  itemCount: number;
  corpusPrecision: number;
  corpusRecall: number;
  corpusF1: number;
  meanRougeL: number;
  totalTokens: number;
  totalCostCents: number;
  commit: string | null;
  drift: DomainDrift;
  driftAlert: boolean;
}

export interface DomainEvalRunDetail extends Omit<DomainEvalRunSummary, "driftAlert"> {
  calibration: DomainCalibrationBin[];
  items: DomainItemResult[];
}

// ---------------------------------------------------------------------------
// Deterministic corpus
// ---------------------------------------------------------------------------

/** A healthy run (no drift). */
export const RUN_HEALTHY_ID = "2026-04-01T00-00-00-000Z";
/** A second healthy run — gives the trend chart its ≥2 points. */
export const RUN_IMPROVED_ID = "2026-05-01T00-00-00-000Z";
/** The regression run that breached the drift threshold. */
export const RUN_DRIFT_ID = "2026-06-01T00-00-00-000Z";

/** Corpus item that produces matched + missed + hallucinated diff rows. */
export const ITEM_AUTH_ID = "prd-01-auth-portal";
/** Corpus item that produces a clean, fully-matched diff. */
export const ITEM_CHECKOUT_ID = "prd-02-checkout";

function summary(
  overrides: Partial<DomainEvalRunSummary> & Pick<DomainEvalRunSummary, "runId" | "startedAt">,
): DomainEvalRunSummary {
  const drift: DomainDrift = overrides.drift ?? {
    previousF1: null,
    deltaF1: null,
    thresholdPct: 0.05,
    alert: false,
    reason: "OK",
  };
  return {
    schemaVersion: 1,
    model: "offline-stub",
    completedAt: overrides.startedAt,
    itemCount: 2,
    corpusPrecision: 0.85,
    corpusRecall: 0.85,
    corpusF1: 0.85,
    meanRougeL: 0.8,
    totalTokens: 1234,
    totalCostCents: 0,
    commit: "abc1234",
    driftAlert: drift.alert,
    ...overrides,
    drift,
  };
}

export const RUN_SUMMARIES: DomainEvalRunSummary[] = [
  summary({
    runId: RUN_DRIFT_ID,
    startedAt: "2026-06-01T00:00:00.000Z",
    corpusPrecision: 0.7,
    corpusRecall: 0.72,
    corpusF1: 0.71,
    meanRougeL: 0.66,
    drift: {
      previousF1: 0.9,
      deltaF1: -0.19,
      thresholdPct: 0.05,
      alert: true,
      reason: "F1 dropped 19% week-over-week",
    },
  }),
  summary({
    runId: RUN_IMPROVED_ID,
    startedAt: "2026-05-01T00:00:00.000Z",
    corpusPrecision: 0.9,
    corpusRecall: 0.9,
    corpusF1: 0.9,
    meanRougeL: 0.84,
  }),
  summary({
    runId: RUN_HEALTHY_ID,
    startedAt: "2026-04-01T00:00:00.000Z",
    corpusPrecision: 0.82,
    corpusRecall: 0.82,
    corpusF1: 0.82,
    meanRougeL: 0.79,
  }),
];

const AUTH_ITEM: DomainItemResult = {
  itemId: ITEM_AUTH_ID,
  docType: "prd",
  title: "Auth Portal",
  truePositives: 1,
  falsePositives: 1,
  falseNegatives: 1,
  precision: 0.5,
  recall: 0.5,
  f1: 0.5,
  meanRougeL: 0.8,
  expected: [
    {
      id: "R1",
      type: "feature",
      title: "User login",
      description: "Users can log in with email and password.",
      priority: "high",
    },
    {
      id: "R2",
      type: "feature",
      title: "Password reset",
      description: "Users can reset their password via an emailed link.",
      priority: "medium",
    },
  ],
  predicted: [
    {
      id: "P1",
      type: "feature",
      title: "User login",
      description: "User logs in using an email address and a password.",
      priority: "medium",
      confidence: 0.92,
    },
    {
      id: "P3",
      type: "feature",
      title: "Rate limiting",
      description: "Throttle repeated failed login attempts.",
      priority: "low",
      confidence: 0.41,
    },
  ],
  matches: [
    // Matched pair — title identical, but priority + description differ so the
    // per-field diff highlights the changed cells.
    { expectedId: "R1", predictedId: "P1", titleSimilarity: 0.95, rougeL: 0.8, confidence: 0.92 },
    // Missed golden requirement (false negative).
    { expectedId: "R2", predictedId: null, titleSimilarity: 0, rougeL: 0, confidence: null },
    // Hallucinated prediction (false positive).
    { expectedId: null, predictedId: "P3", titleSimilarity: 0, rougeL: 0, confidence: 0.41 },
  ],
};

const CHECKOUT_ITEM: DomainItemResult = {
  itemId: ITEM_CHECKOUT_ID,
  docType: "prd",
  title: "Checkout Flow",
  truePositives: 1,
  falsePositives: 0,
  falseNegatives: 0,
  precision: 1,
  recall: 1,
  f1: 1,
  meanRougeL: 0.95,
  expected: [
    {
      id: "R1",
      type: "feature",
      title: "Place order",
      description: "A signed-in user can place an order from the cart.",
      priority: "critical",
    },
  ],
  predicted: [
    {
      id: "P1",
      type: "feature",
      title: "Place order",
      description: "A signed-in user can place an order from the cart.",
      priority: "critical",
      confidence: 0.88,
    },
  ],
  matches: [
    { expectedId: "R1", predictedId: "P1", titleSimilarity: 1, rougeL: 0.95, confidence: 0.88 },
  ],
};

export const RUN_DRIFT_DETAIL: DomainEvalRunDetail = {
  runId: RUN_DRIFT_ID,
  schemaVersion: 1,
  model: "offline-stub",
  startedAt: "2026-06-01T00:00:00.000Z",
  completedAt: "2026-06-01T00:00:00.000Z",
  itemCount: 2,
  corpusPrecision: 0.7,
  corpusRecall: 0.72,
  corpusF1: 0.71,
  meanRougeL: 0.66,
  totalTokens: 1234,
  totalCostCents: 0,
  commit: "abc1234",
  drift: {
    previousF1: 0.9,
    deltaF1: -0.19,
    thresholdPct: 0.05,
    alert: true,
    reason: "F1 dropped 19% week-over-week",
  },
  calibration: [
    {
      bucket: "0.4–0.5",
      lowerBound: 0.4,
      upperBound: 0.5,
      count: 1,
      meanConfidence: 0.41,
      accuracy: 0,
    },
    {
      bucket: "0.8–0.9",
      lowerBound: 0.8,
      upperBound: 0.9,
      count: 1,
      meanConfidence: 0.88,
      accuracy: 1,
    },
    {
      bucket: "0.9–1.0",
      lowerBound: 0.9,
      upperBound: 1,
      count: 1,
      meanConfidence: 0.92,
      accuracy: 1,
    },
    // An empty bin — the panel filters `count > 0` so this must NOT render.
    {
      bucket: "0.0–0.1",
      lowerBound: 0,
      upperBound: 0.1,
      count: 0,
      meanConfidence: 0,
      accuracy: 0,
    },
  ],
  items: [AUTH_ITEM, CHECKOUT_ITEM],
};

export const RUN_DETAILS: Record<string, DomainEvalRunDetail> = {
  [RUN_DRIFT_ID]: RUN_DRIFT_DETAIL,
};

// ---------------------------------------------------------------------------
// Route interception
// ---------------------------------------------------------------------------

export interface MockDomainEvalOptions {
  /** Run summaries returned by the list endpoint. Defaults to {@link RUN_SUMMARIES}. */
  runs?: DomainEvalRunSummary[];
  /** Detail envelopes keyed by runId. Defaults to {@link RUN_DETAILS}. */
  details?: Record<string, DomainEvalRunDetail>;
  /** When set, the list endpoint fails with this status to exercise the error state. */
  listStatus?: number;
}

function jsonBody(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

/**
 * Intercept the Domain Eval read API for the current page. The list and
 * detail matchers are mutually exclusive regexes — `…/runs` (optionally with a
 * query string) for the list, `…/runs/<id>` for the detail — so registration
 * order does not matter and no `route.fallback()` chaining is required.
 */
export async function mockDomainEvalApi(
  page: Page,
  options: MockDomainEvalOptions = {},
): Promise<void> {
  const runs = options.runs ?? RUN_SUMMARIES;
  const details = options.details ?? RUN_DETAILS;

  // Detail: GET /api/eval/domain/runs/<id>
  await page.route(/\/api\/eval\/domain\/runs\/[^/?]+$/, async (route: Route) => {
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const detail = details[id];
    if (!detail) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: { code: "DOMAIN_EVAL_RUN_NOT_FOUND", message: `run ${id} not found` },
        }),
      });
    }
    // The real server wraps the detail in `{ run }`.
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ run: detail }),
    });
  });

  // List: GET /api/eval/domain/runs?days=N
  await page.route(/\/api\/eval\/domain\/runs(\?.*)?$/, async (route: Route) => {
    if (options.listStatus && options.listStatus >= 400) {
      return route.fulfill({
        status: options.listStatus,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          error: { code: "INTERNAL", message: "boom" },
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: jsonBody({ runs }),
    });
  });
}
