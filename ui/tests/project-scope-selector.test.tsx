/**
 * Unit tests for the ProjectScopeSelector component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ProjectScopeSelector,
  initialChatScope,
  normaliseScope,
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

  // #2351 — the shared picker has no "All" option: an unscoped chat (nothing
  // ticked) reads "No product chosen", not "All projects" (#2330: "All" meant
  // no search here and everything in the portfolio check).
  it("renders the selector button with 'No product chosen' by default", () => {
    render(<ProjectScopeSelector {...defaultProps} />, { wrapper: makeWrapper() });
    expect(screen.getByTestId("project-scope-selector")).toBeInTheDocument();
    expect(screen.getByText("No product chosen")).toBeInTheDocument();
  });

  it("names the selected project rather than counting it (#1368)", async () => {
    render(
      <ProjectScopeSelector value={{ mode: "selected", projectIds: ["p-1"] }} onChange={vi.fn()} />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(screen.queryByText("1 project")).not.toBeInTheDocument();
  });

  // #2238 — chat searches every project of a multi-product scope, so the
  // selector names them instead of collapsing to one (#1368's workaround).
  it("names a multi-product selection (#2238)", async () => {
    const { rerender } = render(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1", "p-2"] }}
        onChange={vi.fn()}
      />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(screen.getByText("Alpha + Beta")).toBeInTheDocument());
    rerender(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1", "p-2", "p-3"] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Alpha + 2 more")).toBeInTheDocument();
  });

  it("adds a ticked project to the selection and removes an unticked one (#2238)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1"] }}
        onChange={onChange}
      />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    await user.click(screen.getByTestId("project-scope-selector"));
    await user.click(await screen.findByLabelText("Beta"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "selected", projectIds: ["p-1", "p-2"] });
    // The list stays open, so several can be ticked in a row.
    expect(screen.getByLabelText("Gamma")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("metis.chat.projectScope")!)).toEqual({
      mode: "selected",
      projectIds: ["p-1", "p-2"],
    });

    rerender(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-1", "p-2"] }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("Alpha"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "selected", projectIds: ["p-2"] });
    rerender(
      <ProjectScopeSelector
        value={{ mode: "selected", projectIds: ["p-2"] }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByLabelText("Beta"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "all", projectIds: [] });
  });

  it("opens dropdown on click and shows project list", async () => {
    const user = userEvent.setup();
    render(<ProjectScopeSelector {...defaultProps} />, { wrapper: makeWrapper() });

    await user.click(screen.getByTestId("project-scope-selector"));
    // #2351 — the shared picker's three options, in order.
    expect(screen.getByTestId("project-scope-this")).toHaveTextContent("This project");
    expect(screen.getByTestId("project-scope-workspace")).toHaveTextContent("Whole workspace");
    expect(screen.getByRole("group", { name: "Chosen products" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Alpha")).toBeInTheDocument();
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

  // #2351 — there is no "All my projects" option: unticking the last product
  // returns chat to "all" (no search), the same scope it was before.
  it("calls onChange with mode 'all' when the last product is unticked", async () => {
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
    await user.click(await screen.findByLabelText("Alpha"));
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

  it("#2238 — keeps a stored scope that agrees with the top bar", () => {
    const multi = { mode: "selected" as const, projectIds: ["p-1", "p-2"] };
    expect(initialChatScope("p-2", multi)).toEqual(multi);
    expect(initialChatScope("p-3", multi)).toEqual({ mode: "selected", projectIds: ["p-3"] });
    const ws = { mode: "workspace" as const, projectIds: [], workspaceId: "w-1" };
    expect(initialChatScope("p-2", ws, "w-1")).toEqual(ws);
    expect(initialChatScope("p-2", ws, "w-2")).toEqual({ mode: "selected", projectIds: ["p-2"] });
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

  it("keeps a stored multi-product scope it falls back to (#2238)", async () => {
    serve(new Error("offline"));
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "selected", projectIds: ["p-1", "p-2", "p-1"] }),
    );
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-1", "p-2"] });
  });

  it("reopens on a stored multi-product scope that includes the active project (#2238)", async () => {
    localStorage.setItem("metis.activeProjectId", "p-2");
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "selected", projectIds: ["p-1", "p-2"] }),
    );
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-1", "p-2"] });
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

describe("normaliseScope (#2238)", () => {
  it("keeps a workspace scope only with its workspace, and de-duplicates projects", () => {
    expect(normaliseScope({ mode: "workspace", projectIds: ["x"], workspaceId: "w" })).toEqual({
      mode: "workspace",
      projectIds: [],
      workspaceId: "w",
    });
    expect(normaliseScope({ mode: "workspace", projectIds: [] })).toEqual({
      mode: "all",
      projectIds: [],
    });
    expect(normaliseScope({ mode: "selected", projectIds: ["a", "b", "a"] })).toEqual({
      mode: "selected",
      projectIds: ["a", "b"],
    });
    expect(normaliseScope({ mode: "selected", projectIds: [] })).toEqual({
      mode: "all",
      projectIds: [],
    });
  });
});

describe("ProjectScopeSelector — workspace scope (#2238)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("metis.activeWorkspaceId", "w-1");
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockImplementation(
      async (path: string) =>
        (path === "/workspaces"
          ? [{ id: "w-1", name: "Payments", slug: "payments", logoUrl: null, role: "member" }]
          : [
              { id: "p-1", name: "Alpha" },
              { id: "p-2", name: "Beta" },
            ]) as never,
    );
  });

  it("offers every project of the active workspace as one scope, and names it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ProjectScopeSelector value={{ mode: "all", projectIds: [] }} onChange={onChange} />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(screen.getByTestId("project-scope-selector")).toBeEnabled());
    await user.click(screen.getByTestId("project-scope-selector"));
    // #2351 — one wording for the workspace (#2330 found two).
    await user.click(await screen.findByTestId("project-scope-workspace"));
    expect(onChange).toHaveBeenCalledWith({
      mode: "workspace",
      projectIds: [],
      workspaceId: "w-1",
    });
    rerender(
      <ProjectScopeSelector
        value={{ mode: "workspace", projectIds: [], workspaceId: "w-1" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("project-scope-selector")).toHaveTextContent(
      "Whole workspace: Payments",
    );
  });

  it("a project ticked while the workspace is the scope starts a project selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectScopeSelector
        value={{ mode: "workspace", projectIds: [], workspaceId: "w-1" }}
        onChange={onChange}
      />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(screen.getByTestId("project-scope-selector")).toBeEnabled());
    await user.click(screen.getByTestId("project-scope-selector"));
    expect(screen.getByLabelText("Alpha")).not.toBeChecked();
    await user.click(screen.getByLabelText("Alpha"));
    expect(onChange).toHaveBeenCalledWith({ mode: "selected", projectIds: ["p-1"] });
  });

  // #2351 review — the option names the workspace it picks: the top bar's.
  it("a stored scope on another workspace names the button; the option names and picks the top bar's", async () => {
    vi.mocked(apiFetch).mockImplementation(
      async (path: string) =>
        (path === "/workspaces"
          ? [
              { id: "w-1", name: "Payments", slug: "payments", logoUrl: null, role: "member" },
              { id: "w-2", name: "Lending", slug: "lending", logoUrl: null, role: "member" },
            ]
          : [{ id: "p-1", name: "Alpha" }]) as never,
    );
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectScopeSelector
        value={{ mode: "workspace", projectIds: [], workspaceId: "w-2" }}
        onChange={onChange}
      />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() =>
      expect(screen.getByTestId("project-scope-selector")).toHaveTextContent(
        "Whole workspace: Lending",
      ),
    );
    await waitFor(() => expect(screen.getByTestId("project-scope-selector")).toBeEnabled());
    await user.click(screen.getByTestId("project-scope-selector"));
    const option = await screen.findByTestId("project-scope-workspace");
    await waitFor(() => expect(option).toHaveTextContent("Whole workspace: Payments"));
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith({
      mode: "workspace",
      projectIds: [],
      workspaceId: "w-1",
    });
  });

  it("with no workspace open the option is disabled and says why, even over a stored workspace scope", async () => {
    localStorage.removeItem("metis.activeWorkspaceId");
    vi.mocked(apiFetch).mockImplementation(
      async (path: string) =>
        (path === "/workspaces" ? [] : [{ id: "p-1", name: "Alpha" }]) as never,
    );
    const user = userEvent.setup();
    render(
      <ProjectScopeSelector
        value={{ mode: "workspace", projectIds: [], workspaceId: "w-2" }}
        onChange={vi.fn()}
      />,
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(screen.getByTestId("project-scope-selector")).toBeEnabled());
    await user.click(screen.getByTestId("project-scope-selector"));
    expect(await screen.findByTestId("project-scope-workspace")).toBeDisabled();
    expect(screen.getByText("No workspace is open in the top bar.")).toBeInTheDocument();
  });
});
