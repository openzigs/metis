/**
 * Issue #1081 — the clarification and evidence panels say when a model answer
 * could not be read, instead of showing the empty or default result that
 * answer used to collapse into:
 *   - start: questions that could not be read are an error, not "nothing to clarify";
 *   - resolution: a requirement whose update could not be read is named;
 *   - grounding: "open" because the check failed is not "open" by verdict;
 *   - web research: a search run on the need's own wording is labelled.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClarificationStatePayload } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";

const getClarification = vi.fn();
const clarify = vi.fn();

vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      getClarification: (...args: unknown[]) => getClarification(...args),
      clarify: (...args: unknown[]) => clarify(...args),
      submitClarifyAnswers: vi.fn(),
      exportClarifyCsv: vi.fn(),
      importClarifyAnswers: vi.fn(),
    },
  };
});

const { EnhancementResults } = await import("@/components/analysis/EnhancementResults");
const { ClarificationDialogPanel } = await import("@/components/analysis/ClarificationDialog");

function renderResults(metadata: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EnhancementResults projectId="p1" analysisId="an_1081" metadata={metadata} />
    </QueryClientProvider>,
  );
}

function renderPanel(state: ClarificationStatePayload) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClarificationDialogPanel
        projectId="p1"
        analysisId="an_1081"
        state={state}
        onComplete={() => {}}
      />
    </QueryClientProvider>,
  );
}

const WITH_AMBIGUITY = {
  enhancement: { enableWebResearch: false, enableClarification: true },
  structuredRequirements: {
    requirements: [
      {
        id: "r1",
        title: "Consent banner",
        description: "",
        ambiguities: [{ field: "dsa", description: "scope", suggestedQuestion: "DSA?" }],
        evidenceNeeds: [],
      },
    ],
    totalAmbiguities: 1,
    totalEvidenceNeeds: 0,
  },
};

const panelState = (over: Partial<ClarificationStatePayload> = {}): ClarificationStatePayload =>
  ({
    analysisId: "an_1081",
    currentRound: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: "q1",
            requirementId: "r1",
            ambiguityField: "dsa",
            question: "Does the DSA apply?",
            context: "",
            groundingStatus: "open",
          },
        ],
        answers: [],
      },
    ],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
    ...over,
  }) as ClarificationStatePayload;

beforeEach(() => {
  vi.clearAllMocks();
  getClarification.mockResolvedValue({ state: null });
});

describe("#1081 clarification start whose questions could not be read", () => {
  it("says the questions could not be read, not that there is nothing to clarify", async () => {
    clarify.mockRejectedValue(new ApiError(502, "unreadable", "MODEL_REPLY_UNREADABLE"));
    renderResults(WITH_AMBIGUITY);
    const alert = await screen.findByTestId("clarify-start-error");
    expect(alert.textContent).toContain("could not read the clarifying questions");
    expect(alert.textContent).toContain("does not mean there is nothing to clarify");
  });

  it("keeps the generic wording for any other start failure", async () => {
    clarify.mockRejectedValue(new ApiError(500, "boom", "INTERNAL"));
    renderResults(WITH_AMBIGUITY);
    await waitFor(() => expect(screen.getByTestId("clarify-start-error")).toBeTruthy());
    expect(screen.getByTestId("clarify-start-error").textContent).toContain(
      "Could not start the interactive session",
    );
  });
});

describe("#1081 clarification panel notes", () => {
  it("names the requirements whose update could not be read", () => {
    const state = panelState();
    state.rounds[0]!.unreadResolutions = ["r1", "r2"];
    renderPanel(state);
    expect(screen.getByTestId("clarification-unread-resolutions").textContent).toContain(
      "could not read the model’s update for 2 requirements",
    );
  });

  it("says nothing when every update was read", () => {
    renderPanel(panelState());
    expect(screen.queryByTestId("clarification-unread-resolutions")).toBeNull();
  });

  it("marks a question whose knowledge check failed, and only that one", () => {
    const state = panelState();
    state.rounds[0]!.questions.push({
      id: "q2",
      requirementId: "r1",
      ambiguityField: "retention",
      question: "How long?",
      context: "",
      groundingStatus: "open",
      groundingFailed: true,
    });
    renderPanel(state);
    const notes = screen.getAllByTestId("grounding-failed");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toContain("could not check your project’s documents and code");
  });
});

describe("#1081 web research query fallback", () => {
  it("labels a digest searched with the need's own wording", () => {
    renderResults({
      enhancement: { enableWebResearch: true, enableClarification: false },
      webResearch: {
        digests: [
          {
            id: "d1",
            requirementId: "r1",
            evidenceNeedId: "n1",
            query: "payment settlement time",
            sources: [],
            digest: "No web sources found for this evidence need.",
            needsHumanReview: true,
            queryFallback: true,
          },
          {
            id: "d2",
            requirementId: "r1",
            evidenceNeedId: "n2",
            query: "PCI DSS",
            sources: [],
            digest: "Some digest.",
            needsHumanReview: false,
          },
        ],
        totalSources: 0,
        reviewRequired: 1,
      },
    });
    const notes = screen.getAllByTestId("query-fallback-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.textContent).toContain("could not read the model’s search queries");
  });
});
