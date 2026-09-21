/**
 * Regression tests for the Test Coverage page crash (fix/test-coverage-page-crash).
 *
 * The page used to read `report.coveragePercentage` and call `.toFixed(1)` on
 * it, but the API actually emits the percentage as `summary.coveragePct`. The
 * mismatched field was always `undefined`, so `.toFixed` threw and crashed the
 * entire project view into the error boundary ("Cannot read properties of
 * undefined (reading 'toFixed')") — on the first run AND on every reload while
 * a run existed.
 *
 * These tests feed the page the REAL API payload shape (`summary.coveragePct`)
 * and assert the page renders without throwing for:
 *   - a present value (42.5 → "42.5%")
 *   - a zero value (0 → "0.0%")  ← the empty-run case the bug report hit
 *   - a missing/undefined summary (→ safe "0.0%" fallback, no crash)
 *
 * They FAIL against the old `report.coveragePercentage.toFixed(1)` code
 * (undefined.toFixed throws) and PASS after the fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "p1" }),
}));

const { socketStub, api, downloadBlob } = vi.hoisted(() => ({
  socketStub: { on: vi.fn(), off: vi.fn() },
  api: {
    listImports: vi.fn(),
    uploadImport: vi.fn(),
    pasteImport: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    createRun: vi.fn(),
    getReport: vi.fn(),
    getBudget: vi.fn(),
    overrideMapping: vi.fn(),
    updateSuggestion: vi.fn(),
    exportRun: vi.fn(),
    pullFromConnector: vi.fn(),
  },
  downloadBlob: vi.fn(),
}));

vi.mock("@/lib/socket-client", () => ({
  useSocket: () => socketStub,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
    const size = opts.estimateSize();
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
    };
  },
}));

vi.mock("@/lib/test-coverage-api", () => ({
  testCoverageApi: api,
  downloadBlob,
}));

import TestCoveragePage from "@/app/(authed)/projects/[id]/test-coverage/page";

const NOW = new Date().toISOString();
const RUN = {
  id: "run-1",
  projectId: "p1",
  status: "succeeded",
  triggeredById: null,
  modelTag: null,
  createdAt: NOW,
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TestCoveragePage />
    </QueryClientProvider>,
  );
}

/** Build a report payload using the REAL server field name (`summary.coveragePct`). */
function reportWithSummary(summary: unknown) {
  return {
    run: RUN,
    summary,
    mappings: [],
    gaps: [],
    suggestions: [],
  };
}

beforeEach(() => {
  Object.values(api).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  socketStub.on.mockReset();
  socketStub.off.mockReset();
  api.listImports.mockResolvedValue([]);
  api.listRuns.mockResolvedValue([RUN]);
  api.getBudget.mockResolvedValue({ usedCents: 0, limitCents: 100, remainingCents: 100 });
});

describe("TestCoveragePage — coveragePct crash regression", () => {
  it("renders the coverage % from summary.coveragePct when present", async () => {
    api.getReport.mockResolvedValue(
      reportWithSummary({ total: 2, covered: 1, gaps: 1, suggestions: 0, coveragePct: 42.5 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tc-coverage-pct")).toHaveTextContent("42.5%"));
  });

  it("renders 0.0% for a zero-coverage (empty) run without crashing", async () => {
    api.getReport.mockResolvedValue(
      reportWithSummary({ total: 46, covered: 0, gaps: 46, suggestions: 0, coveragePct: 0 }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tc-coverage-pct")).toHaveTextContent("0.0%"));
    // Page rendered fully (no error boundary) — the summary card is present.
    expect(screen.getByTestId("tc-summary")).toBeInTheDocument();
  });

  it("falls back to 0.0% (no throw) when the summary / coveragePct is missing", async () => {
    // Simulates a malformed or partial payload: no `summary` at all.
    api.getReport.mockResolvedValue(reportWithSummary(undefined));
    renderPage();
    await waitFor(() => expect(screen.getByTestId("tc-coverage-pct")).toHaveTextContent("0.0%"));
    expect(screen.getByTestId("tc-summary")).toBeInTheDocument();
  });

  it("does not render NaN/undefined when coveragePct is explicitly null", async () => {
    api.getReport.mockResolvedValue(
      reportWithSummary({ total: 0, covered: 0, gaps: 0, suggestions: 0, coveragePct: null }),
    );
    renderPage();
    const el = await screen.findByTestId("tc-coverage-pct");
    expect(el.textContent ?? "").not.toMatch(/NaN|undefined/);
    expect(el).toHaveTextContent("0.0%");
  });
});
