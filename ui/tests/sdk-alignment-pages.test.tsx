/**
 * Epic #165 — quick smoke tests for the SDK-alignment UI pages.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import AgentsSettingsPage from "@/app/(authed)/settings/agents/page";
import HooksSettingsPage from "@/app/(authed)/settings/hooks/page";
import SessionsPage from "@/app/(authed)/sessions/page";
import { sdkApi } from "@/lib/sdk-alignment-api";

vi.mock("@/lib/sdk-alignment-api", () => ({
  sdkApi: {
    listAgents: vi.fn(),
    createAgent: vi.fn(),
    deleteAgent: vi.fn(),
    listHooks: vi.fn(),
    createHook: vi.fn(),
    updateHook: vi.fn(),
    deleteHook: vi.fn(),
    listResumable: vi.fn(),
    resumeSession: vi.fn(),
  },
}));

const api = vi.mocked(sdkApi);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Custom Agents settings page (#112)", () => {
  it("renders built-in and custom agents and allows deletion of customs only", async () => {
    api.listAgents.mockResolvedValue([
      {
        id: "b1",
        projectId: null,
        name: "BA",
        description: "Built-in",
        systemPrompt: "x",
        tools: [],
        model: null,
        reasoningEffort: null,
        isBuiltIn: true,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "c1",
        projectId: "p1",
        name: "Custom",
        description: "User",
        systemPrompt: "x",
        tools: [],
        model: null,
        reasoningEffort: null,
        isBuiltIn: false,
        createdAt: "",
        updatedAt: "",
      },
    ]);
    render(<AgentsSettingsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("ca-row-b1")).toBeInTheDocument());
    expect(screen.queryByTestId("ca-delete-b1")).not.toBeInTheDocument();
    expect(screen.getByTestId("ca-delete-c1")).toBeInTheDocument();
  });

  it("disables save until required fields are filled", async () => {
    api.listAgents.mockResolvedValue([]);
    render(<AgentsSettingsPage />, { wrapper: makeWrapper() });
    const save = await screen.findByTestId("ca-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("ca-project-id"), { target: { value: "p1" } });
    fireEvent.change(screen.getByTestId("ca-name"), { target: { value: "Foo" } });
    fireEvent.change(screen.getByTestId("ca-system-prompt"), { target: { value: "do" } });
    expect(save).not.toBeDisabled();
  });
});

describe("Hooks settings page (#114)", () => {
  it("requires a project id before showing the form", () => {
    render(<HooksSettingsPage />, { wrapper: makeWrapper() });
    expect(screen.queryByTestId("hk-save")).not.toBeInTheDocument();
  });

  it("disables save until url is https", async () => {
    api.listHooks.mockResolvedValue([]);
    render(<HooksSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.change(screen.getByTestId("hk-project-id"), { target: { value: "p1" } });
    const save = await screen.findByTestId("hk-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("hk-url"), { target: { value: "https://example.com" } });
    expect(save).not.toBeDisabled();
  });
});

describe("Sessions page (#122)", () => {
  it("lists resumable sessions and dispatches resume on click", async () => {
    api.listResumable.mockResolvedValue([
      {
        id: "s1",
        projectId: "p1",
        title: "T",
        model: "claude",
        currentModel: null,
        currentReasoningEffort: null,
        planModeActive: false,
        status: "active",
        snapshotUpdatedAt: null,
        updatedAt: "",
      },
    ]);
    api.resumeSession.mockResolvedValue({});
    render(<SessionsPage />, { wrapper: makeWrapper() });
    const resume = await screen.findByTestId("sess-resume-s1");
    fireEvent.click(resume);
    await waitFor(() => expect(api.resumeSession).toHaveBeenCalledWith("s1"));
  });

  it("renders an empty state", async () => {
    api.listResumable.mockResolvedValue([]);
    render(<SessionsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByText(/No resumable sessions/i)).toBeInTheDocument());
  });
});
