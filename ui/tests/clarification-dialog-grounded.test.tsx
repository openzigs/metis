/**
 * Self-resolution UI (clarify-self-resolve): a grounded clarifying question
 * renders a "Suggested answer (from <source>)" affordance and a grounding
 * badge, while an open question renders a blank input with no affordance.
 * #2122 — the suggestion is offered beside a BLANK input, never filled in: it
 * is not counted as answered and is sent only once the user uses it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// The component imports the analysis API + the app mutation hook; stub both so
// nothing touches the network. `mutate` runs the mutation's own `mutationFn`,
// so a submit reaches the stubbed API with the payload the panel built.
const submitClarifyAnswers = vi.hoisted(() => vi.fn(async () => ({ state: undefined })));
vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return {
    ...actual,
    analysisApi: { clarify: vi.fn(), submitClarifyAnswers },
  };
});
vi.mock("@/lib/use-app-mutation", () => ({
  useAppMutation: (opts: { mutationFn: (v?: unknown) => unknown }) => ({
    mutate: (v?: unknown) => void opts.mutationFn(v),
    isPending: false,
    isError: false,
  }),
}));

import { ClarificationDialogPanel } from "@/components/analysis/ClarificationDialog";
import type { ClarificationStatePayload } from "@/lib/analysis-api";

function buildState(): ClarificationStatePayload {
  return {
    analysisId: "ana-1",
    currentRound: 1,
    maxRounds: 3,
    completed: false,
    escalatedToSonnet: false,
    resolvedAmbiguities: [],
    rounds: [
      {
        round: 1,
        answers: [],
        questions: [
          {
            id: "q-grounded",
            requirementId: "r1",
            ambiguityField: "authMethod",
            question: "Which authentication method should the API use?",
            context: "",
            groundingStatus: "grounded",
            groundedAnswer: "OAuth2 bearer tokens",
            groundingCitations: [{ source: "auth.ts", snippet: "OAuth2 bearer tokens are used." }],
          },
          {
            id: "q-open",
            requirementId: "r2",
            ambiguityField: "slaTarget",
            question: "What is the target SLA?",
            context: "",
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  cleanup();
  submitClarifyAnswers.mockClear();
});

function renderPanel(state = buildState()) {
  return render(
    <ClarificationDialogPanel
      projectId="proj-1"
      analysisId="ana-1"
      state={state}
      onComplete={() => {}}
    />,
  );
}

function input(testId: string): HTMLInputElement {
  return screen.getByTestId(testId).querySelector("input") as HTMLInputElement;
}

describe("ClarificationDialogPanel self-resolution", () => {
  it("#2122 — offers a grounded question's suggestion beside a blank input, with badge and source", () => {
    renderPanel();

    expect(screen.getByTestId("grounded-question")).toBeInTheDocument();
    // The input is blank: the suggestion is shown, not filled in.
    expect(input("grounded-question").value).toBe("");
    expect(screen.getByTestId("suggested-answer")).toHaveTextContent("OAuth2 bearer tokens");

    // Badge + citation source shown; the badge does not call it answered.
    const badge = screen.getByTestId("grounding-badge");
    expect(badge).toHaveTextContent("Suggested from project knowledge");
    expect(badge.textContent).not.toMatch(/^Answered/);
    expect(screen.getByTestId("suggested-answer-source")).toHaveTextContent("auth.ts");
  });

  it("#2122 — a suggestion is not counted as answered, and Submit stays off until something is", () => {
    renderPanel();
    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("0 of 2 answered");
    expect(screen.getByRole("button", { name: "Submit Answers" })).toBeDisabled();
  });

  it("#2122 — Submit sends only what the user typed; an unused suggestion is never sent", () => {
    renderPanel();
    fireEvent.change(input("open-question"), { target: { value: "99.9%" } });
    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("1 of 2 answered");
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));
    expect(submitClarifyAnswers).toHaveBeenCalledWith("proj-1", "ana-1", [
      { questionId: "q-open", answer: "99.9%" },
    ]);
  });

  it("#2122 — 'Use suggested answer' fills the box, counts it, and sends it", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Use suggested answer" }));
    expect(input("grounded-question").value).toBe("OAuth2 bearer tokens");
    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("1 of 2 answered");
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));
    expect(submitClarifyAnswers).toHaveBeenCalledWith("proj-1", "ana-1", [
      { questionId: "q-grounded", answer: "OAuth2 bearer tokens" },
    ]);
  });

  it("#2122 — a box cleared back to blank is not sent", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Use suggested answer" }));
    fireEvent.change(input("open-question"), { target: { value: "x" } });
    fireEvent.change(input("open-question"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));
    expect(submitClarifyAnswers).toHaveBeenCalledWith("proj-1", "ana-1", [
      { questionId: "q-grounded", answer: "OAuth2 bearer tokens" },
    ]);
  });

  it("an answer submitted earlier is shown in its box, in place of the suggestion", () => {
    const state = buildState();
    state.rounds[0]!.questions[0]!.answer = "mTLS";
    renderPanel(state);
    expect(input("grounded-question").value).toBe("mTLS");
  });

  it("renders connector source ids as human-readable labels with the raw id in the tooltip (#427)", () => {
    const state = buildState();
    const rawId =
      "connector:repo:cmexample0000000000acmerp:src/components/wmsCommon/CarrierWithdrawnVO.java";
    // Grounded citation sourced from a raw connector document id.
    state.rounds[0]!.questions[0]!.groundingCitations = [{ source: rawId, snippet: "…" }];

    render(
      <ClarificationDialogPanel
        projectId="proj-1"
        analysisId="ana-1"
        state={state}
        onComplete={() => {}}
      />,
    );

    const source = screen.getByTestId("suggested-answer-source");
    // Visible text is the friendly basename — repo label, NOT the raw id.
    expect(source).toHaveTextContent("CarrierWithdrawnVO.java — acmerp");
    expect(source.textContent).not.toContain("connector:repo:");
    // The full raw id is preserved in the tooltip for copy/deep-link.
    expect(source).toHaveAttribute("title", rawId);
  });

  // #573 — a legacy upload stored under a reserved `connector:repo:` name keeps
  // its name: the label is classified on the cited row's stored source.
  it("labels grounding citations by their stored source, not their name (#573)", () => {
    const state = buildState();
    const legacy = "connector:repo:cmexample0000000000acmerp:src/NOTES.md";
    const repo = "connector:repo:cmexample0000000000acmerp:src/Auth.java";
    state.rounds[0]!.questions[0]!.groundingCitations = [
      { source: legacy, documentSource: "upload", snippet: "…" },
      { source: repo, documentSource: "repo", snippet: "…" },
      { source: legacy, documentSource: "upload", snippet: "again" },
    ];

    render(
      <ClarificationDialogPanel
        projectId="proj-1"
        analysisId="ana-1"
        state={state}
        onComplete={() => {}}
      />,
    );

    const source = screen.getByTestId("suggested-answer-source");
    expect(source).toHaveTextContent(`Suggested answer (from ${legacy}, Auth.java — acmerp)`);
    expect(source).toHaveAttribute("title", `${legacy}, ${repo}`);
  });

  // #573 (review) — the dedupe is keyed by name AND stored source: a legacy
  // upload and a repo row that share one name are two documents, so both labels
  // survive; a true repeat (same name, same source) still collapses.
  it("keeps same-named citations with different stored sources apart (#573)", () => {
    const state = buildState();
    const shared = "connector:repo:cmexample0000000000acmerp:src/Auth.java";
    state.rounds[0]!.questions[0]!.groundingCitations = [
      { source: shared, documentSource: "upload", snippet: "…" },
      { source: shared, documentSource: "repo", snippet: "…" },
      { source: shared, documentSource: "repo", snippet: "repeat" },
    ];

    render(
      <ClarificationDialogPanel
        projectId="proj-1"
        analysisId="ana-1"
        state={state}
        onComplete={() => {}}
      />,
    );

    const source = screen.getByTestId("suggested-answer-source");
    expect(source).toHaveTextContent(`Suggested answer (from ${shared}, Auth.java — acmerp)`);
    expect(source).toHaveAttribute("title", `${shared}, ${shared}`);
  });

  it("renders an open question with a blank input and no suggested-answer affordance", () => {
    render(
      <ClarificationDialogPanel
        projectId="proj-1"
        analysisId="ana-1"
        state={buildState()}
        onComplete={() => {}}
      />,
    );

    const open = screen.getByTestId("open-question");
    expect(open).toBeInTheDocument();

    const input = open.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("");
    // No suggested-answer source within the open question.
    expect(open.querySelector("[data-testid='suggested-answer-source']")).toBeNull();
  });
});
