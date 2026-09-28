/**
 * #145 — the custom agent's edit form (the first consumer of
 * `PATCH /api/custom-agents/:id`), opened from the project's Custom agents
 * card. Every field of the one agent definition is editable; only what changed
 * is sent; a tool the server does not list stays visible and is never sent
 * unless the user touches the tool list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CustomAgentDto } from "@metis/shared";
import { CustomAgentsEnablementCard } from "@/components/projects/custom-agents-enablement-card";
import { buildAgentPatch, draftFromAgent } from "@/components/custom-agents/CustomAgentEditForm";
import { ApiError } from "@/lib/api-client";
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
      updateAgent: vi.fn(),
      listTools: vi.fn(async () => ({
        tools: [
          { name: "count_rows", description: "c", risk: "low" },
          { name: "search-knowledge", description: "s", risk: "low" },
        ],
      })),
    },
  };
});
vi.mock("@/lib/library-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/library-api")>("@/lib/library-api");
  return {
    ...actual,
    skillsApi: {
      ...actual.skillsApi,
      list: vi.fn(async () => ({
        items: [
          { id: "s1", key: "style-guide", name: "Style guide", enabled: true, archived: false },
          { id: "s2", key: "glossary", name: "Glossary", enabled: true, archived: false },
        ],
      })),
    },
  };
});
vi.mock("@/lib/model-catalog-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/model-catalog-api")>("@/lib/model-catalog-api");
  return {
    ...actual,
    modelCatalogApi: {
      list: vi.fn(async () => ({
        models: [{ id: "catalog-model", displayName: "Catalog Model", price: null }],
      })),
    },
  };
});

import { sdkApi } from "@/lib/sdk-alignment-api";

const listAgents = sdkApi.listAgents as unknown as ReturnType<typeof vi.fn>;
const listEnabledAgents = sdkApi.listEnabledAgents as unknown as ReturnType<typeof vi.fn>;
const updateAgent = sdkApi.updateAgent as unknown as ReturnType<typeof vi.fn>;

function agent(over: Partial<CustomAgentDto> = {}): CustomAgentDto {
  return {
    id: "a-own",
    projectId: "proj-1",
    name: "Risk Reviewer",
    description: "Finds risks",
    systemPrompt: "You review risk.",
    // `knowledge_search` is an older agent's name no tool carries.
    tools: ["count_rows", "knowledge_search"],
    model: "saved-model",
    reasoningEffort: "medium",
    skillKeys: ["style-guide"],
    approvalPolicy: { high: "deny" },
    version: "1.0.3",
    isBuiltIn: false,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

beforeEach(() => {
  listAgents.mockReset();
  listEnabledAgents.mockReset();
  updateAgent.mockReset();
  listEnabledAgents.mockResolvedValue([]);
});

function renderCard() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <CustomAgentsEnablementCard projectId="proj-1" />
    </Wrapper>,
  );
}

async function openEditor() {
  fireEvent.click(await screen.findByTestId("ca-edit-open-a-own"));
  const form = await screen.findByTestId("ca-edit-form");
  // Wait for the tool list to load from the server.
  await within(form).findByTestId("ca-edit-tool-search-knowledge");
  return form;
}

describe("#145 — editing a custom agent from the project's Custom agents card", () => {
  it("offers Edit only on agents this project owns (not built-ins, not agents shared from elsewhere)", async () => {
    listAgents.mockResolvedValue([
      agent(),
      agent({ id: "a-builtin", name: "BA", isBuiltIn: true, projectId: null }),
      agent({ id: "a-shared", name: "Shared", projectId: null }),
    ]);
    renderCard();
    expect(await screen.findByTestId("ca-edit-open-a-own")).toBeInTheDocument();
    expect(screen.queryByTestId("ca-edit-open-a-builtin")).toBeNull();
    expect(screen.queryByTestId("ca-edit-open-a-shared")).toBeNull();
  });

  it("prefills every field of the definition, including a tool and model the server does not list", async () => {
    listAgents.mockResolvedValue([agent()]);
    renderCard();
    const form = await openEditor();
    expect(within(form).getByTestId("ca-edit-version")).toHaveTextContent("Version 1.0.3");
    expect(within(form).getByTestId("ca-edit-description")).toHaveValue("Finds risks");
    expect(within(form).getByTestId("ca-edit-prompt")).toHaveValue("You review risk.");
    expect(within(form).getByTestId("ca-edit-tool-count_rows")).toBeChecked();
    expect(within(form).getByTestId("ca-edit-tool-search-knowledge")).not.toBeChecked();
    expect(within(form).getByTestId("ca-edit-tool-knowledge_search")).toBeChecked();
    expect(within(form).getByText("(not in this server's tool list)")).toBeInTheDocument();
    expect(await within(form).findByTestId("ca-edit-skill-style-guide")).toBeChecked();
    expect(within(form).getByTestId("ca-edit-model")).toHaveValue("saved-model");
    expect(within(form).getByText("saved-model (not in the model catalog)")).toBeInTheDocument();
    expect(within(form).getByTestId("ca-edit-reasoning")).toHaveValue("medium");
    expect(within(form).getByTestId("ca-edit-approval-high")).toHaveValue("deny");
    expect(within(form).getByTestId("ca-edit-approval-low")).toHaveValue("");
    // Nothing changed yet — nothing to save.
    expect(within(form).getByTestId("ca-edit-save")).toBeDisabled();
  });

  it("sends only the changed fields, and a persona edit leaves the tool list alone", async () => {
    listAgents.mockResolvedValue([agent()]);
    updateAgent.mockResolvedValue(agent({ systemPrompt: "New persona.", version: "1.0.4" }));
    renderCard();
    const form = await openEditor();
    fireEvent.change(within(form).getByTestId("ca-edit-prompt"), {
      target: { value: "New persona." },
    });
    fireEvent.change(within(form).getByTestId("ca-edit-approval-low"), {
      target: { value: "prompt-once" },
    });
    fireEvent.click(within(form).getByTestId("ca-edit-save"));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
    expect(updateAgent).toHaveBeenCalledWith("a-own", {
      systemPrompt: "New persona.",
      approvalPolicy: { low: "prompt-once", high: "deny" },
    });
    // Saved: the dialog closes and the card refetches.
    await waitFor(() => expect(screen.queryByTestId("ca-edit-form")).toBeNull());
    expect(listAgents.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("edits tools, skills, model and effort, and clears the override with null", async () => {
    listAgents.mockResolvedValue([agent()]);
    updateAgent.mockResolvedValue(agent());
    renderCard();
    const form = await openEditor();
    fireEvent.click(within(form).getByTestId("ca-edit-tool-knowledge_search"));
    fireEvent.click(within(form).getByTestId("ca-edit-tool-search-knowledge"));
    fireEvent.click(await within(form).findByTestId("ca-edit-skill-glossary"));
    fireEvent.change(within(form).getByTestId("ca-edit-model"), {
      target: { value: "" },
    });
    fireEvent.change(within(form).getByTestId("ca-edit-reasoning"), {
      target: { value: "high" },
    });
    fireEvent.change(within(form).getByTestId("ca-edit-approval-high"), {
      target: { value: "" },
    });
    fireEvent.click(within(form).getByTestId("ca-edit-save"));
    await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
    expect(updateAgent).toHaveBeenCalledWith("a-own", {
      tools: ["count_rows", "search-knowledge"],
      skillKeys: ["style-guide", "glossary"],
      model: null,
      reasoningEffort: "high",
      approvalPolicy: null,
    });
  });

  it("shows the server's reason when the save is refused, and keeps the dialog open", async () => {
    listAgents.mockResolvedValue([agent()]);
    updateAgent.mockRejectedValue(
      new ApiError(400, "Unknown tools: knowledge_search", "CUSTOM_AGENT_ERROR"),
    );
    renderCard();
    const form = await openEditor();
    fireEvent.click(within(form).getByTestId("ca-edit-tool-count_rows"));
    fireEvent.click(within(form).getByTestId("ca-edit-save"));
    expect(await screen.findByTestId("ca-edit-error")).toHaveTextContent(
      "Unknown tools: knowledge_search",
    );
    expect(screen.getByTestId("ca-edit-form")).toBeInTheDocument();
  });

  it("Cancel closes the dialog without saving", async () => {
    listAgents.mockResolvedValue([agent()]);
    renderCard();
    const form = await openEditor();
    fireEvent.change(within(form).getByTestId("ca-edit-prompt"), { target: { value: "Draft" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("ca-edit-form")).toBeNull());
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("will not save an empty persona", async () => {
    listAgents.mockResolvedValue([agent()]);
    renderCard();
    const form = await openEditor();
    fireEvent.change(within(form).getByTestId("ca-edit-prompt"), { target: { value: "   " } });
    expect(within(form).getByTestId("ca-edit-save")).toBeDisabled();
  });
});

describe("#145 — buildAgentPatch", () => {
  it("is empty when nothing changed, and a stored 'auto' override reads as the session default", () => {
    const a = agent({ approvalPolicy: { low: "auto", high: "deny" } });
    const d = draftFromAgent(a);
    expect(d.approval).toEqual({ low: "", medium: "", high: "deny" });
    expect(buildAgentPatch(d, d)).toEqual({});
  });

  it("ignores tool and skill order, but not membership", () => {
    const d = draftFromAgent(agent());
    expect(buildAgentPatch(d, { ...d, tools: [...d.tools].reverse() })).toEqual({});
    expect(buildAgentPatch(d, { ...d, tools: ["count_rows"] })).toEqual({ tools: ["count_rows"] });
  });

  it("trims text and treats a blank model or effort as 'clear'", () => {
    const d = draftFromAgent(agent({ model: null, reasoningEffort: null }));
    expect(buildAgentPatch(d, { ...d, description: "  Finds risks  " })).toEqual({});
    expect(buildAgentPatch(d, { ...d, description: " new " })).toEqual({ description: "new" });
    expect(buildAgentPatch(d, { ...d, model: "m" })).toEqual({ model: "m" });
    const withModel = draftFromAgent(agent());
    expect(buildAgentPatch(withModel, { ...withModel, model: "", reasoningEffort: "" })).toEqual({
      model: null,
      reasoningEffort: null,
    });
  });
});
