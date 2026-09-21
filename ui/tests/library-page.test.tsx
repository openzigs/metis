import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { makeWrapper, TEST_USER } from "./test-utils";
import LibraryPage from "@/app/(authed)/library/page";
import { libraryApi } from "@/lib/library-api";

vi.mock("@/lib/library-api", () => ({
  libraryApi: {
    search: vi.fn(),
    projectSkills: vi.fn(),
    projectAvailableSkills: vi.fn(),
    projectAgents: vi.fn(),
    setProjectSkill: vi.fn(),
    setProjectAgent: vi.fn(),
  },
}));

const searchMock = vi.mocked(libraryApi.search);
const projectSkillsMock = vi.mocked(libraryApi.projectSkills);
const projectAvailableSkillsMock = vi.mocked(libraryApi.projectAvailableSkills);
const projectAgentsMock = vi.mocked(libraryApi.projectAgents);
const setProjectSkillMock = vi.mocked(libraryApi.setProjectSkill);
const setProjectAgentMock = vi.mocked(libraryApi.setProjectAgent);
const useSearchParamsMock = vi.mocked(useSearchParams);

// #469 — LibraryPage's Browse section now reads `useAuth()` (to gate the
// per-project skill controls on `project.update`), so every render needs an
// AuthProvider. A project-updater user is used so the manage controls render.
const PROJECT_UPDATER = { ...TEST_USER, permissions: ["project.update" as const] };
function authWrapper() {
  return makeWrapper({ initialUser: PROJECT_UPDATER });
}

const skillHit = {
  kind: "skill" as const,
  id: "s1",
  key: "scan-deps",
  name: "Scan Deps",
  description: "Scans dependencies",
  tags: ["security"],
  updatedAt: "2026-04-25T00:00:00Z",
};
const agentHit = {
  kind: "agent" as const,
  id: "a1",
  key: "researcher",
  name: "Researcher",
  description: "Research agent",
  tags: [],
  updatedAt: "2026-04-25T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  useSearchParamsMock.mockReturnValue(new URLSearchParams() as ReturnType<typeof useSearchParams>);
  searchMock.mockResolvedValue({ items: [skillHit, agentHit] });
  projectSkillsMock.mockResolvedValue({
    items: [{ skillId: "s1", skillKey: "scan-deps", enabled: false, addedById: null }],
  });
  projectAvailableSkillsMock.mockResolvedValue({ items: [] });
  projectAgentsMock.mockResolvedValue({
    items: [{ agentId: "a1", agentKey: "researcher", enabled: true, addedById: null }],
  });
  setProjectSkillMock.mockResolvedValue(undefined);
  setProjectAgentMock.mockResolvedValue(undefined);
});

describe("<LibraryPage />", () => {
  it("renders header copy without a project context", async () => {
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText(/Open a project to manage per-project access/i)).toBeInTheDocument();
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
  });

  it("shows the project copy when ?projectId is set", async () => {
    useSearchParamsMock.mockReturnValue(
      new URLSearchParams("projectId=p-1") as ReturnType<typeof useSearchParams>,
    );
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    expect(screen.getByText(/Toggle skills\/agents per project/i)).toBeInTheDocument();
  });

  it("renders search results and tag chips", async () => {
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText("Scan Deps")).toBeInTheDocument());
    expect(screen.getByText("Researcher")).toBeInTheDocument();
    expect(screen.getByText("security")).toBeInTheDocument();
  });

  it("filters via the search input and refires the query", async () => {
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    const input = screen.getByTestId("library-search") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "scan" } });
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith({ q: "scan" }));
  });

  it("filters by kind when a kind button is clicked", async () => {
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("library-filter-skill"));
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith({ kind: "skill" }));
    fireEvent.click(screen.getByTestId("library-filter-agent"));
    await waitFor(() => expect(searchMock).toHaveBeenCalledWith({ kind: "agent" }));
  });

  it("shows the empty state when search returns no items", async () => {
    searchMock.mockResolvedValue({ items: [] });
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText("No matches.")).toBeInTheDocument());
  });

  // #469 — skills now use the default-allow-aware allowlist toggle. With one
  // explicitly-disabled row (and no available rows), the skill reads as
  // "Disallowed" and the action is "Allow" → PUT enabled=true. No confirm is
  // needed because explicit rows already exist (this is not the first one).
  it("renders the skill allowlist toggle and allows a disallowed skill on click", async () => {
    useSearchParamsMock.mockReturnValue(
      new URLSearchParams("projectId=p-1") as ReturnType<typeof useSearchParams>,
    );
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("project-skill-state-s1")).toHaveTextContent("Disallowed"),
    );
    const allow = await screen.findByTestId("project-skill-allow-btn-s1");
    fireEvent.click(allow);
    await waitFor(() => expect(setProjectSkillMock).toHaveBeenCalledWith("p-1", "s1", true));
  });

  it("renders an enabled agent toggle and toggles it off on click", async () => {
    useSearchParamsMock.mockReturnValue(
      new URLSearchParams("projectId=p-1") as ReturnType<typeof useSearchParams>,
    );
    const Wrapper = authWrapper();
    render(
      <Wrapper>
        <LibraryPage />
      </Wrapper>,
    );
    const toggle = await screen.findByTestId("project-toggle-agent-a1");
    await waitFor(() => expect(toggle).toHaveTextContent("Enabled"));
    fireEvent.click(toggle);
    await waitFor(() => expect(setProjectAgentMock).toHaveBeenCalledWith("p-1", "a1", false));
  });
});
