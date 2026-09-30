/**
 * Unit tests for the ProjectScopeSelector component.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, renderHook, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectScopeSelector, useProjectScope } from "@/components/chat/project-scope-selector";
import type { ProjectScope } from "@/components/chat/project-scope-selector";
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

describe("useProjectScope", () => {
  const hook = () =>
    renderHook(() => useProjectScope(), { wrapper: makeWrapper({ withAuth: false }) });

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(apiFetch).mockClear();
    vi.mocked(apiFetch).mockResolvedValue([
      { id: "p-1", name: "Alpha" },
      { id: "p-2", name: "Beta" },
      { id: "p-3", name: "Gamma" },
    ]);
  });

  it("returns default scope with mode 'all' when localStorage is empty", () => {
    const { result } = hook();
    expect(result.current.scope).toEqual({ mode: "all", projectIds: [] });
  });

  it("restores scope from localStorage", () => {
    const stored: ProjectScope = { mode: "selected", projectIds: ["p-1"] };
    localStorage.setItem("metis.chat.projectScope", JSON.stringify(stored));
    const { result, rerender } = hook();
    // After useEffect runs
    rerender();
    expect(result.current.scope).toEqual(stored);
  });

  it("collapses a stored multi-project scope on load (#1368)", () => {
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "selected", projectIds: ["p-1", "p-2"] }),
    );
    const { result, rerender } = hook();
    rerender();
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-1"] });
  });

  /**
   * #1367 — the stored scope lands one tick after mount. Without a hydration
   * flag the chat page ran its session effect on the DEFAULT scope first,
   * burning its single allowed resume, so the real pass minted a new session
   * and overwrote the stored id — a reload of bare `/chat` lost the thread.
   */
  it("reports hydrated only after the stored scope has been read (#1367)", () => {
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "selected", projectIds: ["p-1"] }),
    );
    const { result, rerender } = hook();
    rerender();
    expect(result.current.hydrated).toBe(true);
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-1"] });
  });

  it("a stored scope wins without asking for the project list (#18)", () => {
    localStorage.setItem(
      "metis.chat.projectScope",
      JSON.stringify({ mode: "all", projectIds: [] }),
    );
    vi.mocked(apiFetch).mockResolvedValue([{ id: "p-1", name: "Alpha" }]);
    const { result, rerender } = hook();
    rerender();
    expect(result.current.hydrated).toBe(true);
    expect(result.current.scope).toEqual({ mode: "all", projectIds: [] });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("reports hydrated even when nothing is stored (#1367)", async () => {
    const { result } = hook();
    // Must not stall a consumer that waits on hydration before acting.
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    // Several projects: "all" stays the default — picking one would be a guess.
    expect(result.current.scope).toEqual({ mode: "all", projectIds: [] });
  });

  /**
   * #18 — "All projects" runs no retrieval. With a single project there is
   * nothing to choose, so a first-time chat starts grounded in it — and only
   * once that is known, so the page never creates a session on "all" first.
   */
  it("defaults to the only project when the user can reach exactly one (#18)", async () => {
    vi.mocked(apiFetch).mockResolvedValue([{ id: "p-only", name: "Solo" }]);
    const { result } = hook();
    expect(result.current.hydrated).toBe(false);
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "selected", projectIds: ["p-only"] });
    // The default is not persisted: it follows the project list until the user picks.
    expect(localStorage.getItem("metis.chat.projectScope")).toBeNull();
  });

  it("stays on 'all' when the user has no projects (#18)", async () => {
    vi.mocked(apiFetch).mockResolvedValue([]);
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "all", projectIds: [] });
  });

  it("still hydrates on 'all' when the project list cannot be read (#18)", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error("offline"));
    const { result } = hook();
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.scope).toEqual({ mode: "all", projectIds: [] });
  });
});
