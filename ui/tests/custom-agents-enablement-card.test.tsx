/**
 * Epic #260 / Issue #85 — per-project custom-agent enablement toggle.
 *
 * On the project settings page, list enabled custom agents and toggle each
 * one on/off. AC: live-updates when toggled (refetch after the PUT).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomAgentsEnablementCard } from "@/components/projects/custom-agents-enablement-card";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/sdk-alignment-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sdk-alignment-api")>("@/lib/sdk-alignment-api");
  return {
    ...actual,
    sdkApi: {
      ...actual.sdkApi,
      listAgents: vi.fn(),
      listEnabledAgents: vi.fn(),
      setAgentEnablement: vi.fn(),
    },
  };
});

import { sdkApi } from "@/lib/sdk-alignment-api";

const listAgents = sdkApi.listAgents as unknown as ReturnType<typeof vi.fn>;
const listEnabledAgents = sdkApi.listEnabledAgents as unknown as ReturnType<typeof vi.fn>;
const setAgentEnablement = sdkApi.setAgentEnablement as unknown as ReturnType<typeof vi.fn>;

function agent(id: string, name: string, isBuiltIn = false) {
  return {
    id,
    projectId: isBuiltIn ? null : "proj-1",
    name,
    description: "",
    systemPrompt: "x",
    tools: [],
    isBuiltIn,
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  listAgents.mockReset();
  listEnabledAgents.mockReset();
  setAgentEnablement.mockReset();
});

function renderCard(projectId = "proj-1") {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <CustomAgentsEnablementCard projectId={projectId} />
    </Wrapper>,
  );
}

describe("<CustomAgentsEnablementCard /> (#85)", () => {
  it("renders the card root", async () => {
    listAgents.mockResolvedValue([]);
    listEnabledAgents.mockResolvedValue([]);
    renderCard();
    expect(screen.getByTestId("custom-agents-enablement-card")).toBeInTheDocument();
  });

  it("shows an empty state when there are no candidate agents", async () => {
    listAgents.mockResolvedValue([]);
    listEnabledAgents.mockResolvedValue([]);
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("custom-agents-enablement-empty")).toBeInTheDocument(),
    );
  });

  it("lists candidate agents with their enabled state reflected", async () => {
    listAgents.mockResolvedValue([agent("a1", "Risk Analyst"), agent("a2", "Compliance")]);
    listEnabledAgents.mockResolvedValue([agent("a1", "Risk Analyst")]);
    renderCard();

    await waitFor(() => expect(screen.getByTestId("ca-enablement-row-a1")).toBeInTheDocument());
    expect(screen.getByTestId("ca-enablement-row-a2")).toBeInTheDocument();
    // a1 is enabled -> its toggle offers "Disable"; a2 offers "Enable".
    expect(screen.getByTestId("ca-enablement-toggle-a1")).toHaveTextContent(/disable/i);
    expect(screen.getByTestId("ca-enablement-toggle-a2")).toHaveTextContent(/enable/i);
  });

  it("enables a disabled agent and live-updates via refetch", async () => {
    listAgents.mockResolvedValue([agent("a2", "Compliance")]);
    // First load: a2 not enabled. After toggle, refetch returns it enabled.
    listEnabledAgents.mockResolvedValueOnce([]).mockResolvedValue([agent("a2", "Compliance")]);
    setAgentEnablement.mockResolvedValue({
      id: "e1",
      customAgentId: "a2",
      projectId: "proj-1",
      enabled: true,
      enabledById: "u-1",
      createdAt: "",
      updatedAt: "",
    });

    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("ca-enablement-toggle-a2")).toHaveTextContent(/enable/i),
    );

    fireEvent.click(screen.getByTestId("ca-enablement-toggle-a2"));

    await waitFor(() =>
      expect(setAgentEnablement).toHaveBeenCalledWith("a2", {
        projectId: "proj-1",
        enabled: true,
      }),
    );
    // Refetch flips the label to "Disable".
    await waitFor(() =>
      expect(screen.getByTestId("ca-enablement-toggle-a2")).toHaveTextContent(/disable/i),
    );
  });

  it("disables an enabled agent", async () => {
    listAgents.mockResolvedValue([agent("a1", "Risk Analyst")]);
    listEnabledAgents.mockResolvedValueOnce([agent("a1", "Risk Analyst")]).mockResolvedValue([]);
    setAgentEnablement.mockResolvedValue({
      id: "e1",
      customAgentId: "a1",
      projectId: "proj-1",
      enabled: false,
      enabledById: "u-1",
      createdAt: "",
      updatedAt: "",
    });

    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("ca-enablement-toggle-a1")).toHaveTextContent(/disable/i),
    );
    fireEvent.click(screen.getByTestId("ca-enablement-toggle-a1"));

    await waitFor(() =>
      expect(setAgentEnablement).toHaveBeenCalledWith("a1", {
        projectId: "proj-1",
        enabled: false,
      }),
    );
  });

  it("renders an error state when loading fails", async () => {
    listAgents.mockRejectedValue(new Error("nope"));
    listEnabledAgents.mockRejectedValue(new Error("nope"));
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("custom-agents-enablement-error")).toBeInTheDocument(),
    );
  });
});
