/**
 * #2270 — an Impact Analysis run and a portfolio check ask their clarifying
 * questions in the same `ClarificationDialogPanel` as a requirements analysis,
 * on their own pages: nothing is asked until the analyst clicks (#2509), the
 * answers go to the result's own endpoint, and the panel offers no CSV
 * round-trip, which only an analysis has.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClarificationStatePayload, StructuredRequirementsPayload } from "@/lib/analysis-api";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  start: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("@/lib/subject-clarify-api", () => ({ subjectClarifyApi: api }));
const analysisApiCalls = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: new Proxy(
      {},
      {
        get: (_t, prop) => () => analysisApiCalls(prop),
      },
    ),
  };
});

const { SubjectClarificationSection } = await import("./subject-clarification-section");

const REQUIREMENTS: StructuredRequirementsPayload = {
  requirements: [
    {
      id: "T1",
      title: "Search returns results fast.",
      description: "Search returns results fast.",
      type: "functional",
      stakeholders: [],
      priority: "should-have",
      ambiguities: [{ field: "R7:fast", description: "Vague term", suggestedQuestion: "" }],
      evidenceNeeds: [],
      rawSource: "Search results must be returned fast.",
    },
  ],
  totalAmbiguities: 1,
  totalEvidenceNeeds: 0,
} as unknown as StructuredRequirementsPayload;

const OPEN: ClarificationStatePayload = {
  analysisId: "ia-1",
  currentRound: 1,
  maxRounds: 3,
  rounds: [
    {
      round: 1,
      questions: [
        {
          id: "q1",
          requirementId: "T1",
          ambiguityField: "R7:fast",
          question: "How fast must search results be returned?",
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
} as unknown as ClarificationStatePayload;

function renderSection(kind: "impact" | "portfolio" = "impact", canRun = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SubjectClarificationSection kind={kind} id="ia-1" canRun={canRun} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.get.mockReset();
  api.start.mockReset();
  api.submit.mockReset();
  analysisApiCalls.mockReset();
});

describe("#2270 — SubjectClarificationSection", () => {
  it("renders nothing for a result with no dialog", async () => {
    api.get.mockResolvedValue({ state: null, requirements: null });
    const { container } = renderSection();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("impact", "ia-1"));
    expect(container.textContent).toBe("");
  });

  it("lists what it would ask about and asks only on the analyst's click", async () => {
    api.get.mockResolvedValue({ state: null, requirements: REQUIREMENTS });
    api.start.mockResolvedValue(OPEN);
    renderSection("portfolio");
    expect(await screen.findByText("Search returns results fast.")).toBeTruthy();
    expect(screen.getByText(/found 1 place in 1 requirement/)).toBeTruthy();
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("subject-clarify-ask"));
    await waitFor(() => expect(api.start).toHaveBeenCalledWith("portfolio", "ia-1"));
    // The round it started is shown in the same panel, with no CSV round-trip.
    expect(await screen.findByText("How fast must search results be returned?")).toBeTruthy();
    expect(screen.queryByText("Export questions")).toBeNull();
    expect(screen.queryByText(/export them to CSV/)).toBeNull();
  });

  it("submits the typed answers to the result's own endpoint, never the analysis's", async () => {
    const done = { ...OPEN, completed: true, answeredAmbiguities: ["T1:R7:fast"] };
    api.get.mockResolvedValueOnce({ state: OPEN, requirements: REQUIREMENTS });
    // The read after the submit sees what the submit wrote.
    api.get.mockResolvedValue({ state: done, requirements: REQUIREMENTS });
    api.submit.mockResolvedValue({ state: done, updatedRequirements: REQUIREMENTS });
    renderSection("impact");
    const box = await screen.findByLabelText(/How fast must search results be returned/);
    fireEvent.change(box, { target: { value: "Under one second" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() =>
      expect(api.submit).toHaveBeenCalledWith("impact", "ia-1", [
        { questionId: "q1", answer: "Under one second" },
      ]),
    );
    expect(await screen.findByTestId("clarification-complete")).toBeTruthy();
    expect(analysisApiCalls).not.toHaveBeenCalled();
  });

  it("prepares a due round at once, and says asking needs analysis.run to a reader", async () => {
    api.get.mockResolvedValue({
      state: { ...OPEN, currentRound: 2 },
      requirements: REQUIREMENTS,
    });
    api.start.mockResolvedValue({ ...OPEN, currentRound: 2 });
    renderSection("impact");
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(1));

    api.start.mockClear();
    api.get.mockResolvedValue({ state: null, requirements: REQUIREMENTS });
    renderSection("impact", false);
    expect(await screen.findAllByText(/needs the analysis.run permission/)).toBeTruthy();
    expect(screen.queryByTestId("subject-clarify-ask")).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
  });
});
