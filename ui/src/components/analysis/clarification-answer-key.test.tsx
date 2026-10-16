/**
 * Issue #1031 — an answer typed under a question is submitted against THAT
 * question, whatever order the questions are shown in (#1129 asks questions
 * about ticked items first). The server maps the question to its requirement,
 * so the UI must never send an answer by position.
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

const q = (id: string, requirementId: string, question: string) => ({
  id,
  requirementId,
  ambiguityField: "scope",
  question,
  context: "",
});

function renderWith(questions: ReturnType<typeof q>[]) {
  const state = {
    analysisId: "an_1",
    currentRound: 1,
    maxRounds: 3,
    rounds: [{ round: 1, questions, answers: [] }],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
  } as ClarificationStatePayload;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ClarificationDialogPanel
        projectId="p1"
        analysisId="an_1"
        state={state}
        onComplete={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  submitClarifyAnswers.mockResolvedValue({ state: { completed: false } });
});

describe("#1031 — the Questions panel submits each answer under its own question", () => {
  const upToHere = q("q_r5", "REQ-5", "Does 'up to here' include the selected entry?");
  const olderThan = q("q_r6", "REQ-6", "What is the default age for 'older than X'?");

  it.each([
    ["R5 asked first", [upToHere, olderThan]],
    ["R6 asked first (ticked item, #1129)", [olderThan, upToHere]],
  ])("keys the answer to R6's question when %s", async (_label, questions) => {
    renderWith(questions);

    fireEvent.change(screen.getByLabelText(olderThan.question), { target: { value: "7 days." } });
    fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));

    await waitFor(() => expect(submitClarifyAnswers).toHaveBeenCalled());
    expect(submitClarifyAnswers.mock.calls[0]![2]).toEqual([
      { questionId: "q_r6", answer: "7 days." },
    ]);
  });
});
