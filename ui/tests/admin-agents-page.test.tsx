import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import AdminAgentsPage, { rebuildAgentSource } from "@/app/(authed)/admin/agents/page";
import {
  agentsApi,
  skillsApi,
  type AgentDetail,
  type AgentSummary,
  type SkillSummary,
} from "@/lib/library-api";
import { ApiError } from "@/lib/api-client";

vi.mock("@/lib/library-api", () => ({
  agentsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    archive: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    versions: vi.fn(),
  },
  skillsApi: {
    list: vi.fn(),
  },
}));

const listMock = vi.mocked(agentsApi.list);
const getMock = vi.mocked(agentsApi.get);
const createMock = vi.mocked(agentsApi.create);
const updateMock = vi.mocked(agentsApi.update);
const removeMock = vi.mocked(agentsApi.remove);
const archiveMock = vi.mocked(agentsApi.archive);
const enableMock = vi.mocked(agentsApi.enable);
const disableMock = vi.mocked(agentsApi.disable);
const versionsMock = vi.mocked(agentsApi.versions);
const skillsListMock = vi.mocked(skillsApi.list);

function makeSkill(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "sk1",
    key: "scan-deps",
    name: "Scan Deps",
    description: "",
    version: "1.0.0",
    tools: [],
    resources: [],
    tags: [],
    enabled: true,
    archived: false,
    source: "inline",
    contentSha256: null,
    createdById: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

function makeSummary(over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "ag1",
    key: "researcher",
    name: "researcher",
    displayName: "Researcher",
    description: "Research persona",
    version: "1.0.0",
    model: "gpt-4",
    tools: [],
    tags: [],
    handoffs: [],
    enabled: true,
    archived: false,
    source: "inline",
    contentSha256: null,
    defaultSkillKeys: ["scan-deps"],
    createdById: null,
    createdAt: "2026-04-25T00:00:00Z",
    updatedAt: "2026-04-25T00:00:00Z",
    ...over,
  };
}

function makeDetail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    ...makeSummary(),
    systemPrompt: "You are a researcher.",
    manifest: { name: "researcher", description: "x", version: "1.0.0", tools: [], tags: ["a"] },
    ...over,
  } as AgentDetail;
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [makeSummary()] });
  getMock.mockResolvedValue(makeDetail());
  createMock.mockResolvedValue(makeDetail());
  updateMock.mockResolvedValue(makeDetail());
  removeMock.mockResolvedValue(undefined);
  archiveMock.mockResolvedValue(makeDetail({ archived: true }));
  enableMock.mockResolvedValue(makeDetail({ enabled: true }));
  disableMock.mockResolvedValue(makeDetail({ enabled: false }));
  versionsMock.mockResolvedValue({
    items: [
      {
        id: "v1",
        version: "1.0.0",
        contentSha256: "abcdef0123456789",
        createdById: null,
        createdAt: "2026-04-25T00:00:00Z",
      },
    ],
  });
  skillsListMock.mockResolvedValue({
    items: [
      makeSkill(),
      makeSkill({ id: "sk2", key: "draft-pr", name: "Draft PR" }),
      makeSkill({ id: "sk3", key: "archived-skill", archived: true }),
      makeSkill({ id: "sk4", key: "disabled-skill", enabled: false }),
    ],
  });
});

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(
    <Wrapper>
      <AdminAgentsPage />
    </Wrapper>,
  );
}

describe("rebuildAgentSource", () => {
  it("emits canonical YAML frontmatter and the system prompt", () => {
    const out = rebuildAgentSource(
      makeDetail({
        manifest: { name: "x", model: "gpt", tools: [], tags: ["a"], gone: null },
        systemPrompt: "PROMPT",
      }),
    );
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain('name: "x"');
    expect(out).not.toContain("tools:");
    expect(out).not.toContain("gone:");
    expect(out.endsWith("PROMPT")).toBe(true);
  });
});

describe("<AdminAgentsPage />", () => {
  it("shows the loading row, then a row per agent", async () => {
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    expect(screen.getByText("researcher")).toBeInTheDocument();
    expect(screen.getByText("gpt-4")).toBeInTheDocument();
    expect(screen.getByText("scan-deps")).toBeInTheDocument();
  });

  it("falls back to the agent name when displayName is empty", async () => {
    listMock.mockResolvedValue({
      items: [makeSummary({ displayName: "", name: "anon" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("anon")).toBeInTheDocument());
  });

  it("shows em-dashes for empty default skill list and missing model", async () => {
    listMock.mockResolvedValue({
      items: [makeSummary({ defaultSkillKeys: [], model: "" })],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    const row = screen.getByText("Researcher").closest("tr")!;
    const dashes = within(row).getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("shows the empty state when no agents match", async () => {
    listMock.mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("No agents match.")).toBeInTheDocument());
  });

  it("filters via the search input and the include-archived checkbox", async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("agents-search"), { target: { value: "rese" } });
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ q: "rese" }));
    fireEvent.click(screen.getByLabelText("Include archived"));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ q: "rese", includeArchived: "1" }));
  });

  it("opens the create dialog and submits successfully", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    expect(await screen.findByText("Create agent")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("agent-save"));
    await waitFor(() => expect(createMock).toHaveBeenCalled());
  });

  it("toggles a default skill checkbox in the create form", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    await screen.findByText("Create agent");
    const cb = (await screen.findByTestId("agent-skill-scan-deps")) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    await waitFor(() => expect((cb as HTMLInputElement).checked).toBe(true));
    fireEvent.click(cb);
    await waitFor(() => expect((cb as HTMLInputElement).checked).toBe(false));
  });

  it("filters out disabled and archived skills from the picker", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    await screen.findByTestId("agent-skill-scan-deps");
    expect(screen.getByTestId("agent-skill-draft-pr")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-skill-archived-skill")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-skill-disabled-skill")).not.toBeInTheDocument();
  });

  it("shows the empty-skills message when the picker has nothing to show", async () => {
    skillsListMock.mockResolvedValue({ items: [] });
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    expect(await screen.findByText("No skills available.")).toBeInTheDocument();
  });

  it("renders an error alert when create fails with an ApiError", async () => {
    createMock.mockRejectedValue(new ApiError(400, "rejected", "BAD"));
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    await screen.findByText("Create agent");
    fireEvent.click(screen.getByTestId("agent-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("rejected");
  });

  it("falls back to a generic error message on non-ApiError failures", async () => {
    createMock.mockRejectedValue(new Error("boom"));
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    await screen.findByText("Create agent");
    fireEvent.click(screen.getByTestId("agent-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  });

  it("opens the edit dialog and saves changes", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("ag1"));
    expect(await screen.findByText(/Edit agent researcher/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("agent-save"));
    await waitFor(() => expect(updateMock).toHaveBeenCalled());
  });

  it("shows an error message if loading the edit detail fails", async () => {
    getMock.mockRejectedValue(new Error("nope"));
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]);
    expect(await screen.findByText("Failed to load agent.")).toBeInTheDocument();
  });

  it("opens the versions dialog and lists versions", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Versions" })[0]);
    await waitFor(() => expect(versionsMock).toHaveBeenCalledWith("ag1"));
    expect(await screen.findByText("v1.0.0")).toBeInTheDocument();
  });

  it("renders the empty versions state", async () => {
    versionsMock.mockResolvedValue({ items: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: "Versions" })[0]);
    expect(await screen.findByText("No versions yet.")).toBeInTheDocument();
  });

  it("toggles enable/disable for an agent", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    const row = screen.getByText("Researcher").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(disableMock).toHaveBeenCalledWith("ag1"));
  });

  it("calls enable when the agent is currently disabled", async () => {
    listMock.mockResolvedValue({ items: [makeSummary({ enabled: false })] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    const row = screen.getByText("Researcher").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(enableMock).toHaveBeenCalledWith("ag1"));
  });

  it("archives an agent", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    const row = screen.getByText("Researcher").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith("ag1"));
  });

  it("hides the archive button on already-archived agents", async () => {
    listMock.mockResolvedValue({ items: [makeSummary({ archived: true, enabled: false })] });
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    const row = screen.getByText("Researcher").closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(within(row).getByText("archived")).toBeInTheDocument();
  });

  it("renders the disabled state pill", async () => {
    listMock.mockResolvedValue({ items: [makeSummary({ enabled: false })] });
    renderPage();
    await waitFor(() => expect(screen.getByText("disabled")).toBeInTheDocument());
  });

  it("deletes an agent after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    const row = screen.getByText("Researcher").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("ag1"));
    confirmSpy.mockRestore();
  });

  it("does not delete when confirm is cancelled", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await waitFor(() => expect(screen.getByText("Researcher")).toBeInTheDocument());
    const row = screen.getByText("Researcher").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(removeMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("edits the source textarea inside the create form", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    const ta = (await screen.findByTestId("agent-source")) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "---\nname: edited\n---\nbody" } });
    expect(ta.value).toContain("edited");
  });

  it("cancels out of the create dialog", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("new-agent"));
    await screen.findByText("Create agent");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Create agent")).not.toBeInTheDocument());
  });
});
