/**
 * Issue #1135 — the clarifying-questions panel never started without a reload.
 *
 * `ClarificationSection` ran ONE query whose `queryFn` both read the persisted
 * dialog and decided whether to start a new one. That decision read
 * `structuredRequirements.totalAmbiguities`, which is still 0 while the run is
 * in flight, so the query resolved `null` — and with a run-status-free
 * `queryKey`, `retry: false` and no invalidation, that `null` was cached for the
 * life of the mount. The user sat on the read-only preview forever; a reload
 * remounted with ambiguities already present and the POST fired.
 *
 * The fix must satisfy TWO opposing failure modes at once:
 *   - #1135: start the dialog once the run completes and ambiguities appear.
 *   - #1104 finding C: keep an EXISTING dialog reachable after
 *     `totalAmbiguities` falls back to 0 once a round is answered. That is why
 *     the old `enabled: hasAmbiguities` gate was removed in the first place —
 *     reinstating it would bury the user's answers again.
 *
 * Also covered here (same staleness family, stated in #1135): the analysis
 * detail — the source of `ClarificationImpactNote` — must be refetched when a
 * submit succeeds, instead of waiting for a page reload.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ClarificationStatePayload } from "@/lib/analysis-api";

const getClarification = vi.fn();
const clarify = vi.fn();
const submitClarifyAnswers = vi.fn();

vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      getClarification: (...args: unknown[]) => getClarification(...args),
      clarify: (...args: unknown[]) => clarify(...args),
      submitClarifyAnswers: (...args: unknown[]) => submitClarifyAnswers(...args),
      exportClarifyCsv: vi.fn(),
      importClarifyAnswers: vi.fn(),
    },
  };
});

const { EnhancementResults } = await import("@/components/analysis/EnhancementResults");

const ANALYSIS_ID = "an_1135";

/** Analysis metadata as the page hands it down, at a given ambiguity count. */
function metadata(
  totalAmbiguities: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    enhancement: { enableWebResearch: false, enableClarification: true },
    structuredRequirements: {
      requirements: [
        {
          id: "r1",
          title: "Consent banner",
          description: "",
          ambiguities:
            totalAmbiguities > 0
              ? [
                  {
                    field: "dsa",
                    description: "scope unclear",
                    suggestedQuestion: "Does the DSA apply?",
                  },
                ]
              : [],
          evidenceNeeds: [],
        },
      ],
      totalAmbiguities,
      totalEvidenceNeeds: 0,
    },
    ...extra,
  };
}

const dialogState = (over: Partial<ClarificationStatePayload> = {}): ClarificationStatePayload =>
  ({
    analysisId: ANALYSIS_ID,
    currentRound: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: "q_dsa",
            requirementId: "r1",
            ambiguityField: "dsa",
            question: "Does the DSA apply?",
            context: "",
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

function renderResults(meta: Record<string, unknown>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={qc}>
      <EnhancementResults projectId="p1" analysisId={ANALYSIS_ID} metadata={meta} />
    </QueryClientProvider>,
  );
  const rerenderWith = (next: Record<string, unknown>) =>
    view.rerender(
      <QueryClientProvider client={qc}>
        <EnhancementResults projectId="p1" analysisId={ANALYSIS_ID} metadata={next} />
      </QueryClientProvider>,
    );
  return { ...view, qc, invalidateSpy, rerenderWith };
}

beforeEach(() => {
  vi.clearAllMocks();
  getClarification.mockResolvedValue({ state: null });
  clarify.mockResolvedValue(dialogState());
  submitClarifyAnswers.mockResolvedValue({ state: dialogState() });
});

describe("#1135 — the dialog starts once the run completes, with no reload", () => {
  it("issues the POST when ambiguities appear after the query first resolved with 0", async () => {
    // Mid-run: the analysis is still writing metadata, so totalAmbiguities is 0.
    const { rerenderWith } = renderResults(metadata(0));

    await waitFor(() => expect(getClarification).toHaveBeenCalled());
    expect(clarify).not.toHaveBeenCalled();

    // The run completes; the page's polling detail query hands down the real
    // ambiguity count. Before the fix, the cached `null` won and no POST fired.
    rerenderWith(metadata(3));

    await waitFor(() => expect(clarify).toHaveBeenCalledWith("p1", ANALYSIS_ID, {}));
    expect(await screen.findByTestId("clarification-progress")).toBeInTheDocument();
    expect(screen.queryByTestId("gaps-preview")).not.toBeInTheDocument();
  });

  it("shows the read-only preview, not the interactive panel, until the POST lands", async () => {
    let resolveStart: (s: ClarificationStatePayload) => void = () => {};
    clarify.mockImplementation(
      () =>
        new Promise<ClarificationStatePayload>((resolve) => {
          resolveStart = resolve;
        }),
    );

    renderResults(metadata(1));

    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("gaps-preview")).toHaveTextContent(/Preparing an interactive/);
    expect(screen.queryByRole("button", { name: /submit answers/i })).not.toBeInTheDocument();

    resolveStart(dialogState());
    expect(await screen.findByTestId("clarification-progress")).toBeInTheDocument();
  });

  it("starts exactly one dialog even as the metadata keeps arriving", async () => {
    const { rerenderWith } = renderResults(metadata(0));
    await waitFor(() => expect(getClarification).toHaveBeenCalled());

    rerenderWith(metadata(3));
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));

    // The detail query polls; each poll re-renders this subtree.
    rerenderWith(metadata(3, { promotionStatus: "allowed" }));
    rerenderWith(metadata(3, { promotionStatus: "blocked" }));

    await waitFor(() => expect(screen.getByTestId("clarification-progress")).toBeInTheDocument());
    expect(clarify).toHaveBeenCalledTimes(1);
  });

  it("never starts a dialog speculatively while the run reports no ambiguities", async () => {
    renderResults(metadata(0));

    await waitFor(() => expect(getClarification).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("gaps-preview")).not.toBeInTheDocument());
    expect(clarify).not.toHaveBeenCalled();
  });

  it("does not retry the start after the server rejects it, and says the start failed", async () => {
    clarify.mockRejectedValue(new Error("clarify failed"));

    const { rerenderWith } = renderResults(metadata(2));
    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));

    rerenderWith(metadata(2, { promotionStatus: "allowed" }));
    // A start that never happens must not read as one still in progress.
    expect(await screen.findByTestId("clarify-start-error")).toBeInTheDocument();
    expect(screen.getByTestId("gaps-preview")).toBeInTheDocument();
    expect(clarify).toHaveBeenCalledTimes(1);
  });

  it("retries the start only when the user asks", async () => {
    clarify.mockRejectedValueOnce(new Error("clarify failed")).mockResolvedValue(dialogState());

    renderResults(metadata(2));
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));

    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("clarification-progress")).toBeInTheDocument();
  });
});

describe("#1104 finding C — a completed dialog stays reachable at 0 ambiguities", () => {
  it("renders the persisted dialog when totalAmbiguities has dropped back to 0", async () => {
    getClarification.mockResolvedValue({
      state: dialogState({
        completed: true,
        resolvedAmbiguities: ["r1:dsa"],
        answeredAmbiguities: ["r1:dsa"],
        rounds: [
          {
            round: 1,
            questions: [
              {
                id: "q_dsa",
                requirementId: "r1",
                ambiguityField: "dsa",
                question: "Does the DSA apply?",
                context: "",
                answer: "No, it does not apply.",
              },
            ],
            answers: [],
          },
        ],
      }),
    });

    renderResults(metadata(0));

    // The user's answer must still be on screen — this is the regression #1104
    // finding C fixed, and #1135's fix must not undo it.
    expect(await screen.findByTestId("clarification-complete")).toHaveTextContent(
      /1 ambiguity addressed/,
    );
    expect(await screen.findByText("No, it does not apply.")).toBeInTheDocument();
    // Reading is free; starting a new round is not — no POST for a dialog that
    // already exists.
    expect(clarify).not.toHaveBeenCalled();
  });

  it("keeps an in-progress dialog on screen when the count drops to 0 mid-session", async () => {
    getClarification.mockResolvedValue({ state: dialogState() });

    const { rerenderWith } = renderResults(metadata(1));
    expect(await screen.findByTestId("clarification-progress")).toBeInTheDocument();

    rerenderWith(metadata(0));

    expect(screen.getByTestId("clarification-progress")).toBeInTheDocument();
    expect(clarify).not.toHaveBeenCalled();
  });
});

describe("#1135 — the impact note refreshes without a reload", () => {
  it("invalidates the analysis detail when a submit succeeds", async () => {
    getClarification.mockResolvedValue({ state: dialogState() });

    const { invalidateSpy } = renderResults(metadata(1));
    await screen.findByTestId("clarification-progress");

    fireEvent.change(screen.getAllByRole("textbox")[0]!, {
      target: { value: "No, it does not apply." },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit answers/i }));

    await waitFor(() => expect(submitClarifyAnswers).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["analyses", "detail", ANALYSIS_ID],
      }),
    );
  });

  it("renders the impact note straight from refreshed metadata", async () => {
    getClarification.mockResolvedValue({ state: dialogState() });

    const { rerenderWith } = renderResults(metadata(1));
    await screen.findByTestId("clarification-progress");
    expect(screen.queryByTestId("clarification-impact")).not.toBeInTheDocument();

    // What the refetched detail brings back after the server applied answers.
    rerenderWith(
      metadata(1, {
        clarificationApplication: {
          answeredCount: 3,
          appliedCount: 3,
          unattributedCount: 0,
          requirementsUpdated: 2,
          requirementsAvailable: true,
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      }),
    );

    expect(screen.getByTestId("clarification-impact")).toHaveTextContent(
      /3 of 3 answers were written into the saved requirements/,
    );
    expect(screen.queryByTestId("clarification-unattributed")).not.toBeInTheDocument();
  });
});

describe("EnhancementResults — surrounding render branches", () => {
  it("renders nothing when neither enhancement was requested", () => {
    const { container } = renderResults({
      enhancement: { enableWebResearch: false, enableClarification: false },
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the web-research evidence with trust badges and the review marker", async () => {
    renderResults({
      enhancement: { enableWebResearch: true, enableClarification: false },
      webResearch: {
        digests: [
          {
            id: "d1",
            requirementId: "r1",
            evidenceNeedId: "e1",
            query: "DSA scope",
            digest: "The DSA applies to platforms above a size threshold.",
            needsHumanReview: true,
            sources: [
              {
                url: "https://eur-lex.europa.eu/a",
                title: "EUR-Lex",
                domainTrust: "high",
              },
              { url: "https://blog.example/b", title: "A blog", domainTrust: "low" },
            ],
          },
          {
            id: "d2",
            requirementId: "r2",
            evidenceNeedId: "e2",
            query: "Retention period",
            digest: "No clear answer found.",
            needsHumanReview: false,
            sources: [],
          },
        ],
        totalSources: 2,
        reviewRequired: 1,
      },
    });

    expect(screen.getByText("Evidence Review")).toBeInTheDocument();
    expect(screen.getByText("Needs Review")).toBeInTheDocument();
    expect(screen.getByText("High Trust")).toBeInTheDocument();
    expect(screen.getByText("Low Trust")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "EUR-Lex" })).toHaveAttribute(
      "href",
      "https://eur-lex.europa.eu/a",
    );
    // The clarification half is off, so no dialog is read or started.
    expect(getClarification).not.toHaveBeenCalled();
  });

  it("says so when web research produced no evidence", () => {
    renderResults({
      enhancement: { enableWebResearch: true, enableClarification: false },
      webResearch: { digests: [], totalSources: 0, reviewRequired: 0 },
    });
    expect(screen.getByText("No web research evidence to review.")).toBeInTheDocument();
  });

  it("falls back to a plain spinner card when the count is up but no gap is itemised", async () => {
    let resolveStart: (s: ClarificationStatePayload) => void = () => {};
    clarify.mockImplementation(
      () =>
        new Promise<ClarificationStatePayload>((resolve) => {
          resolveStart = resolve;
        }),
    );

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: {
        requirements: [
          {
            id: "r1",
            title: "Consent banner",
            description: "",
            ambiguities: [],
            evidenceNeeds: [],
          },
        ],
        totalAmbiguities: 2,
        totalEvidenceNeeds: 0,
      },
    });

    await waitFor(() => expect(clarify).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Preparing clarifying questions…")).toBeInTheDocument();
    resolveStart(dialogState());
    expect(await screen.findByTestId("clarification-progress")).toBeInTheDocument();
  });

  it("previews an ambiguity that carries only a description", async () => {
    clarify.mockImplementation(() => new Promise<ClarificationStatePayload>(() => {}));

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: {
        requirements: [
          {
            id: "r1",
            title: "Consent banner",
            description: "",
            ambiguities: [
              { field: "dsa", description: "Scope is unclear.", suggestedQuestion: "" },
            ],
            evidenceNeeds: [],
          },
        ],
        totalAmbiguities: 1,
        totalEvidenceNeeds: 0,
      },
    });

    const preview = await screen.findByTestId("gaps-preview");
    expect(preview).toHaveTextContent("Scope is unclear.");
    // With no suggestedQuestion there is no second "field — description" line.
    expect(preview).not.toHaveTextContent("dsa —");
  });

  it("shows the all-clear banner and evidence-need count", () => {
    renderResults(
      metadata(0, {
        structuredRequirements: {
          requirements: [],
          totalAmbiguities: 0,
          totalEvidenceNeeds: 0,
        },
      }),
    );
    expect(screen.getByTestId("gaps-summary")).toHaveTextContent(/No open questions/);
  });

  it("counts evidence needs in the gaps banner", async () => {
    clarify.mockImplementation(() => new Promise<ClarificationStatePayload>(() => {}));
    renderResults(
      metadata(1, {
        structuredRequirements: {
          requirements: [
            {
              id: "r1",
              title: "Consent banner",
              description: "Shown on first visit.",
              ambiguities: [
                { field: "dsa", description: "scope unclear", suggestedQuestion: "Does it apply?" },
              ],
              evidenceNeeds: [{ description: "Cite the DSA threshold." }],
            },
          ],
          totalAmbiguities: 1,
          totalEvidenceNeeds: 1,
        },
      }),
    );
    expect(screen.getByTestId("gaps-summary")).toHaveTextContent(/1 evidence needs/);
    expect(await screen.findByTestId("gaps-preview")).toHaveTextContent("Shown on first visit.");
  });
});
