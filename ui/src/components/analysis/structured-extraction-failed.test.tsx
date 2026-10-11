/**
 * Issue #1058 — a failed requirements extraction must not read as a clean one.
 *
 * The extractor used to swallow a malformed model answer and store
 * `{ requirements: [], totalAmbiguities: 0 }`, so this component rendered
 * "No open questions — requirements look complete" for a step that had failed.
 * The server now records `structuredExtractionFailure` instead.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      getClarification: vi.fn(async () => ({ state: null })),
      clarify: vi.fn(),
    },
  };
});

const { EnhancementResults } = await import("@/components/analysis/EnhancementResults");

const EMPTY_STRUCTURED = { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 };
const FAILURE = { reason: "unparseable", at: "2026-10-11T00:00:00.000Z" };

function renderWith(metadata: Record<string, unknown>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EnhancementResults projectId="p1" analysisId="an_1058" metadata={metadata} />
    </QueryClientProvider>,
  );
}

describe("#1058 structured extraction failure notice", () => {
  it("says the step failed and does not claim the requirements are complete", () => {
    renderWith({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredExtractionFailure: FAILURE,
    });

    const notice = screen.getByTestId("structured-extraction-failed");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent(/could not read the requirements/i);
    expect(notice).toHaveTextContent(/run the analysis again/i);
    // The server's reason code is diagnosis, not copy.
    expect(notice).not.toHaveTextContent("unparseable");
    expect(screen.queryByTestId("gaps-summary")).not.toBeInTheDocument();
  });

  it("withholds the all-clear banner even when an earlier run left a list behind", () => {
    renderWith({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: EMPTY_STRUCTURED,
      structuredExtractionFailure: FAILURE,
    });

    expect(screen.getByTestId("structured-extraction-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("gaps-summary")).not.toBeInTheDocument();
    expect(screen.queryByText(/requirements look complete/i)).not.toBeInTheDocument();
  });

  it("is shown for a web-research-only run too, which also depends on extraction", () => {
    renderWith({
      enhancement: { enableWebResearch: true, enableClarification: false },
      structuredExtractionFailure: FAILURE,
    });
    expect(screen.getByTestId("structured-extraction-failed")).toBeInTheDocument();
  });

  it("is absent on a healthy run, where the all-clear banner still shows", () => {
    renderWith({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: EMPTY_STRUCTURED,
    });

    expect(screen.queryByTestId("structured-extraction-failed")).not.toBeInTheDocument();
    expect(screen.getByTestId("gaps-summary")).toHaveTextContent(/requirements look complete/i);
  });

  it("renders nothing when no enhancement was requested", () => {
    const { container } = renderWith({ structuredExtractionFailure: FAILURE });
    expect(container).toBeEmptyDOMElement();
  });
});
