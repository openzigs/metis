/**
 * #2236 — a question the project had already answered is not asked again; the
 * panel lists it with the answer that was reused, on an open round and on a
 * completed dialog.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ClarificationStatePayload } from "@/lib/analysis-api";

vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      submitClarifyAnswers: vi.fn(),
      exportClarifyCsv: vi.fn(),
      importClarifyAnswers: vi.fn(),
    },
  };
});

const { ClarificationDialogPanel } = await import("@/components/analysis/ClarificationDialog");

function renderPanel(state: ClarificationStatePayload) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClarificationDialogPanel
        projectId="p1"
        analysisId="a1"
        state={state}
        onComplete={() => {}}
      />
    </QueryClientProvider>,
  );
}

const REUSED = {
  requirementId: "r1",
  ambiguityField: "minimumLength",
  question: "How long must a password be?",
  answer: "At least 12 characters.",
  recordId: "rec-1",
  answeredAt: "2026-11-10T09:00:00.000Z",
  fromAnalysisId: "a0",
  round: 1,
  citation: {
    documentId: "doc-1",
    filename: "frd.docx",
    headingPath: ["4 Accounts", "4.2 Passwords"],
    quote: "Passwords must be long enough.",
  },
};

const base = (over: Partial<ClarificationStatePayload> = {}): ClarificationStatePayload => ({
  analysisId: "a1",
  currentRound: 1,
  maxRounds: 3,
  rounds: [
    {
      round: 1,
      questions: [
        {
          id: "q1",
          requirementId: "r1",
          ambiguityField: "charset",
          question: "Which characters are allowed?",
          context: "",
        },
      ],
      answers: [],
    },
  ],
  resolvedAmbiguities: [],
  answeredAmbiguities: ["r1:minimumLength"],
  escalatedToSonnet: false,
  completed: false,
  ...over,
});

describe("#2236 — reused answers in the clarification panel", () => {
  it("lists a reused answer beside the open round, with when, where from and its paragraph", () => {
    renderPanel(base({ reused: [REUSED] }));
    const reused = screen.getByTestId("clarification-reused");
    expect(reused).toHaveTextContent(
      "1 question already answered in this project, not asked again",
    );
    fireEvent.click(within(reused).getByText(/already answered/));
    expect(reused).toHaveTextContent("How long must a password be?");
    expect(reused).toHaveTextContent("Answer: At least 12 characters.");
    expect(reused).toHaveTextContent("in an earlier analysis");
    expect(within(reused).getByTestId("question-citation")).toHaveTextContent(
      "Passwords must be long enough.",
    );
    // The open question is still asked.
    expect(screen.getByText("Which characters are allowed?")).toBeInTheDocument();
  });

  it("lists them on a dialog that completed because every question was already answered", () => {
    renderPanel(
      base({
        rounds: [],
        completed: true,
        reused: [REUSED, { ...REUSED, recordId: "rec-2", fromAnalysisId: undefined }],
      }),
    );
    const reused = screen.getByTestId("clarification-reused");
    expect(reused).toHaveTextContent("2 questions already answered in this project");
  });

  it("shows nothing when nothing was reused", () => {
    renderPanel(base());
    expect(screen.queryByTestId("clarification-reused")).toBeNull();
  });
});
