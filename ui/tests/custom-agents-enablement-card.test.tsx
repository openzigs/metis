/**
 * Epic #260 / Issue #85 — per-project custom-agent enablement toggle.
 *
 * On the project settings page, list enabled custom agents and toggle each
 * one on/off. AC: live-updates when toggled (refetch after the PUT).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      deleteAgent: vi.fn(),
    },
  };
});
vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return { ...actual, projectsApi: { ...actual.projectsApi, get: vi.fn() } };
});

import { sdkApi } from "@/lib/sdk-alignment-api";
import { projectsApi } from "@/lib/projects-api";

const listAgents = sdkApi.listAgents as unknown as ReturnType<typeof vi.fn>;
const listEnabledAgents = sdkApi.listEnabledAgents as unknown as ReturnType<typeof vi.fn>;
const setAgentEnablement = sdkApi.setAgentEnablement as unknown as ReturnType<typeof vi.fn>;
const deleteAgent = sdkApi.deleteAgent as unknown as ReturnType<typeof vi.fn>;
const getProject = projectsApi.get as unknown as ReturnType<typeof vi.fn>;

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
  deleteAgent.mockReset();
  getProject.mockReset();
  getProject.mockResolvedValue({ id: "proj-1", workspaceId: "ws-1" });
  window.localStorage.clear();
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

  // #405 — Library → Agents is the one home for custom agents, so it must
  // offer the two actions /settings/agents used to: start creating, and delete.
  describe("#405 — New agent and Delete", () => {
    it("links New agent to the authoring wizard of the project's workspace", async () => {
      listAgents.mockResolvedValue([]);
      listEnabledAgents.mockResolvedValue([]);
      window.localStorage.setItem("metis.activeWorkspaceId", "ws-other");
      renderCard();
      const link = await screen.findByRole("link", { name: "New agent" });
      await waitFor(() => expect(link).toHaveAttribute("href", "/workspaces/ws-1/agents/new"));
      expect(getProject).toHaveBeenCalledWith("proj-1");
    });

    // PR #408 review — the header's workspace wizard cannot list a project that
    // has no workspace, so no link beats a link that cannot reach it.
    it("offers no New agent link for a project with no workspace, whatever the header says", async () => {
      listAgents.mockResolvedValue([]);
      listEnabledAgents.mockResolvedValue([]);
      getProject.mockResolvedValue({ id: "proj-1", workspaceId: null });
      window.localStorage.setItem("metis.activeWorkspaceId", "ws-active");
      renderCard();
      await screen.findByTestId("custom-agents-enablement-empty");
      await waitFor(() => expect(getProject).toHaveBeenCalled());
      expect(screen.queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
    });

    it("offers no New agent link when no workspace is known", async () => {
      listAgents.mockResolvedValue([]);
      listEnabledAgents.mockResolvedValue([]);
      getProject.mockResolvedValue({ id: "proj-1", workspaceId: null });
      renderCard();
      await screen.findByTestId("custom-agents-enablement-empty");
      await waitFor(() => expect(getProject).toHaveBeenCalled());
      expect(screen.queryByRole("link", { name: "New agent" })).not.toBeInTheDocument();
    });

    it("shows Delete only on the project's own custom agents, never on built-ins", async () => {
      const shared = { ...agent("a3", "Shared"), projectId: "proj-other" };
      listAgents.mockResolvedValue([agent("a1", "Mine"), agent("b1", "Builtin", true), shared]);
      listEnabledAgents.mockResolvedValue([]);
      renderCard();
      await screen.findByTestId("ca-enablement-row-a1");
      expect(screen.getByTestId("ca-delete-a1")).toBeInTheDocument();
      expect(screen.queryByTestId("ca-delete-b1")).not.toBeInTheDocument();
      expect(screen.queryByTestId("ca-delete-a3")).not.toBeInTheDocument();
    });

    it("deletes only after confirming, then refreshes the list", async () => {
      listAgents.mockResolvedValueOnce([agent("a1", "Mine")]).mockResolvedValue([]);
      listEnabledAgents.mockResolvedValue([]);
      deleteAgent.mockResolvedValue(undefined);
      renderCard();

      fireEvent.click(await screen.findByTestId("ca-delete-a1"));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Delete agent Mine?");
      expect(deleteAgent).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(deleteAgent).toHaveBeenCalledWith("a1"));
      await waitFor(() =>
        expect(screen.queryByTestId("ca-enablement-row-a1")).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId("custom-agents-enablement-empty")).toBeInTheDocument();
      expect(listAgents).toHaveBeenCalledTimes(2);
    });

    it("does not delete when the confirm is cancelled", async () => {
      listAgents.mockResolvedValue([agent("a1", "Mine")]);
      listEnabledAgents.mockResolvedValue([]);
      renderCard();

      fireEvent.click(await screen.findByTestId("ca-delete-a1"));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(deleteAgent).not.toHaveBeenCalled();
      expect(screen.getByTestId("ca-enablement-row-a1")).toBeInTheDocument();
    });

    it("surfaces the server's refusal and keeps the row", async () => {
      listAgents.mockResolvedValue([agent("a1", "Mine")]);
      listEnabledAgents.mockResolvedValue([]);
      deleteAgent.mockRejectedValue(new Error("Workspace admin required"));
      renderCard();

      fireEvent.click(await screen.findByTestId("ca-delete-a1"));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      const alert = await screen.findByTestId("ca-delete-error");
      expect(alert).toHaveTextContent("Workspace admin required");
      expect(screen.getByTestId("ca-enablement-row-a1")).toBeInTheDocument();
    });

    // PR #408 review — the Library scope picker keeps this card mounted.
    it("clears a delete refusal when the scoped project changes", async () => {
      listAgents.mockResolvedValue([agent("a1", "Mine")]);
      listEnabledAgents.mockResolvedValue([]);
      deleteAgent.mockRejectedValue(new Error("Workspace admin required"));
      const Wrapper = makeWrapper({});
      const { rerender } = render(
        <Wrapper>
          <CustomAgentsEnablementCard projectId="proj-1" />
        </Wrapper>,
      );
      fireEvent.click(await screen.findByTestId("ca-delete-a1"));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
      await screen.findByTestId("ca-delete-error");

      rerender(
        <Wrapper>
          <CustomAgentsEnablementCard projectId="proj-2" />
        </Wrapper>,
      );
      await waitFor(() => expect(screen.queryByTestId("ca-delete-error")).not.toBeInTheDocument());
    });
  });
});
