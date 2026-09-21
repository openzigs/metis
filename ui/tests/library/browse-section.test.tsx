/**
 * #469 — Library Browse section wiring:
 *   - skill hits use the default-allow-aware ProjectSkillAllowlistToggle
 *   - agent hits keep the simple explicit-row toggle
 *   - the manage controls are gated on the viewer's `project.update` permission
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper, TEST_USER } from "../test-utils";
import { LibraryBrowseSection } from "@/components/library/browse-section";
import { libraryApi } from "@/lib/library-api";
import type { AuthUser } from "@/lib/auth-types";

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
const availableMock = vi.mocked(libraryApi.projectAvailableSkills);
const projectAgentsMock = vi.mocked(libraryApi.projectAgents);
const setProjectAgentMock = vi.mocked(libraryApi.setProjectAgent);

const SKILL_HIT = {
  kind: "skill" as const,
  id: "s1",
  key: "scan",
  name: "Scan deps",
  description: "",
  tags: [],
  updatedAt: "2025-01-01T00:00:00Z",
};
const AGENT_HIT = {
  kind: "agent" as const,
  id: "a1",
  key: "planner",
  name: "Planner",
  description: "",
  tags: [],
  updatedAt: "2025-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  searchMock.mockResolvedValue({ items: [SKILL_HIT, AGENT_HIT] });
  projectSkillsMock.mockResolvedValue({ items: [] });
  availableMock.mockResolvedValue({
    items: [{ skillId: "s1", skillKey: "scan", name: "Scan deps", description: "" }],
  });
  projectAgentsMock.mockResolvedValue({ items: [] });
  setProjectAgentMock.mockResolvedValue(undefined as unknown as never);
});
afterEach(() => vi.restoreAllMocks());

function renderSection(opts: { projectId?: string | null; user?: AuthUser | null } = {}) {
  const { projectId = "p1", user = { ...TEST_USER, permissions: ["project.update"] } } = opts;
  render(<LibraryBrowseSection projectId={projectId} />, {
    wrapper: makeWrapper({ initialUser: user }),
  });
}

describe("<LibraryBrowseSection /> per-project toggles (#469)", () => {
  it("renders the default-allow-aware skill toggle for skill hits", async () => {
    renderSection();
    expect(await screen.findByTestId("project-skill-allow-s1")).toBeInTheDocument();
    expect(await screen.findByTestId("project-skill-state-s1")).toHaveTextContent("Default");
  });

  it("keeps the simple explicit-row toggle for agent hits", async () => {
    renderSection();
    expect(await screen.findByTestId("project-toggle-agent-a1")).toBeInTheDocument();
  });

  it("renders skill management controls when the viewer holds project.update", async () => {
    renderSection({ user: { ...TEST_USER, permissions: ["project.update"] } });
    expect(await screen.findByTestId("project-skill-disallow-btn-s1")).toBeInTheDocument();
  });

  it("renders skills read-only (no buttons) when the viewer lacks project.update", async () => {
    renderSection({ user: { ...TEST_USER, permissions: [] } });
    expect(await screen.findByTestId("project-skill-state-s1")).toBeInTheDocument();
    expect(screen.queryByTestId("project-skill-disallow-btn-s1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-skill-allow-btn-s1")).not.toBeInTheDocument();
  });

  it("renders no per-project toggles when there is no projectId", async () => {
    renderSection({ projectId: null });
    expect(await screen.findByText("Scan deps")).toBeInTheDocument();
    expect(screen.queryByTestId("project-skill-state-s1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-toggle-agent-a1")).not.toBeInTheDocument();
  });

  it("toggling an agent calls setProjectAgent through the existing endpoint", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByTestId("project-toggle-agent-a1"));
    await waitFor(() => expect(setProjectAgentMock).toHaveBeenCalledWith("p1", "a1", true));
  });
});

describe("<LibraryBrowseSection /> search + filters", () => {
  it("renders an empty state when the search returns no hits", async () => {
    searchMock.mockResolvedValue({ items: [] });
    renderSection();
    expect(await screen.findByText("No matches.")).toBeInTheDocument();
  });

  it("passes the typed query and kind filter into the search call", async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByText("Scan deps");
    await user.type(screen.getByTestId("library-search"), "scan");
    await user.click(screen.getByTestId("library-filter-skill"));
    await waitFor(() =>
      expect(searchMock).toHaveBeenCalledWith(
        expect.objectContaining({ q: "scan", kind: "skill" }),
      ),
    );
  });
});
