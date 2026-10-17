/**
 * Unit tests for the ProjectScopeSelector component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ProjectScopeSelector,
  initialChatScope,
  useProjectScope,
} from "@/components/chat/project-scope-selector";
import { makeWrapper } from "./test-utils";
import { apiFetch } from "@/lib/api-client";

// Mock apiFetch so useQuery doesn't hit a real endpoint
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue([
      { id: "p-1", name: "Alpha" },
      { id: "p-2", name: "Beta" },
      { id: "p-3", name: "Gamma" },
    ]),
  };
});

describe("ProjectScopeSelector", () => {
  const defaultProps = {
    value: { mode: "all" as const, projectIds: [] },
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders the selector button with 'All projects' label by default", () => {
    render(<ProjectScopeSelector {...defaultProps} />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("project-scope-selector")).toBeInTheDocument();
    expect(screen.getByText("All projects")).toBeInTheDocument();
  });

  it("names the selected project rather than counting it (#1368)", async () => {
    render(
      <ProjectScopeSelector value={{ mode: "selected", projectIds: ["p-1"] }} onChange={vi.fn()} />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(screen.queryByText("1 project")).not.toBeInTheDocument();
  });

  it("collapses a legacy multi-project selection to the first project (#1368)", async () => {
    render(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1", "p-2"] }}
        onChange={vi.fn()}
      />,
      { wrapper: makeWrapper() },
    );
    // Chat supports one project; two can no longer be represented, so the label
    // never reads "2 projects" and the turn can never run silently unscoped.
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(screen.queryByText("2 projects")).not.toBeInTheDocument();
  });

  it("opens dropdown on click and shows project list", async () => {
    const user = userEvent.setup();
    render(<ProjectScopeSelector {...defaultProps} />, { wrapper: makeWrapper() });

    await user.click(screen.getByTestId("project-scope-selector"));
    // Should show the "All my projects" option
    expect(screen.getByText("All my projects")).toBeInTheDocument();
  });

  it("calls onChange when a project is toggled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ProjectScopeSelector value={{ mode: "all", projectIds: [] }} onChange={onChange} />, {
      wrapper: makeWrapper(),
    });

    await user.click(screen.getByTestId("project-scope-selector"));
    // Wait for projects to load from the mocked query
    const checkbox = await screen.findByLabelText("Alpha");
    await user.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "selected", projectIds: ["p-1"] }),
    );
  });

  it("calls onChange with mode 'all' when 'All my projects' is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1"] }}
        onChange={onChange}
      />,
      { wrapper: makeWrapper() },
    );

    await user.click(screen.getByTestId("project-scope-selector"));
    await user.click(screen.getByText("All my projects"));
    expect(onChange).toHaveBeenCalledWith({ mode: "all", projectIds: [] });
  });

  it("disables the button when disabled prop is true", () => {
    render(<ProjectScopeSelector {...defaultProps} disabled />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("project-scope-selector")).toBeDisabled();
  });

  it("prunes a stale project id from the scope once the project list loads", async () => {
    const onChange = vi.fn();
    render(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1", "p-gone"] }}
        onChange={onChange}
      />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ mode: "selected", projectIds: ["p-1"] }),
    );
  });

  it("reverts to 'all' when every selected id is stale", async () => {
    const onChange = vi.fn();
    render(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-gone", "p-also-gone"] }}
        onChange={onChange}
      />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ mode: "all", projectIds: [] }));
  });

  it("does not prune when all selected ids are still accessible", async () => {
    const onChange = vi.fn();
    render(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1", "p-2"] }}
        onChange={onChange}
      />,
      { wrapper: makeWrapper() },
    );
    // Give the query time to resolve, then assert no reconciliation fired.
    await screen.findByTestId("project-scope-selector");
    await new Promise((r) => setTimeout(r, 20));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("initialChatScope (#1139)", () => {
  it("opens on the active project, whatever scope is stored", () => {
    expect(initialChatScope("p-2", { mode: "selected", projectIds: ["p-1"] })).toEqual({
      mode: "selected",
      projectIds: ["p-2"],
    });
    expect(initialChatScope("p-2", { mode: "all", projectIds: [] })).toEqual({
      mode: "selected",
      projectIds: ["p-2"],
    });
  });

  it("uses the stored scope only when no project is active", () => {
    expect(initialChatScope(null, { mode: "selected", projectIds: ["p-1"] })).toEqual({
      mode: "selected",
      projectIds: ["p-1"],
    });
    expect(initialChatScope(null, null)).toEqual({ mode: "all", projectIds: [] });
  });
});

describe("useProjectScope (#1139 — the scope chat opens on)", () => {
  const hook = () =>
    renderHook(() => useProjectScope(), { wrapper: makeWrapper({ withAuth: false }) });
  const LIST = [
    { id: "p-1", name: "Alpha" },
    { id: "p-2", name: "Beta" },
    { id: "p-3", name: "Gamma" },
  ];
  /** `/projects` is the top bar's list; `/search/projects` the selector's. */
  function serve(projects: typeof LIST | Error) {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (projects instanceof Error) throw projects;
      return (path === "/projects" ? { items: projects } : projects) as never;
    });
  }

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
    serve(LIST);
  });

  it("opens on the project active in the top bar, not the stored scope", async () => {
    localStorage.setItem("metis.activeProjectId", "p-2");
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "selected", projectIds: ["p-1"] }),
    );
    const { result } = hook();
    expect(result.current.hydrated).toBe(false);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-2"] });
  });

  it("with nothing stored, opens on the project the top bar shows: the first listed", async () => {
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-1"] });
  });

  it("an active id no longer in the list falls back the way the top bar does", async () => {
    localStorage.setItem("metis.activeProjectId", "p-gone");
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-1"] });
  });

  it("uses the stored scope when no project is active (the user has none)", async () => {
    serve([]);
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "all", projectIds: [] }),
    );
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "all", projectIds: [] });
  });

  it("collapses a stored multi-project scope it falls back to (#1368)", async () => {
    serve(new Error("offline"));
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "selected", projectIds: ["p-1", "p-2"] }),
    );
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-1"] });
  });

  it("still hydrates on 'all' when the list cannot be read and nothing is stored", async () => {
    serve(new Error("offline"));
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "all", projectIds: [] });
  });

  it("the opening scope is not persisted: it follows the top bar until the user picks", async () => {
    localStorage.setItem("metis.activeProjectId", "p-3");
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(localStorage.getItem("metis.chat.projectScope")).toBeNull();
  });
});
