/**
 * EnhancementResults tests (Epic #922, issues #926/#927).
 *
 * Covers the opt-in gating, the web-research Evidence Review panel (digests,
 * trust badges, needs-review marker, empty state), and the clarification
 * section (server-sourced dialog fetch + completion).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi } = vi.hoisted(() => ({
  analysisApi: { clarify: vi.fn(), getClarification: vi.fn(), submitClarifyAnswers: vi.fn() },
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});

import { EnhancementResults } from "@/components/analysis/EnhancementResults";

function renderResults(metadata: Record<string, unknown> | null) {
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
});

describe("EnhancementResults", () => {
  it("renders nothing when neither enhancement flag ran", () => {
    const { container } = renderResults({ agentKeys: ["document"] });
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when metadata is null", () => {
    const { container } = renderResults(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the evidence empty state when web research yielded no digests", () => {
    renderResults({
      enhancement: { enableWebResearch: true, enableClarification: false },
      webResearch: { digests: [], totalSources: 0, reviewRequired: 0 },
    });
    expect(screen.getByText("Evidence Review")).toBeInTheDocument();
    expect(screen.getByText("No web research evidence to review.")).toBeInTheDocument();
  });

  it("renders digests with trust badges and a needs-review marker", () => {
    renderResults({
      enhancement: { enableWebResearch: true, enableClarification: false },
      webResearch: {
        digests: [
          {
            id: "dig-1",
            requirementId: "req-1",
            evidenceNeedId: "ev-1",
            query: "NERC CIP retention",
            sources: [
              {
                url: "https://www.nerc.com/policy",
                title: "NERC policy",
                excerpt: "...",
                relevanceScore: 0.9,
                domainTrust: "high",
              },
              {
                url: "https://reddit.com/r/x",
                title: "Forum thread",
                excerpt: "...",
                relevanceScore: 0.2,
                domainTrust: "low",
              },
            ],
            digest: "Logs must be retained 3 years.",
            needsHumanReview: true,
          },
        ],
        totalSources: 2,
        reviewRequired: 1,
      },
    });
    expect(screen.getByText("NERC CIP retention")).toBeInTheDocument();
    expect(screen.getByText("Logs must be retained 3 years.")).toBeInTheDocument();
    expect(screen.getByText("High Trust")).toBeInTheDocument();
    expect(screen.getByText("Low Trust")).toBeInTheDocument();
    expect(screen.getByText("Needs Review")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "NERC policy" })).toHaveAttribute(
      "href",
      "https://www.nerc.com/policy",
    );
  });

  it("does not render the evidence panel when web research was not enabled", () => {
    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
    });
    expect(screen.queryByText("Evidence Review")).not.toBeInTheDocument();
  });

  const roundOneState = {
    analysisId: "ana-1",
    currentRound: 1,
    maxRounds: 3,
    rounds: [
      {
        round: 1,
        questions: [
          {
            id: "q1",
            requirementId: "req-1",
            ambiguityField: "duration",
            question: "How long must logs be retained?",
            context: "Retention period is unspecified.",
          },
        ],
        answers: [],
      },
    ],
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
  };

  it("starts a new clarification dialog when none is persisted yet", async () => {
    // No durable state → fall back to POST /clarify to start a round.
    analysisApi.getClarification.mockResolvedValue({ state: null });
    analysisApi.clarify.mockResolvedValue(roundOneState);

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: { requirements: [], totalAmbiguities: 2, totalEvidenceNeeds: 0 },
    });

    await waitFor(() =>
      expect(analysisApi.getClarification).toHaveBeenCalledWith("proj-1", "ana-1"),
    );
    await waitFor(() => expect(analysisApi.clarify).toHaveBeenCalledWith("proj-1", "ana-1", {}));
    expect(await screen.findByText("How long must logs be retained?")).toBeInTheDocument();
  });

  it("rehydrates an in-flight dialog from persisted state after reload (#213)", async () => {
    // Durable state exists → resume it WITHOUT starting a new round (no POST).
    analysisApi.getClarification.mockResolvedValue({
      state: { ...roundOneState, resolvedAmbiguities: ["req-1:scope"] },
    });

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: { requirements: [], totalAmbiguities: 2, totalEvidenceNeeds: 0 },
    });

    await waitFor(() =>
      expect(analysisApi.getClarification).toHaveBeenCalledWith("proj-1", "ana-1"),
    );
    // Resumed from persisted state, so no new round was started.
    expect(analysisApi.clarify).not.toHaveBeenCalled();
    expect(await screen.findByText("How long must logs be retained?")).toBeInTheDocument();
    // Addressed vs remaining are shown from persisted state. Issue #1117
    // (finding A) renamed the first badge: it now counts the union of what the
    // user answered and what the model closed, so a stingy resolution model can
    // no longer report a fully-answered round as untouched.
    const progress = await screen.findByTestId("clarification-progress");
    expect(progress).toHaveTextContent("1 addressed");
    expect(progress).toHaveTextContent("1 remaining");
  });

  it("renders the collaboration discoverability hint when clarification ran with structured output", () => {
    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
    });
    const hint = screen.getByTestId("collaboration-hint");
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent(/clarifying questions/i);
    expect(hint).toHaveTextContent(/Approve\/Reject/i);
    expect(hint).toHaveTextContent(/export questions/i);
  });

  it("does not render the collaboration hint when clarification did not run", () => {
    renderResults({
      enhancement: { enableWebResearch: true, enableClarification: false },
      webResearch: { digests: [], totalSources: 0, reviewRequired: 0 },
    });
    expect(screen.queryByTestId("collaboration-hint")).not.toBeInTheDocument();
  });

  it("never STARTS a dialog when there are no ambiguities (#1104: the read still runs)", async () => {
    // Issue #1104 (finding C) — the cheap GET always runs, because
    // `totalAmbiguities` drops to 0 once a round is answered and an existing
    // (answered) dialog must stay reachable. Only the expensive, LLM-backed
    // START is gated on there being something to ask.
    analysisApi.getClarification.mockResolvedValue({ state: null });

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
    });

    await waitFor(() =>
      expect(analysisApi.getClarification).toHaveBeenCalledWith("proj-1", "ana-1"),
    );
    expect(analysisApi.clarify).not.toHaveBeenCalled();
  });

  // ── Surface analysis gaps + clarifications (current branch) ────────────────

  /**
   * Realistic fixture mirroring a validated run: 10 requirements carrying 28
   * ambiguities in total, each with a concrete suggestedQuestion string.
   */
  function buildStructuredRequirements() {
    const ambiguityCounts = [4, 3, 3, 3, 3, 3, 3, 2, 2, 2]; // sums to 28
    const requirements = ambiguityCounts.map((count, idx) => ({
      id: `req-${idx + 1}`,
      title: `Requirement ${idx + 1} title`,
      description: `Requirement ${idx + 1} description body.`,
      ambiguities: Array.from({ length: count }, (_, a) => ({
        field: `field-${idx + 1}-${a + 1}`,
        description: `Ambiguity ${a + 1} on requirement ${idx + 1}.`,
        suggestedQuestion: `Question ${idx + 1}.${a + 1}: please clarify field ${a + 1}?`,
      })),
      evidenceNeeds: [],
    }));
    return {
      requirements,
      totalAmbiguities: 28,
      totalEvidenceNeeds: 5,
    };
  }

  it("renders a gaps summary banner with ambiguity + requirement counts", async () => {
    analysisApi.getClarification.mockResolvedValue({ state: null });
    analysisApi.clarify.mockRejectedValue(new Error("no interactive dialog persisted"));

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: buildStructuredRequirements(),
    });

    const banner = await screen.findByTestId("gaps-summary");
    expect(banner).toHaveTextContent("28 open questions");
    expect(banner).toHaveTextContent("10 requirements");
  });

  it("renders the positive no-gaps state when totalAmbiguities is 0", () => {
    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: {
        requirements: [
          { id: "req-1", title: "R1", description: "d", ambiguities: [], evidenceNeeds: [] },
        ],
        totalAmbiguities: 0,
        totalEvidenceNeeds: 0,
      },
    });
    const banner = screen.getByTestId("gaps-summary");
    expect(banner).toHaveTextContent("No open questions");
  });

  it("shows a READ-ONLY gaps preview (no Submit) while the real dialog start is in flight", async () => {
    // Start round-trip is pending: GET resolves null, the POST start never
    // settles during this assertion window. The preview surfaces the gaps from
    // structuredRequirements so the panel is never a bare spinner, but it must
    // NOT offer a Submit control — answers can only be posted through the
    // interactive dialog with real server question ids.
    analysisApi.getClarification.mockResolvedValue({ state: null });
    analysisApi.clarify.mockReturnValue(new Promise(() => {}));

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: buildStructuredRequirements(),
    });

    // A specific suggestedQuestion is surfaced as a read-only preview…
    expect(await screen.findByText("Question 1.1: please clarify field 1?")).toBeInTheDocument();
    // …and the requirement title that groups it is shown.
    expect(screen.getByText("Requirement 1 title")).toBeInTheDocument();
    // …the preview container is rendered…
    expect(screen.getByTestId("gaps-preview")).toBeInTheDocument();
    // …and crucially there is NO submit affordance and NO answer inputs in the
    // preview (those would otherwise post fabricated questionIds).
    expect(screen.queryByRole("button", { name: "Submit Answers" })).not.toBeInTheDocument();
    expect(document.querySelector("input")).toBeNull();
  });

  it("never offers a fabricated-id submit path when the dialog start fails", async () => {
    // This is the exact case the old static fallback mishandled: GET → null and
    // the POST `{}` start rejects (no usable interactive dialog). Old behavior
    // rendered an editable static panel whose Submit posted a fabricated
    // `${requirementId}:${field}` questionId the server could not match. The
    // preview must stay read-only — no inputs, no Submit — so there is NO path
    // that posts a fabricated id.
    analysisApi.getClarification.mockResolvedValue({ state: null });
    analysisApi.clarify.mockRejectedValue(new Error("no interactive dialog persisted"));

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: buildStructuredRequirements(),
    });

    expect(await screen.findByText("Question 1.1: please clarify field 1?")).toBeInTheDocument();
    await waitFor(() => expect(analysisApi.clarify).toHaveBeenCalledWith("proj-1", "ana-1", {}));
    // No Submit control and no answer inputs exist…
    expect(screen.queryByRole("button", { name: "Submit Answers" })).not.toBeInTheDocument();
    expect(document.querySelector("input")).toBeNull();
    // …so the only `clarify` calls are the GET-less start `{}` — an answers
    // payload (least of all a fabricated `${reqId}:${field}` one) is never sent.
    expect(analysisApi.clarify).not.toHaveBeenCalledWith(
      "proj-1",
      "ana-1",
      expect.objectContaining({ answers: expect.anything() }),
    );
  });

  it("submits answers with the REAL server-issued question id once the dialog has started", async () => {
    // GET has no persisted state; POST `{}` starts a real server dialog and
    // returns questions whose ids are server-generated UUIDs (here `q1`). The
    // submitted answer MUST carry that real `q.id` — not a fabricated
    // `${requirementId}:${field}` key, which the server cannot match.
    analysisApi.getClarification.mockResolvedValue({ state: null });
    // First call (start `{}`) returns the started dialog with real-id questions.
    analysisApi.clarify.mockResolvedValueOnce(roundOneState);
    // The submit goes through the dedicated answers call (#1104), whose
    // response is `{ state, updatedRequirements }` — not a bare state.
    analysisApi.submitClarifyAnswers.mockResolvedValueOnce({
      state: { ...roundOneState, completed: true },
      updatedRequirements: { requirements: [], totalAmbiguities: 0, totalEvidenceNeeds: 0 },
    });

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: buildStructuredRequirements(),
    });

    // The interactive dialog (real server question) is what gets rendered.
    const questionLabel = await screen.findByText("How long must logs be retained?");
    const input = questionLabel.parentElement?.querySelector("input");
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { value: "Three years" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));

    // The answer carries the server-issued q.id ("q1"), proving we no longer
    // fabricate `req-1:field-1-1`. This assertion FAILS against the old static
    // fallback (which posted the fabricated `${reqId}:${field}` key).
    await waitFor(() =>
      expect(analysisApi.submitClarifyAnswers).toHaveBeenCalledWith("proj-1", "ana-1", [
        { questionId: "q1", answer: "Three years" },
      ]),
    );
    // And it NEVER posts the fabricated `${requirementId}:${field}` key.
    expect(analysisApi.submitClarifyAnswers).not.toHaveBeenCalledWith("proj-1", "ana-1", [
      { questionId: "req-1:field-1-1", answer: "Three years" },
    ]);
  });

  it("prefers the interactive clarify dialog when one is persisted", async () => {
    analysisApi.getClarification.mockResolvedValue({ state: roundOneState });

    renderResults({
      enhancement: { enableWebResearch: false, enableClarification: true },
      structuredRequirements: buildStructuredRequirements(),
    });

    // Interactive question (from dialog) wins over the static fallback.
    expect(await screen.findByText("How long must logs be retained?")).toBeInTheDocument();
  });
});
