/**
 * #469 — per-project SKILL allowlist toggle: legible default-allow state plus a
 * guarded write through the existing PUT endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "../test-utils";
import {
  ProjectSkillAllowlistToggle,
  resolveSkillAllowState,
} from "@/components/library/project-skill-allowlist-toggle";
import { libraryApi } from "@/lib/library-api";

vi.mock("@/lib/library-api", () => ({
  libraryApi: {
    projectSkills: vi.fn(),
    projectAvailableSkills: vi.fn(),
    setProjectSkill: vi.fn(),
  },
}));

const projectSkillsMock = vi.mocked(libraryApi.projectSkills);
const availableMock = vi.mocked(libraryApi.projectAvailableSkills);
const setProjectSkillMock = vi.mocked(libraryApi.setProjectSkill);

beforeEach(() => {
  vi.clearAllMocks();
  setProjectSkillMock.mockResolvedValue(undefined as unknown as never);
});
afterEach(() => vi.restoreAllMocks());

function renderToggle(opts: { skillId?: string; canManage?: boolean } = {}) {
  const { skillId = "s1", canManage = true } = opts;
  render(<ProjectSkillAllowlistToggle projectId="p1" skillId={skillId} canManage={canManage} />, {
    wrapper: makeWrapper({ withAuth: false }),
  });
}

describe("resolveSkillAllowState (pure)", () => {
  it("treats a project with no explicit rows as available-by-default", () => {
    const r = resolveSkillAllowState({
      skillId: "s1",
      explicitRows: [],
      availableSkillIds: new Set(["s1"]),
    });
    expect(r.state).toBe("available-by-default");
    expect(r.projectHasNoExplicitRows).toBe(true);
    expect(r.effectivelyAllowed).toBe(true);
  });

  it("reports explicitly-enabled when a positive row exists", () => {
    const r = resolveSkillAllowState({
      skillId: "s1",
      explicitRows: [{ skillId: "s1", skillKey: "k", enabled: true, addedById: null }],
      availableSkillIds: new Set(["s1"]),
    });
    expect(r.state).toBe("explicitly-enabled");
  });

  it("reports explicitly-disabled for a negative row", () => {
    const r = resolveSkillAllowState({
      skillId: "s1",
      explicitRows: [{ skillId: "s1", skillKey: "k", enabled: false, addedById: null }],
      availableSkillIds: new Set(),
    });
    expect(r.state).toBe("explicitly-disabled");
  });

  it("treats a skill with no row as disallowed once OTHER explicit rows exist", () => {
    const r = resolveSkillAllowState({
      skillId: "s2",
      explicitRows: [{ skillId: "s1", skillKey: "k", enabled: true, addedById: null }],
      availableSkillIds: new Set(["s1"]),
    });
    expect(r.state).toBe("explicitly-disabled");
    expect(r.projectHasNoExplicitRows).toBe(false);
  });
});

describe("<ProjectSkillAllowlistToggle />", () => {
  it("shows a 'Default' state and default-allow warning when no explicit rows exist", async () => {
    projectSkillsMock.mockResolvedValue({ items: [] });
    availableMock.mockResolvedValue({
      items: [{ skillId: "s1", skillKey: "k", name: "Scan", description: "" }],
    });
    renderToggle();
    expect(await screen.findByTestId("project-skill-state-s1")).toHaveTextContent("Default");
    expect(screen.getByText(/restricts this project to only the skills you allow/i)).toBeVisible();
  });

  it("in default-allow the action is Disallow (skill currently reads as allowed)", async () => {
    projectSkillsMock.mockResolvedValue({ items: [] });
    availableMock.mockResolvedValue({
      items: [{ skillId: "s1", skillKey: "k", name: "Scan", description: "" }],
    });
    renderToggle();
    expect(await screen.findByTestId("project-skill-disallow-btn-s1")).toBeInTheDocument();
    expect(screen.queryByTestId("project-skill-allow-btn-s1")).not.toBeInTheDocument();
  });

  it("confirms before the FIRST explicit row is written, then calls PUT", async () => {
    projectSkillsMock.mockResolvedValue({ items: [] });
    availableMock.mockResolvedValue({
      items: [{ skillId: "s1", skillKey: "k", name: "Scan", description: "" }],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderToggle();
    await user.click(await screen.findByTestId("project-skill-disallow-btn-s1"));
    expect(confirmSpy).toHaveBeenCalledOnce();
    await waitFor(() => expect(setProjectSkillMock).toHaveBeenCalledWith("p1", "s1", false));
    confirmSpy.mockRestore();
  });

  it("aborts the first-row write when the confirm is dismissed", async () => {
    projectSkillsMock.mockResolvedValue({ items: [] });
    availableMock.mockResolvedValue({
      items: [{ skillId: "s1", skillKey: "k", name: "Scan", description: "" }],
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderToggle();
    await user.click(await screen.findByTestId("project-skill-disallow-btn-s1"));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(setProjectSkillMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("allows re-enabling an explicitly-disabled skill via PUT enabled=true", async () => {
    projectSkillsMock.mockResolvedValue({
      items: [{ skillId: "s1", skillKey: "k", enabled: false, addedById: null }],
    });
    availableMock.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderToggle();
    const allow = await screen.findByTestId("project-skill-allow-btn-s1");
    expect(screen.getByTestId("project-skill-state-s1")).toHaveTextContent("Disallowed");
    await user.click(allow);
    await waitFor(() => expect(setProjectSkillMock).toHaveBeenCalledWith("p1", "s1", true));
  });

  it("hides the action buttons (read-only) without project.update", async () => {
    projectSkillsMock.mockResolvedValue({ items: [] });
    availableMock.mockResolvedValue({
      items: [{ skillId: "s1", skillKey: "k", name: "Scan", description: "" }],
    });
    renderToggle({ canManage: false });
    expect(await screen.findByTestId("project-skill-state-s1")).toBeInTheDocument();
    expect(screen.queryByTestId("project-skill-allow-btn-s1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("project-skill-disallow-btn-s1")).not.toBeInTheDocument();
    // No "first explicit row" warning when the viewer can't manage.
    expect(
      screen.queryByText(/restricts this project to only the skills you allow/i),
    ).not.toBeInTheDocument();
  });
});
