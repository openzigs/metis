/**
 * Self-resolution UI (clarify-self-resolve): a grounded clarifying question
 * renders a "Suggested answer (from <source>)" affordance with a PRE-FILLED
 * input and a grounding badge, while an open question renders a blank input
 * with no affordance.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The component imports the analysis API + the app mutation hook; stub both so
// nothing touches the network on render.
vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return {
    ...actual,
    analysisApi: { clarify: vi.fn() },
  };
});
vi.mock("@/lib/use-app-mutation", () => ({
  useAppMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
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
});

describe("ClarificationDialogPanel self-resolution", () => {
  it("renders a grounded question with a pre-filled input, badge, and source", () => {
    render(
      <ClarificationDialogPanel
        projectId="proj-1"
        analysisId="ana-1"
        state={buildState()}
        onComplete={() => {}}
      />,
    );

    const grounded = screen.getByTestId("grounded-question");
    expect(grounded).toBeInTheDocument();

    // Pre-filled input value = the suggested answer.
    const input = grounded.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("OAuth2 bearer tokens");

    // Badge + citation source shown.
    expect(screen.getByTestId("grounding-badge")).toHaveTextContent(
      "Answered from project knowledge",
    );
    expect(screen.getByTestId("suggested-answer-source")).toHaveTextContent("auth.ts");
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
