/**
 * Epic #260 / Issue #84 — Custom agent authoring wizard.
 *
 * Multi-step wizard: name → prompt + template gallery → tool picker →
 * model picker → playground. AC: filling name/prompt/tools/model and running
 * the playground shows a sample completion (within 5s in production; here the
 * invoke call is mocked and resolves immediately).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentAuthoringWizard } from "@/components/custom-agents/AgentAuthoringWizard";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/sdk-alignment-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sdk-alignment-api")>("@/lib/sdk-alignment-api");
  return {
    ...actual,
    sdkApi: {
      ...actual.sdkApi,
      invokeAgent: vi.fn(),
      createAgent: vi.fn(),
    },
  };
});

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      list: vi.fn(),
    },
  };
});

import { sdkApi } from "@/lib/sdk-alignment-api";
import { projectsApi } from "@/lib/projects-api";

const invokeAgent = sdkApi.invokeAgent as unknown as ReturnType<typeof vi.fn>;
const createAgent = sdkApi.createAgent as unknown as ReturnType<typeof vi.fn>;
const listProjects = projectsApi.list as unknown as ReturnType<typeof vi.fn>;

const PROJECTS = [
  {
    id: "proj-1",
    name: "Alpha",
    slug: "alpha",
    status: "active",
    createdById: "u-1",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "proj-2",
    name: "Beta",
    slug: "beta",
    status: "active",
    createdById: "u-1",
    createdAt: "",
    updatedAt: "",
  },
];

beforeEach(() => {
  invokeAgent.mockReset();
  createAgent.mockReset();
  listProjects.mockReset();
  listProjects.mockResolvedValue({ items: PROJECTS, total: 2, limit: 50, offset: 0 });
});

function renderWizard(workspaceId = "ws-1") {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <AgentAuthoringWizard workspaceId={workspaceId} />
    </Wrapper>,
  );
}

/** Advance microtasks for resolved query/mutation promises. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("<AgentAuthoringWizard /> (#84)", () => {
  it("renders the wizard root starting on the name step", () => {
    renderWizard();
    expect(screen.getByTestId("agent-wizard-root")).toBeInTheDocument();
    expect(screen.getByTestId("wizard-step-name")).toBeInTheDocument();
  });

  it("blocks advancing from the name step until name + project are set", async () => {
    renderWizard();
    await flush();
    const next = screen.getByTestId("wizard-next");
    expect(next).toBeDisabled();

    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    // Still blocked without a project selection.
    expect(screen.getByTestId("wizard-next")).toBeDisabled();

    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    expect(screen.getByTestId("wizard-next")).not.toBeDisabled();
  });

  it("walks through every step to the playground", async () => {
    renderWizard();
    await flush();

    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // -> prompt

    expect(screen.getByTestId("wizard-step-prompt")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), {
      target: { value: "You are a careful requirements analyst." },
    });
    fireEvent.click(screen.getByTestId("wizard-next")); // -> tools

    expect(screen.getByTestId("wizard-step-tools")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wizard-next")); // -> model

    expect(screen.getByTestId("wizard-step-model")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wizard-next")); // -> playground

    expect(screen.getByTestId("wizard-step-playground")).toBeInTheDocument();
  });

  it("applies a template from the gallery into the prompt field", async () => {
    renderWizard();
    await flush();
    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next"));

    fireEvent.click(screen.getByTestId("wizard-template-requirements-analyst"));
    const prompt = screen.getByTestId("wizard-prompt-input") as HTMLTextAreaElement;
    expect(prompt.value.length).toBeGreaterThan(0);
  });

  it("toggles tools in the picker", async () => {
    renderWizard();
    await flush();
    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // prompt
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), { target: { value: "Prompt." } });
    fireEvent.click(screen.getByTestId("wizard-next")); // tools

    const tools = screen.getAllByTestId(/^wizard-tool-/);
    const firstTool = tools[0] as HTMLInputElement;
    expect(firstTool.checked).toBe(false);
    fireEvent.click(firstTool);
    expect((tools[0] as HTMLInputElement).checked).toBe(true);
  });

  it("runs the playground and shows a sample completion", async () => {
    invokeAgent.mockResolvedValue({
      content: "Here is a sample analysis.",
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      model: "claude-sonnet",
      provider: "bedrock",
    });
    renderWizard();
    await flush();

    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // prompt
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), {
      target: { value: "You are an analyst." },
    });
    fireEvent.click(screen.getByTestId("wizard-next")); // tools
    fireEvent.click(screen.getByTestId("wizard-next")); // model
    fireEvent.click(screen.getByTestId("wizard-next")); // playground

    // Save creates the agent so the playground has an id to invoke.
    createAgent.mockResolvedValue({
      id: "agent-1",
      projectId: "proj-1",
      name: "My Analyst",
      description: "",
      systemPrompt: "You are an analyst.",
      tools: [],
      isBuiltIn: false,
      createdAt: "",
      updatedAt: "",
    });

    fireEvent.change(screen.getByTestId("wizard-playground-input"), {
      target: { value: "Summarize the spec." },
    });
    fireEvent.click(screen.getByTestId("wizard-playground-run"));

    await waitFor(() => {
      expect(screen.getByTestId("wizard-playground-output")).toHaveTextContent(
        "Here is a sample analysis.",
      );
    });
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", name: "My Analyst" }),
    );
    expect(invokeAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({ projectId: "proj-1", input: "Summarize the spec." }),
    );
  });

  it("surfaces an error if the playground invocation fails", async () => {
    createAgent.mockResolvedValue({
      id: "agent-2",
      projectId: "proj-1",
      name: "My Analyst",
      description: "",
      systemPrompt: "Prompt.",
      tools: [],
      isBuiltIn: false,
      createdAt: "",
      updatedAt: "",
    });
    invokeAgent.mockRejectedValue(new Error("boom"));
    renderWizard();
    await flush();

    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), { target: { value: "Prompt." } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-next"));

    fireEvent.change(screen.getByTestId("wizard-playground-input"), {
      target: { value: "Go." },
    });
    fireEvent.click(screen.getByTestId("wizard-playground-run"));

    await waitFor(() => {
      expect(screen.getByTestId("wizard-playground-error")).toBeInTheDocument();
    });
  });

  it("selects model and reasoning effort and passes them on create", async () => {
    createAgent.mockResolvedValue({
      id: "agent-3",
      projectId: "proj-1",
      name: "My Analyst",
      description: "",
      systemPrompt: "Prompt.",
      tools: ["web_search"],
      isBuiltIn: false,
      createdAt: "",
      updatedAt: "",
    });
    invokeAgent.mockResolvedValue({
      content: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "m",
      provider: "p",
    });
    renderWizard();
    await flush();

    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // prompt
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), { target: { value: "Prompt." } });
    fireEvent.click(screen.getByTestId("wizard-next")); // tools
    fireEvent.click(screen.getByTestId("wizard-tool-web_search"));
    fireEvent.click(screen.getByTestId("wizard-next")); // model
    fireEvent.change(screen.getByTestId("wizard-model-select"), {
      target: { value: "us.anthropic.claude-sonnet-5" },
    });
    fireEvent.change(screen.getByTestId("wizard-reasoning-select"), { target: { value: "high" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // playground

    fireEvent.change(screen.getByTestId("wizard-playground-input"), { target: { value: "Go." } });
    fireEvent.click(screen.getByTestId("wizard-playground-run"));

    await waitFor(() =>
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "us.anthropic.claude-sonnet-5",
          reasoningEffort: "high",
          tools: ["web_search"],
        }),
      ),
    );
  });

  it("shows an error when the project list fails to load", async () => {
    listProjects.mockRejectedValue(new Error("nope"));
    renderWizard();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/failed to load/i));
  });

  it("re-uses the created draft agent id across repeated playground runs", async () => {
    createAgent.mockResolvedValue({
      id: "agent-4",
      projectId: "proj-1",
      name: "My Analyst",
      description: "",
      systemPrompt: "Prompt.",
      tools: [],
      isBuiltIn: false,
      createdAt: "",
      updatedAt: "",
    });
    invokeAgent.mockResolvedValue({
      content: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "m",
      provider: "p",
    });
    renderWizard();
    await flush();
    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), { target: { value: "Prompt." } });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-next"));

    fireEvent.change(screen.getByTestId("wizard-playground-input"), { target: { value: "One." } });
    fireEvent.click(screen.getByTestId("wizard-playground-run"));
    await waitFor(() => expect(invokeAgent).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByTestId("wizard-playground-input"), { target: { value: "Two." } });
    fireEvent.click(screen.getByTestId("wizard-playground-run"));
    await waitFor(() => expect(invokeAgent).toHaveBeenCalledTimes(2));
    // createAgent only called once — draft id re-used.
    expect(createAgent).toHaveBeenCalledTimes(1);
  });

  it("caps the playground input at 20k chars and shows a char counter", async () => {
    renderWizard();
    await flush();
    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // prompt
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), { target: { value: "Prompt." } });
    fireEvent.click(screen.getByTestId("wizard-next")); // tools
    fireEvent.click(screen.getByTestId("wizard-next")); // model
    fireEvent.click(screen.getByTestId("wizard-next")); // playground

    const input = screen.getByTestId("wizard-playground-input") as HTMLTextAreaElement;
    expect(input.maxLength).toBe(20000);

    // Over-cap input is sliced to the 20k limit, not round-tripped to a 400.
    fireEvent.change(input, { target: { value: "a".repeat(20_050) } });
    expect(input.value.length).toBe(20_000);
    expect(screen.getByTestId("wizard-playground-charcount")).toHaveTextContent("20,000 / 20,000");
  });

  it("lets the user go back to a previous step", async () => {
    renderWizard();
    await flush();
    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // prompt
    expect(screen.getByTestId("wizard-step-prompt")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("wizard-back"));
    expect(screen.getByTestId("wizard-step-name")).toBeInTheDocument();
  });
});
