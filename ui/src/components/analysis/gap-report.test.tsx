/**
 * Gap report component tests — Issue #742 (Epic #728).
 *
 * Covers the rendered states: a code-grounded card (cited current implementation
 * + gap finding + effort/coverage/verification badges), the honest no-evidence
 * state, the "unestimated" effort fallback, the disabled/no-fetch guard, and the
 * load-error state. Only `analysisApi.getGapReport` is mocked — the rest of the
 * analysis-api module (e.g. `formatCodeCitationLocator`, used by CodeCitation) is
 * kept real so the citation locator renders as in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GapReport as TGapReport } from "@metis/shared";

const getGapReport = vi.fn();
const exportAnalysisReport = vi.fn();
vi.mock("@/lib/analysis-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      getGapReport: (...args: unknown[]) => getGapReport(...args),
      exportAnalysisReport: (...args: unknown[]) => exportAnalysisReport(...args),
    },
  };
});

const triggerDownload = vi.fn();
vi.mock("@/lib/plugins-api", () => ({
  triggerDownload: (...args: unknown[]) => triggerDownload(...args),
}));

import { GapReport } from "./gap-report";

const REPORT: TGapReport = {
  analysisId: "an-1",
  projectId: "proj-1",
  requirements: [
    {
      requirementId: "req-1",
      title: "Users can log in",
      body: "Users authenticate with email + password.",
      priority: "high",
      coverage: "grounded_in_code",
      verdict: "gap-confirmed",
      storyPoints: 5,
      verificationStatus: "confirmed",
      currentImplementation: {
        hasEvidence: true,
        citations: [{ filePath: "server/src/auth.ts", startLine: 10, endLine: 20 }],
        citedFindingCount: 1,
      },
      gapFindings: [
        {
          id: "f-1",
          title: "No account lockout",
          body: "auth.ts logs in but has no throttle; add attempt counting.",
          severity: "high",
          verificationStatus: "confirmed",
          verdict: "gap-confirmed",
          citations: [{ filePath: "server/src/auth.ts", startLine: 10, endLine: 20 }],
        },
      ],
      unverifiedFindings: [],
      noEvidence: false,
    },
    {
      requirementId: "req-2",
      title: "Password reset",
      body: "Users can reset a forgotten password.",
      priority: "medium",
      coverage: "no_evidence",
      // Issue #773 — the requirement whose retrieval FAILED: no code evidence, but
      // the analysis never established that anything is missing either.
      verdict: "could-not-verify",
      storyPoints: null,
      verificationStatus: "could-not-verify",
      currentImplementation: { hasEvidence: false, citations: [], citedFindingCount: 0 },
      gapFindings: [],
      unverifiedFindings: [
        {
          id: "f-2",
          title: "Could not verify: Password reset",
          body: "Searches for reset/token flows returned no usable results.",
          severity: "info",
          verificationStatus: "could-not-verify",
          verdict: "could-not-verify",
          citations: [],
        },
      ],
      noEvidence: true,
    },
  ],
  retrieval: {
    successfulSearches: 1,
    failedSearches: 5,
    erroredCalls: 5,
    totalCalls: 6,
    requirementCount: 2,
    starved: false,
    degraded: true,
    searchedScope: [
      { tool: "search_code_symbols", query: "password reset", hit: false, errored: true },
      { tool: "search_code_graph", query: "login", hit: true },
    ],
  },
};

function renderPanel(enabled = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <GapReport projectId="proj-1" analysisId="an-1" enabled={enabled} />
    </QueryClientProvider>,
  );
}

describe("GapReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getGapReport.mockResolvedValue(REPORT);
  });
  afterEach(() => cleanup());

  it("renders nothing when disabled and never fetches", () => {
    renderPanel(false);
    expect(screen.queryByTestId("gap-report")).toBeNull();
    expect(getGapReport).not.toHaveBeenCalled();
  });

  it("renders a code-grounded card with citation, gap, and effort/badges", async () => {
    renderPanel();
    const card = await screen.findByTestId("gap-report-card-req-1");
    expect(card).toHaveTextContent("Users can log in");
    // Current implementation cites code via the reused #734 locator (also
    // echoed on the gap finding), so there is at least one locator on the card.
    expect(screen.getAllByText("server/src/auth.ts:10-20").length).toBeGreaterThan(0);
    // Gap finding body surfaced verbatim.
    expect(card).toHaveTextContent("no throttle");
    // Effort estimate reuses storyPoints.
    expect(screen.getByTestId("gap-effort-estimate")).toHaveTextContent("5 points");
    // Coverage (#736) + verification (#740) badges surfaced inline.
    expect(screen.getByTestId("coverage-badge-grounded_in_code")).toBeInTheDocument();
    expect(screen.getAllByTestId("verification-badge-confirmed").length).toBeGreaterThan(0);
  });

  it("renders an explicit no-evidence marker and 'unestimated' effort", async () => {
    renderPanel();
    const card = await screen.findByTestId("gap-report-card-req-2");
    expect(card).toHaveTextContent(/Nothing found in code/i);
    expect(screen.getByTestId("gap-effort-unestimated")).toHaveTextContent("Unestimated");
    expect(screen.getByTestId("coverage-badge-no_evidence")).toBeInTheDocument();
  });

  it("renders an empty-state message when there are no requirements", async () => {
    getGapReport.mockResolvedValue({ ...REPORT, requirements: [] });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/No requirements to report on yet/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a load error", async () => {
    getGapReport.mockRejectedValue(new Error("boom"));
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/Could not load the gap report/i)).toBeInTheDocument(),
    );
  });

  it("downloads the combined analysis-report markdown when exporting (#744)", async () => {
    exportAnalysisReport.mockResolvedValue({
      blob: new Blob(["# report"]),
      filename: "analysis-report-an-1.md",
    });
    renderPanel();
    // Wait for the report to load so the export button leaves its disabled state.
    await screen.findByTestId("gap-report-card-req-1");
    fireEvent.click(screen.getByTestId("analysis-report-export-md"));
    await waitFor(() => expect(exportAnalysisReport).toHaveBeenCalledWith("proj-1", "an-1"));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalled());
  });

  it("disables the export button while there are no requirements", async () => {
    getGapReport.mockResolvedValue({ ...REPORT, requirements: [] });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("analysis-report-export-md")).toBeDisabled());
  });

  it("surfaces an export error", async () => {
    exportAnalysisReport.mockRejectedValue(new Error("nope"));
    renderPanel();
    await screen.findByTestId("gap-report-card-req-1");
    fireEvent.click(screen.getByTestId("analysis-report-export-md"));
    await waitFor(() =>
      expect(screen.getByText(/Export failed\. Please try again/i)).toBeInTheDocument(),
    );
  });
});

/**
 * Issue #773 — the gap report is where "we could not retrieve it" was rendered as
 * "you must build it". These tests pin the visual + semantic separation a BA relies
 * on, and the searched-scope provenance that makes a confirmed gap auditable.
 */
describe("GapReport — could-not-verify (#773)", () => {
  beforeEach(() => {
    getGapReport.mockResolvedValue(REPORT);
  });

  it("renders a could-not-verify requirement distinctly from a confirmed gap", async () => {
    renderPanel();
    await screen.findByTestId("gap-report-card-req-2");

    const confirmed = screen.getByTestId("gap-report-card-req-1");
    const unverified = screen.getByTestId("gap-report-card-req-2");
    expect(confirmed).toHaveAttribute("data-verdict", "gap-confirmed");
    expect(unverified).toHaveAttribute("data-verdict", "could-not-verify");

    // Distinct badges, not a shared "no evidence" colour.
    expect(screen.getAllByTestId("verdict-badge-gap-confirmed").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("verdict-badge-could-not-verify").length).toBeGreaterThan(0);
  });

  it("says out loud that an unverifiable finding is NOT a confirmed gap", async () => {
    renderPanel();
    await screen.findByTestId("gap-report-card-req-2");

    const block = screen.getByTestId("gap-could-not-verify");
    expect(block).toHaveTextContent(/not a confirmed gap/i);
    expect(block).toHaveTextContent(/Could not verify: Password reset/);
    // The unverifiable narrative never appears under the "Gap" heading.
    const gapSections = screen.getAllByTestId("gap-description");
    for (const section of gapSections) {
      expect(section).not.toHaveTextContent(/Could not verify: Password reset/);
    }
  });

  it("shows the searched scope + the degraded-retrieval warning", async () => {
    renderPanel();
    await screen.findByTestId("gap-searched-scope");

    const panel = screen.getByTestId("gap-searched-scope");
    expect(panel).toHaveAttribute("data-degraded", "true");
    expect(panel).toHaveTextContent(/“not found” results are unreliable/);
    // The provenance behind (or against) any absence claim: the actual queries.
    expect(screen.getAllByTestId("searched-scope-entry")).toHaveLength(2);
    expect(panel).toHaveTextContent(/search_code_symbols\("password reset"\)/);
  });

  it("renders no searched-scope panel when the run had no code pass", async () => {
    getGapReport.mockResolvedValue({ ...REPORT, retrieval: null });
    renderPanel();
    await screen.findByTestId("gap-report-card-req-1");
    expect(screen.queryByTestId("gap-searched-scope")).not.toBeInTheDocument();
  });

  it("says the run was cut short only when it was EXHAUSTED, not merely starved (#1236)", async () => {
    renderPanel();
    await screen.findByTestId("gap-searched-scope");
    // The fixture is degraded but not exhausted — no budget wording.
    expect(screen.getByTestId("gap-searched-scope")).not.toHaveTextContent(/cut short/);

    cleanup();
    getGapReport.mockResolvedValue({
      ...REPORT,
      retrieval: { ...REPORT.retrieval, exhausted: true },
    });
    renderPanel();
    await screen.findByTestId("gap-searched-scope");
    expect(screen.getByTestId("gap-searched-scope")).toHaveTextContent(
      /the investigation was cut short by its budget/,
    );
  });
});

/**
 * Issue #827 — the database-changes section is composed per requirement. These
 * tests verify it appears only on requirements that carry `databaseChanges` and
 * that the panel's `projectId` is threaded into the identity-manager link (the
 * section's own states are covered in gap-report-schema-section.test.tsx).
 */
describe("GapReport — database changes composition (#827)", () => {
  it("renders the database-changes section on a requirement that has one, and not on one that doesn't", async () => {
    getGapReport.mockResolvedValue({
      ...REPORT,
      requirements: [
        {
          ...REPORT.requirements[0],
          databaseChanges: [
            {
              tableName: "orders",
              columnName: null,
              changeKind: "add-table",
              reconciliation: "matched",
              confidence: 0.9,
              suggestedDdl: "CREATE TABLE orders (id INT);",
              identityResolved: false,
            },
          ],
        },
        REPORT.requirements[1],
      ],
    });
    renderPanel();

    const withDb = await screen.findByTestId("gap-report-card-req-1");
    const section = within(withDb).getByTestId("gap-database-changes");
    expect(section).toBeInTheDocument();
    // projectId ("proj-1") is threaded into the identity-manager link.
    expect(within(section).getByTestId("db-identity-manager-link")).toHaveAttribute(
      "href",
      "/projects/proj-1/connections",
    );
    expect(
      within(section).getByText("Suggested DDL — for review only, never executed"),
    ).toBeVisible();

    const withoutDb = screen.getByTestId("gap-report-card-req-2");
    expect(within(withoutDb).queryByTestId("gap-database-changes")).toBeNull();
  });
});

describe("GapReport — SQL-lineage coverage (#895)", () => {
  beforeEach(() => {
    getGapReport.mockReset();
    exportAnalysisReport.mockReset();
  });
  afterEach(() => cleanup());

  const COVERAGE = {
    totalEdges: 4,
    resolvedEdges: 3,
    unresolvedEdges: 1,
    coveragePercent: 75,
    bySource: {
      sqlglot: { total: 2, unresolved: 0 },
      mybatis: { total: 1, unresolved: 1 },
      "catalog-deps": { total: 1, unresolved: 0 },
    },
    unresolvedRefs: [
      {
        edgeId: "e1",
        kind: "reads" as const,
        source: "mybatis" as const,
        reason: "dynamic" as const,
        filePath: "src/M.xml",
        toQualifiedName: "?dynamic:tableName",
        placeholder: "tableName",
        statementId: "M.find",
        mapper: "com.acme.M",
      },
    ],
  };

  it("renders the unresolved percentage headline and the drillable unresolved edge", async () => {
    getGapReport.mockResolvedValue({ ...REPORT, sqlLineageCoverage: COVERAGE });
    renderPanel();
    const panel = await screen.findByTestId("sql-lineage-coverage");
    expect(panel).toHaveAttribute("data-unresolved", "true");
    expect(within(panel).getByTestId("sql-lineage-coverage-headline")).toHaveTextContent(
      "25% of table edges are dynamically resolved / need manual confirmation",
    );
    expect(within(panel).getByTestId("sql-lineage-coverage-by-source")).toHaveTextContent(
      "mybatis",
    );
    const ref = within(panel).getByTestId("sql-lineage-unresolved-ref");
    expect(ref).toHaveTextContent("src/M.xml");
    expect(ref).toHaveTextContent("dynamic (runtime-built SQL)");
  });

  it("renders the all-resolved state without an amber flag", async () => {
    getGapReport.mockResolvedValue({
      ...REPORT,
      sqlLineageCoverage: {
        totalEdges: 3,
        resolvedEdges: 3,
        unresolvedEdges: 0,
        coveragePercent: 100,
        bySource: { sqlglot: { total: 3, unresolved: 0 } },
        unresolvedRefs: [],
      },
    });
    renderPanel();
    const panel = await screen.findByTestId("sql-lineage-coverage");
    expect(panel).toHaveAttribute("data-unresolved", "false");
    expect(within(panel).queryByTestId("sql-lineage-unresolved-ref")).toBeNull();
  });

  it("does not render the panel when coverage is absent", async () => {
    getGapReport.mockResolvedValue({ ...REPORT, sqlLineageCoverage: null });
    renderPanel();
    await screen.findByTestId("gap-report");
    expect(screen.queryByTestId("sql-lineage-coverage")).toBeNull();
  });
});
