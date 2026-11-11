/**
 * #2235 — a clarifying question cites the paragraph of the source document it
 * is about and offers the readings to pick from; the questions METIS did not
 * ask, and the ones over a round's cap, are listed rather than lost.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClarificationStatePayload } from "@/lib/analysis-api";

const submitClarifyAnswers = vi.fn();

vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      submitClarifyAnswers: (...args: unknown[]) => submitClarifyAnswers(...args),
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

const CITATION = {
  documentId: "doc-1",
  filename: "frd.docx",
  headingPath: ["4 Accounts", "4.2 Customers"],
  quote: "Every customer may export their orders.",
};

const state = (over: Partial<ClarificationStatePayload> = {}): ClarificationStatePayload => ({
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
          ambiguityField: "customer",
          question: "Does 'customer' in §4.2 mean the account holder or every user on the account?",
          context: "Who can export decides the permission check.",
          groundingStatus: "open",
          uncertainty: "ambiguity",
          options: ["The account holder", "Every user on the account"],
          impact: "high",
          citation: CITATION,
        },
      ],
      answers: [],
    },
  ],
  resolvedAmbiguities: [],
  escalatedToSonnet: false,
  completed: false,
  ...over,
});

beforeEach(() => {
  submitClarifyAnswers.mockReset();
  submitClarifyAnswers.mockResolvedValue({ state: state(), updatedRequirements: {} });
});

describe("#2235 — a question from the source document", () => {
  it("quotes the paragraph under its section and says what kind of question it is", () => {
    renderPanel(state());
    const citation = screen.getByTestId("question-citation");
    expect(citation).toHaveTextContent("frd.docx › 4 Accounts › 4.2 Customers");
    expect(citation).toHaveTextContent("Every customer may export their orders.");
    expect(screen.getByTestId("question-uncertainty")).toHaveTextContent(
      "The document can be read more than one way",
    );
  });

  it("puts a picked reading in the answer box, and submits it only on Submit", async () => {
    renderPanel(state());
    const options = screen.getByRole("group", { name: "Possible answers" });
    fireEvent.click(within(options).getByRole("button", { name: "Every user on the account" }));
    const box = screen.getByLabelText(/mean the account holder or every user/);
    expect(box).toHaveValue("Every user on the account");
    expect(submitClarifyAnswers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));
    await vi.waitFor(() => expect(submitClarifyAnswers).toHaveBeenCalledTimes(1));
    expect(submitClarifyAnswers).toHaveBeenCalledWith("p1", "a1", [
      { questionId: "q1", answer: "Every user on the account" },
    ]);
  });

  it("shows no citation, label or readings for a question from before #2235", () => {
    const old = state();
    const q = old.rounds[0]!.questions[0]!;
    old.rounds[0]!.questions[0] = {
      id: q.id,
      requirementId: q.requirementId,
      ambiguityField: q.ambiguityField,
      question: q.question,
      context: q.context,
    };
    renderPanel(old);
    expect(screen.queryByTestId("question-citation")).toBeNull();
    expect(screen.queryByTestId("question-uncertainty")).toBeNull();
    expect(screen.queryByTestId("question-options")).toBeNull();
  });
});

describe("#2235 — what was not asked is listed", () => {
  const SET_ASIDE = [
    {
      requirementId: "r2",
      ambiguityField: "budget",
      question: "What is the budget for the export service?",
      context: "Funding is decided next quarter.",
      reason: "unanswerable" as const,
      round: 1,
      citation: CITATION,
    },
    {
      requirementId: "r1",
      ambiguityField: "R7:quickly",
      question: "How quickly must the export start?",
      context: "",
      reason: "same-outcome" as const,
      round: 1,
    },
  ];

  it("lists the open items and the same-outcome questions, each under its reason", () => {
    renderPanel(state({ setAside: SET_ASIDE }));
    const list = screen.getByTestId("clarification-set-aside");
    expect(list).toHaveTextContent("2 questions not asked");
    expect(within(screen.getByTestId("set-aside-unanswerable")).getByText(/budget/)).toBeTruthy();
    expect(screen.getByTestId("set-aside-unanswerable")).toHaveTextContent("Open items");
    expect(screen.getByTestId("set-aside-same-outcome")).toHaveTextContent(
      "How quickly must the export start?",
    );
  });

  it("lists them on a completed dialog too", () => {
    renderPanel(state({ setAside: SET_ASIDE.slice(0, 1), completed: true }));
    expect(screen.getByTestId("clarification-complete")).toHaveTextContent("1 question not asked");
  });

  it("says how many questions are waiting for the next round", () => {
    const s = state();
    s.rounds[0]!.notAsked = 3;
    renderPanel(s);
    expect(screen.getByTestId("clarification-not-asked")).toHaveTextContent(
      "3 more questions of lower impact are waiting for the next round.",
    );
  });

  it("says, on the last round, that the questions over its cap were not asked", () => {
    const s = state({ currentRound: 3 });
    s.rounds[0] = { ...s.rounds[0]!, round: 3, notAsked: 1 };
    renderPanel(s);
    expect(screen.getByTestId("clarification-not-asked")).toHaveTextContent(
      "1 more question did not fit in the last round and was not asked.",
    );
  });

  it("says nothing when every question was asked", () => {
    renderPanel(state());
    expect(screen.queryByTestId("clarification-not-asked")).toBeNull();
    expect(screen.queryByTestId("clarification-set-aside")).toBeNull();
  });
});
