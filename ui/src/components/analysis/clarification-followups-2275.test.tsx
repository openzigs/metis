/**
 * #2275 — follow-ups from #2274 in the clarification panel and the approval
 * cards: set-aside ambiguities count as addressed, "searched" is said only
 * when a search ran, and a completed dialog never says questions are waiting
 * for a next round.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ClarificationStatePayload, ClarifyingQuestion } from "@/lib/analysis-api";

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

const { ClarificationDialogPanel, NotAskedNote, uncertaintyLabel } =
  await import("@/components/analysis/ClarificationDialog");
const { addressedAmbiguityKeys } = await import("@/components/analysis/ApprovalsPanel");

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

const question = (over: Partial<ClarifyingQuestion> = {}): ClarifyingQuestion => ({
  id: "q1",
  requirementId: "r1",
  ambiguityField: "glossary",
  question: "What is a 'customer'?",
  context: "",
  groundingStatus: "open",
  uncertainty: "missing-knowledge",
  ...over,
});

const state = (over: Partial<ClarificationStatePayload> = {}): ClarificationStatePayload => ({
  analysisId: "a1",
  currentRound: 1,
  maxRounds: 3,
  rounds: [{ round: 1, questions: [question()], answers: [] }],
  resolvedAmbiguities: [],
  answeredAmbiguities: [],
  escalatedToSonnet: false,
  completed: false,
  ...over,
});

describe("#2275 — the panel says 'searched' only when a search ran", () => {
  it("labels missing knowledge by whether the search ran", () => {
    expect(uncertaintyLabel({ uncertainty: "missing-knowledge", searched: true })).toBe(
      "Missing project knowledge: METIS searched your documents and code before asking",
    );
    expect(uncertaintyLabel({ uncertainty: "missing-knowledge" })).toBe(
      "Missing project knowledge: your documents or code may answer this",
    );
    expect(uncertaintyLabel({ uncertainty: "silence" })).toBe("The document does not say");
    expect(uncertaintyLabel({})).toBeNull();
  });

  it("shows the unsearched label on a question no search ran for", () => {
    renderPanel(state());
    const label = screen.getByTestId("question-uncertainty");
    expect(label).toHaveTextContent("your documents or code may answer this");
    expect(label).not.toHaveTextContent("searched");
  });

  it("shows the searched label when it ran", () => {
    renderPanel(
      state({ rounds: [{ round: 1, questions: [question({ searched: true })], answers: [] }] }),
    );
    expect(screen.getByTestId("question-uncertainty")).toHaveTextContent(
      "METIS searched your documents and code before asking",
    );
  });
});

describe("#2275 — set-aside ambiguities count as addressed", () => {
  it("in the approval cards", () => {
    const keys = addressedAmbiguityKeys({
      resolvedAmbiguities: ["r1:a"],
      answeredAmbiguities: ["r1:b"],
      setAsideAmbiguities: ["r1:c"],
    });
    expect([...keys].sort()).toEqual(["r1:a", "r1:b", "r1:c"]);
  });

  it("in the panel's progress", () => {
    renderPanel(state({ setAsideAmbiguities: ["r1:scope", "r2:limit"] }));
    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("2 addressed");
  });
});

describe("#2275 — a completed dialog does not say questions are waiting", () => {
  const withNotAsked = (over: Partial<ClarificationStatePayload>) =>
    state({ rounds: [{ round: 1, questions: [], answers: [], notAsked: 2 }], ...over });

  it("says they were not asked once the dialog is complete", () => {
    render(<NotAskedNote state={withNotAsked({ completed: true })} />);
    const note = screen.getByTestId("clarification-not-asked");
    expect(note).toHaveTextContent("2 more questions of lower impact were not asked.");
    expect(note).not.toHaveTextContent("waiting");
  });

  it("still says they are waiting while the dialog is open", () => {
    render(<NotAskedNote state={withNotAsked({ completed: false })} />);
    expect(screen.getByTestId("clarification-not-asked")).toHaveTextContent(
      "2 more questions of lower impact are waiting for the next round.",
    );
  });

  it("says one was not asked, in the singular", () => {
    render(
      <NotAskedNote
        state={state({
          completed: true,
          rounds: [{ round: 1, questions: [], answers: [], notAsked: 1 }],
        })}
      />,
    );
    expect(screen.getByTestId("clarification-not-asked")).toHaveTextContent(
      "1 more question of lower impact was not asked.",
    );
  });
});
