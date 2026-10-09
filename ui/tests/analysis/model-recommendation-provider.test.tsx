/**
 * #978 — the analysis page's Model override offers the forced Claude tiers only
 * where the active provider serves them. On a DeepSeek-only deployment it
 * offers Auto plus the configured model, by the same `servesTierModels` rule
 * the model preferences use (#713).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "../test-utils";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
import { ModelRecommendation } from "@/components/analysis/ModelRecommendation";

const apiFetchMock = vi.mocked(apiFetch);

function recommendation(extra: Record<string, unknown>) {
  return {
    profile: {
      tokenEstimate: null,
      reasoningDepth: "moderate",
      latencySLA: "standard",
      taskType: "analysis",
    },
    selection: {
      modelId: "deepseek-flash",
      modelName: "deepseek-flash",
      rationale: "Using the anthropic provider's configured model (deepseek-flash)",
      estimatedCost: null,
      wasDowngraded: false,
    },
    estimate: { tokens: null, basis: "no-history", sampleSize: 0, perAgentTokens: null },
    ...extra,
  };
}

async function openOptions(onOverrideChange = vi.fn()): Promise<string[]> {
  const user = userEvent.setup();
  render(
    <ModelRecommendation
      projectId="p1"
      override="auto"
      onOverrideChange={onOverrideChange}
      agentKeys={["document"]}
      requirementText=""
    />,
    { wrapper: makeWrapper() },
  );
  await waitFor(() => expect(screen.getByTestId("model-recommendation")).toBeInTheDocument());
  await user.click(screen.getByRole("combobox", { name: "Model override" }));
  const options = await screen.findAllByRole("option");
  return options.map((o) => o.textContent ?? "");
}

describe("<ModelRecommendation /> override options (#978)", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("offers Auto plus the configured model on a provider that serves no Claude tiers", async () => {
    apiFetchMock.mockResolvedValue(
      recommendation({ servesTierModels: false, configuredModel: "deepseek-flash" }),
    );
    const labels = await openOptions();
    expect(labels).toEqual(["Auto", "deepseek-flash"]);
    expect(labels.join(" ")).not.toMatch(/Haiku|Sonnet|Fable|Opus/);
  });

  it("selecting the configured model passes its id as the override", async () => {
    apiFetchMock.mockResolvedValue(
      recommendation({ servesTierModels: false, configuredModel: "deepseek-flash" }),
    );
    const onChange = vi.fn();
    await openOptions(onChange);
    await userEvent.setup().click(screen.getByRole("option", { name: "deepseek-flash" }));
    expect(onChange).toHaveBeenCalledWith("deepseek-flash");
  });

  it("offers the forced tiers where the provider serves them", async () => {
    apiFetchMock.mockResolvedValue(
      recommendation({ servesTierModels: true, configuredModel: "us.anthropic.claude-sonnet-5" }),
    );
    const labels = await openOptions();
    expect(labels).toEqual(["Auto", "Force Haiku", "Force Sonnet", "Force Fable", "Force Opus"]);
  });

  it("keeps the forced tiers for an older server that does not say", async () => {
    apiFetchMock.mockResolvedValue(recommendation({}));
    const labels = await openOptions();
    expect(labels).toContain("Force Opus");
  });
});
