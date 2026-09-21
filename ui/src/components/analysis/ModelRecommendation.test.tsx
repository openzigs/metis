/**
 * Issue #1095 — ModelRecommendation panel rendering.
 *
 * The reported symptom was a UI line reading "Simple reasoning · ~16 tokens ·
 * ~$0.0000" for a run that went on to consume 185,167 tokens. Asserting that the
 * panel "renders a token count" passed against that bug, so these tests assert
 * substance instead:
 *   - the panel SENDS the run it is sizing (agents + requirement text), so the
 *     server cannot be answering from a constant;
 *   - a null estimate renders as an explicit "unavailable", never as a
 *     plausible-looking number or a $0.0000 cost.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const { ModelRecommendation } = await import("./ModelRecommendation");

const WITH_HISTORY = {
  profile: {
    tokenEstimate: 185_168,
    reasoningDepth: "complex" as const,
    latencySLA: "background" as const,
    taskType: "analysis",
  },
  selection: {
    modelId: "us.anthropic.claude-sonnet-5",
    modelName: "Claude Sonnet 5",
    rationale: "Complex task (analysis): Sonnet required for deep reasoning",
    estimatedCost: 0.555504,
    wasDowngraded: false,
  },
  estimate: {
    tokens: 185_168,
    basis: "prior-runs" as const,
    sampleSize: 3,
    perAgentTokens: 46_292,
  },
};

const NO_HISTORY = {
  profile: {
    tokenEstimate: null,
    reasoningDepth: "moderate" as const,
    latencySLA: "standard" as const,
    taskType: "analysis",
  },
  selection: {
    modelId: "us.anthropic.claude-sonnet-5",
    modelName: "Claude Sonnet 5",
    rationale: "Moderate task (analysis): using Sonnet (system default)",
    estimatedCost: null,
    wasDowngraded: false,
  },
  estimate: {
    tokens: null,
    basis: "no-history" as const,
    sampleSize: 0,
    perAgentTokens: null,
  },
};

function renderPanel(props?: { agentKeys?: string[]; requirementText?: string }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ModelRecommendation
        projectId="proj-1"
        override="auto"
        onOverrideChange={() => {}}
        agentKeys={props?.agentKeys ?? ["document", "code"]}
        requirementText={props?.requirementText ?? ""}
      />
    </QueryClientProvider>,
  );
}

describe("ModelRecommendation (#1095)", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("sends the agents and requirement text it is sizing", async () => {
    mockApiFetch.mockResolvedValue(WITH_HISTORY);
    renderPanel({
      agentKeys: ["document", "code", "database", "web"],
      requirementText: "Enforce inventory availability at checkout.",
    });

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    const [url, options] = mockApiFetch.mock.calls[0] as [
      string,
      { method: string; body: unknown },
    ];
    expect(url).toBe("/projects/proj-1/analyses/model-recommendation");
    expect(options.method).toBe("POST");
    expect(options.body).toEqual({
      override: "auto",
      agentKeys: ["document", "code", "database", "web"],
      requirementText: "Enforce inventory availability at checkout.",
    });
  });

  it("renders the measured estimate with its provenance", async () => {
    mockApiFetch.mockResolvedValue(WITH_HISTORY);
    renderPanel();

    expect(await screen.findByText("~185,168 tokens")).toBeInTheDocument();
    expect(screen.getByText("~$0.5555")).toBeInTheDocument();
    expect(screen.getByText(/Estimated from 3 previous runs/)).toBeInTheDocument();
    expect(screen.getByText(/46,292 tokens per agent/)).toBeInTheDocument();
  });

  it("shows no number at all when there is no history to size from", async () => {
    mockApiFetch.mockResolvedValue(NO_HISTORY);
    renderPanel();

    expect(await screen.findByText("Token estimate unavailable")).toBeInTheDocument();
    expect(screen.getByText(/no completed analysis to size from/)).toBeInTheDocument();
    // The two strings the bug report quoted must not appear.
    expect(screen.queryByText(/~16 tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\.0000/)).not.toBeInTheDocument();
  });
});
