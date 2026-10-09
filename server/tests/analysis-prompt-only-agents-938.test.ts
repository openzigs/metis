/**
 * Issue #938 — the start-analysis form lists the enabled custom and library
 * agents the run will invoke, and says they run prompt-only (none of their
 * tools run). The list is the SAME one the run reads, so the form can neither
 * name an agent the run skips nor miss one it runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinitionDto, CustomAgentDto } from "@metis/shared";

const enabledCustom: CustomAgentDto[] = [];
const enabledLibrary: AgentDefinitionDto[] = [];
vi.mock("../src/lib/custom-agents/index.js", () => ({
  listEnabledAgentsForProject: vi.fn(async () => enabledCustom),
}));
vi.mock("../src/lib/agent-runtime/definition.js", async (original) => ({
  ...(await original<typeof import("../src/lib/agent-runtime/definition.js")>()),
  listProjectLibraryAgents: vi.fn(async () => enabledLibrary),
}));

const { listPromptOnlyAnalysisAgents, listAnalysisPhaseAgents } =
  await import("../src/lib/analysis/custom-agent-phase.js");
const { listEnabledAgentsForProject } = await import("../src/lib/custom-agents/index.js");
const { listProjectLibraryAgents } = await import("../src/lib/agent-runtime/definition.js");

function custom(over: Partial<CustomAgentDto> = {}): CustomAgentDto {
  return {
    id: "ca_1",
    projectId: null,
    name: "Go SQL reviewer",
    description: "",
    systemPrompt: "Review the SQL.",
    tools: ["read_file_slice", "search_code"],
    model: null,
    reasoningEffort: null,
    isBuiltIn: false,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function library(over: Partial<AgentDefinitionDto> = {}): AgentDefinitionDto {
  return {
    ref: "library:lib_1",
    kind: "library",
    id: "lib_1",
    key: "threat-modeler",
    name: "Threat modeler",
    description: "",
    persona: "Model threats.",
    skillKeys: [],
    toolAllowlist: null,
    model: null,
    reasoningEffort: null,
    approvalPolicy: null,
    version: "1",
    projectId: null,
    ...over,
  };
}

beforeEach(() => {
  enabledCustom.length = 0;
  enabledLibrary.length = 0;
  vi.mocked(listEnabledAgentsForProject).mockClear();
  vi.mocked(listProjectLibraryAgents).mockClear();
});

describe("listPromptOnlyAnalysisAgents (#938)", () => {
  it("is empty when the project enables no agents", async () => {
    expect(await listPromptOnlyAnalysisAgents("proj-1")).toEqual([]);
  });

  it("lists library agents first, then custom agents, with the tools that will not run", async () => {
    enabledLibrary.push(library({ toolAllowlist: ["web_search"] }));
    enabledCustom.push(custom());
    expect(await listPromptOnlyAnalysisAgents("proj-1")).toEqual([
      {
        ref: "library:lib_1",
        kind: "library",
        name: "Threat modeler",
        toolsNotRun: ["web_search"],
      },
      {
        ref: "custom:ca_1",
        kind: "custom",
        name: "Go SQL reviewer",
        toolsNotRun: ["read_file_slice", "search_code"],
      },
    ]);
  });

  it("reports no tools for an agent that declares no allowlist", async () => {
    enabledLibrary.push(library({ toolAllowlist: null }));
    const [only] = await listPromptOnlyAnalysisAgents("proj-1");
    expect(only?.toolsNotRun).toEqual([]);
  });

  it("reads the project's own enablement — the same list the run invokes", async () => {
    enabledCustom.push(custom());
    await listPromptOnlyAnalysisAgents("proj-7");
    expect(listEnabledAgentsForProject).toHaveBeenCalledWith("proj-7");
    expect(listProjectLibraryAgents).toHaveBeenCalledWith("proj-7");
    const run = await listAnalysisPhaseAgents("proj-7");
    const form = await listPromptOnlyAnalysisAgents("proj-7");
    expect(form.map((a) => a.ref)).toEqual(run.map((a) => a.ref));
  });
});
