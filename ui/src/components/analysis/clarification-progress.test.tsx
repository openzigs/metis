/**
 * Issue #1117 findings A + D — the clarify panel, on the screen where #1104 and
 * #1116 just fixed real loss of the user's answers.
 *
 * A: 14 substantive answers rendered as "1 resolved / 13 remaining", because
 *    every user-facing number came from the resolution model's own tally.
 * D: immediately after Submit the panel flashed "0 of 14 answered" with blank
 *    inputs while the server already held all 14.
 *
 * Both are cosmetic in the sense that no data was lost. Neither is cosmetic to
 * the person reading the screen, which is the whole point of #1104's family.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
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

const question = (field: string, answer?: string) => ({
  id: `q_${field}`,
  requirementId: "r1",
  ambiguityField: field,
  question: `About ${field}?`,
  context: "",
  ...(answer ? { answer } : {}),
});

const state = (over: Partial<ClarificationStatePayload> = {}): ClarificationStatePayload =>
  ({
    analysisId: "an_1",
    currentRound: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [question("dsa"), question("address"), question("prompt")],
        answers: [],
      },
    ],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
    ...over,
  }) as ClarificationStatePayload;

function renderPanel(s: ClarificationStatePayload, onComplete = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onComplete,
    ...render(
      <QueryClientProvider client={qc}>
        <ClarificationDialogPanel
          projectId="p1"
          analysisId="an_1"
          state={s}
          onComplete={onComplete}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  submitClarifyAnswers.mockResolvedValue({ state: { completed: false } });
});

describe("#1117 A — progress counts the user's answers, not the model's tally", () => {
  it("counts an answered ambiguity as addressed even when the model confirmed nothing", () => {
    renderPanel(
      state({
        resolvedAmbiguities: [],
        answeredAmbiguities: ["r1:dsa", "r1:address", "r1:prompt"],
      }),
    );

    const progress = screen.getByTestId("clarification-progress");
    expect(progress).toHaveTextContent("3 addressed");
    expect(progress).toHaveTextContent("0 remaining");
  });

  it("reproduces the reported ratio and no longer reports it as 1 of 14", () => {
    // The live shape: the model confirmed exactly one field; the user answered all.
    renderPanel(
      state({
        resolvedAmbiguities: ["r1:dsa"],
        answeredAmbiguities: ["r1:dsa", "r1:address", "r1:prompt"],
      }),
    );

    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("3 addressed");
    expect(screen.getByTestId("clarification-progress")).not.toHaveTextContent("1 addressed");
  });

  it("still shows work outstanding when a question is genuinely unanswered", () => {
    renderPanel(state({ answeredAmbiguities: ["r1:dsa"] }));

    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("2 remaining");
  });

  it("falls back cleanly for a dialog persisted before #1117", () => {
    renderPanel(state({ resolvedAmbiguities: ["r1:dsa"] }));

    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("1 addressed");
  });

  it("separates the model's confirmations from the user's answers when complete", () => {
    renderPanel(
      state({
        completed: true,
        resolvedAmbiguities: ["r1:dsa"],
        answeredAmbiguities: ["r1:dsa", "r1:address", "r1:prompt"],
        rounds: [
          {
            round: 1,
            questions: [
              question("dsa", "no"),
              question("address", "on the order"),
              question("prompt", "dismissible"),
            ],
            answers: [],
          },
        ],
      }),
    );

    expect(screen.getByTestId("clarification-complete")).toHaveTextContent(
      /3 ambiguities addressed/,
    );
    expect(screen.getByTestId("clarification-model-confirmed")).toHaveTextContent(
      /confirmed 1 of these as fully resolved/,
    );
    expect(screen.getByTestId("clarification-model-confirmed")).toHaveTextContent(
      /no answer was discarded/,
    );
  });

  it("omits the confirmation caveat when the model kept up", () => {
    renderPanel(
      state({
        completed: true,
        resolvedAmbiguities: ["r1:dsa"],
        answeredAmbiguities: ["r1:dsa"],
        rounds: [{ round: 1, questions: [question("dsa", "no")], answers: [] }],
      }),
    );

    expect(screen.queryByTestId("clarification-model-confirmed")).not.toBeInTheDocument();
  });
});

describe("#1117 D — answers stay on screen across a submit", () => {
  it("does not blank the inputs when the submit succeeds", async () => {
    renderPanel(state());

    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0]!, { target: { value: "The DSA does not apply." } });
    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("1 of 3 answered");

    fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));
    await waitFor(() => expect(submitClarifyAnswers).toHaveBeenCalled());

    // The refetch has not landed yet. Before #1117 the panel cleared local state
    // in `onSuccess`, so this is the exact moment it read "0 of 3 answered"
    // with an empty box while the server already held the answer.
    await waitFor(() =>
      expect(screen.getByTestId("clarification-progress")).toHaveTextContent("1 of 3 answered"),
    );
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe(
      "The DSA does not apply.",
    );
  });

  it("re-seeds from a round persisted before the server stamped q.answer", () => {
    // Back-compat path: older rounds carry the text only in `answers[]`. The
    // re-seed key must notice a change there too, or those dialogs keep the
    // blank-form behaviour #1117 D reported.
    renderPanel(
      state({
        rounds: [
          {
            round: 1,
            questions: [question("dsa"), question("address"), question("prompt")],
            answers: [{ questionId: "q_dsa", answer: "legacy answer" }],
          },
        ],
      }),
    );

    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("legacy answer");
    expect(screen.getByTestId("clarification-progress")).toHaveTextContent("1 of 3 answered");
  });

  it("re-seeds from the server once the refetched round carries the answers", () => {
    const { rerender } = renderPanel(state());
    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe("");

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <ClarificationDialogPanel
          projectId="p1"
          analysisId="an_1"
          state={state({
            rounds: [
              {
                round: 1,
                questions: [
                  question("dsa", "server-held answer"),
                  question("address"),
                  question("prompt"),
                ],
                answers: [],
              },
            ],
          })}
          onComplete={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect((screen.getAllByRole("textbox")[0] as HTMLInputElement).value).toBe(
      "server-held answer",
    );
  });
});
