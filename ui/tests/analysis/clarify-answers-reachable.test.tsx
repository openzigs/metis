/**
 * Issue #1104 finding C — answered clarifying questions must stay reachable.
 *
 * Live symptom: 12 answers were accepted, the round was persisted, and then the
 * whole Clarifying Questions block vanished on reload because the section's
 * render gate was `structuredRequirements.totalAmbiguities > 0` — a number the
 * server had driven to -28 by counting the answers as resolved. The user's work
 * was on disk and unreachable in the UI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi } = vi.hoisted(() => ({
  analysisApi: {
    clarify: vi.fn(),
    getClarification: vi.fn(),
    submitClarifyAnswers: vi.fn(),
    exportClarifyCsv: vi.fn(),
    importClarifyAnswers: vi.fn(),
  },
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});

import { EnhancementResults } from "@/components/analysis/EnhancementResults";
import { ClarificationDialogPanel } from "@/components/analysis/ClarificationDialog";

/** A round the user has already answered, exactly as the server persists it. */
const ANSWERED_STATE = {
  analysisId: "ana-1",
  currentRound: 2,
  maxRounds: 3,
  completed: true,
  escalatedToSonnet: false,
  resolvedAmbiguities: ["req-1:isolationLevel"],
  rounds: [
    {
      round: 1,
      questions: [
        {
          id: "q-1",
          requirementId: "req-1",
          ambiguityField: "isolationLevel",
          question: "Which isolation level?",
          context: "unspecified",
          groundingStatus: "open" as const,
          answer: "READ COMMITTED, guaranteed by the conditional UPDATE.",
        },
      ],
      answers: [
        { questionId: "q-1", answer: "READ COMMITTED, guaranteed by the conditional UPDATE." },
      ],
    },
  ],
};

function renderResults(metadata: Record<string, unknown>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EnhancementResults projectId="proj-1" analysisId="ana-1" metadata={metadata} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  analysisApi.getClarification.mockResolvedValue({ state: null });
});

describe("#1104 C — an answered dialog survives a reload", () => {
  it("still renders the clarification block when no ambiguities remain", async () => {
    analysisApi.getClarification.mockResolvedValue({ state: ANSWERED_STATE });

    // The post-answer metadata: every ambiguity resolved, so totalAmbiguities 0.
    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
    });

    await waitFor(() =>
      expect(analysisApi.getClarification).toHaveBeenCalledWith("proj-1", "ana-1"),
    );
    expect(await screen.findByText("Clarification Complete")).toBeInTheDocument();
    // No new round is started for an already-complete dialog.
    expect(analysisApi.clarify).not.toHaveBeenCalled();
  });

  it("shows the answers the user submitted, not an empty summary", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ClarificationDialogPanel
          projectId="proj-1"
          analysisId="ana-1"
          state={ANSWERED_STATE}
          onComplete={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Which isolation level?")).toBeInTheDocument();
    expect(
      screen.getByText("READ COMMITTED, guaranteed by the conditional UPDATE."),
    ).toBeInTheDocument();
  });
});

describe("#1104 C — submitting answers refreshes the dialog", () => {
  const OPEN_STATE = {
    ...ANSWERED_STATE,
    completed: false,
    currentRound: 1,
    resolvedAmbiguities: [],
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: "q-1",
            requirementId: "req-1",
            ambiguityField: "isolationLevel",
            question: "Which isolation level?",
            context: "unspecified",
            groundingStatus: "open" as const,
          },
        ],
        answers: [],
      },
    ],
  };

  it("refetches after a successful submit even though the response is {state,…}", async () => {
    // The submit response is `{ state, updatedRequirements }` — NOT a bare state.
    // Reading `result.completed` off it is always undefined, which is why the
    // panel used to sit on stale "0 resolved / 12 remaining" after submitting.
    analysisApi.submitClarifyAnswers.mockResolvedValue({
      state: { ...OPEN_STATE, completed: true, resolvedAmbiguities: ["req-1:isolationLevel"] },
      updatedRequirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
    });
    const onComplete = vi.fn();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ClarificationDialogPanel
          projectId="proj-1"
          analysisId="ana-1"
          state={OPEN_STATE}
          onComplete={onComplete}
        />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText("Your answer..."), {
      target: { value: "READ COMMITTED." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));

    await waitFor(() => expect(analysisApi.submitClarifyAnswers).toHaveBeenCalled());
    expect(analysisApi.submitClarifyAnswers).toHaveBeenCalledWith("proj-1", "ana-1", [
      { questionId: "q-1", answer: "READ COMMITTED." },
    ]);
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});
