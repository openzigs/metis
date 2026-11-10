/**
 * #1584 — the header's Workspace › Project crumbs agree.
 *
 *   • The project switcher lists the ACTIVE workspace's projects (`b-5-8`: it
 *     listed every project the user could open).
 *   • On a project's pages the workspace crumb names THAT project's workspace
 *     (`f-j1-4a-13`: a second user saw their first workspace over a project in
 *     another one).
 *   • Choosing a workspace re-lists the project switcher at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter } from "next/navigation";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  readStoredActiveWorkspaceId,
  useActiveWorkspaceId,
  writeStoredActiveWorkspaceId,
} from "@/lib/active-workspace";
import { createQueryClient } from "@/lib/query-client";
import { makeWrapper, TEST_USER } from "./test-utils";

const project = (id: string, name: string, workspaceId: string | null) => ({
  id,
  name,
  slug: id,
  status: "active",
  workspaceId,
  createdById: "u-1",
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
});

const WORKSPACES = [
  { id: "ws-rerun", name: "Walkthrough 706 re-run", slug: "rerun", logoUrl: null, role: "member" },
  { id: "ws-run10", name: "Walkthrough run 10", slug: "run10", logoUrl: null, role: "member" },
];
const PROJECTS = [
  project("p-rerun", "Re-run project", "ws-rerun"),
  project("p-run10", "Run 10 project", "ws-run10"),
  project("p-legacy", "Legacy project", null),
];

function respond(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Not Found",
    text: () =>
      Promise.resolve(
        JSON.stringify(
          status < 400 ? { success: true, data } : { success: false, error: { code: "NOT_FOUND" } },
        ),
      ),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
/** The `workspaceId` of every project-list request, in order (`null` when unscoped). */
const listScopes = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://x"))
    .filter((u) => /\/projects$/.test(u.pathname))
    .map((u) => u.searchParams.get("workspaceId"));

/** The fake API: workspaces, one project by id, and the (optionally scoped) list. */
function route(input: RequestInfo | URL) {
  const url = new URL(String(input), "http://x");
  if (/\/workspaces$/.test(url.pathname)) return respond(WORKSPACES);
  const one = url.pathname.match(/\/projects\/([^/]+)$/);
  if (one) {
    const p = PROJECTS.find((x) => x.id === one[1]);
    return p ? respond(p) : respond(null, 404);
  }
  if (/\/projects$/.test(url.pathname)) {
    const ws = url.searchParams.get("workspaceId");
    const items = PROJECTS.filter((p) => !ws || p.workspaceId === ws || p.workspaceId === null);
    return respond({ items, total: items.length, limit: 50, offset: 0 });
  }
  return respond(null, 404);
}

beforeEach(() => {
  window.localStorage.clear();
  fetchMock = vi.fn(route);
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(useRouter().push).mockClear();
  vi.mocked(useRouter().refresh).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(usePathname).mockReturnValue("/");
});

const renderCrumbs = () =>
  render(<Breadcrumbs />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });

async function openMenu(name: RegExp) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name }));
  return { user, items: await screen.findAllByRole("menuitem") };
}

describe("project switcher scope (#1584, b-5-8)", () => {
  it("lists the active workspace's projects (and unassigned ones), not every project", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-run10");
    vi.mocked(usePathname).mockReturnValue("/dashboard");
    renderCrumbs();
    await waitFor(() => expect(listScopes()).toContain("ws-run10"));
    const { items } = await openMenu(/active project/i);
    expect(items.map((i) => i.textContent)).toEqual(["Run 10 project", "Legacy project"]);
  });

  it("re-lists at once when another workspace is chosen", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-run10");
    vi.mocked(usePathname).mockReturnValue("/dashboard");
    renderCrumbs();
    const { user, items } = await openMenu(/walkthrough run 10/i);
    await user.click(items.find((i) => i.textContent === "Walkthrough 706 re-run")!);
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-rerun");
    await waitFor(() => expect(listScopes()).toContain("ws-rerun"));
    // Off a project page nothing navigates; the page is refreshed in place.
    expect(useRouter().push).not.toHaveBeenCalled();
    expect(useRouter().refresh).toHaveBeenCalled();
    const projects = await openMenu(/active project/i);
    expect(projects.items.map((i) => i.textContent)).toEqual(["Re-run project", "Legacy project"]);
  });
});

describe("workspace crumb on a project page (#1584, f-j1-4a-13)", () => {
  it("names the project's workspace for a user who never chose one", async () => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-run10/reviews");
    renderCrumbs();
    expect(await screen.findByRole("button", { name: /walkthrough run 10/i })).toBeInTheDocument();
    expect(screen.queryByText("Walkthrough 706 re-run")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-run10"),
    );
    expect(
      await screen.findByRole("button", { name: /active project: run 10 project/i }),
    ).toBeInTheDocument();
  });

  it("overrides a stored workspace the project is not in", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-rerun");
    vi.mocked(usePathname).mockReturnValue("/projects/p-run10");
    renderCrumbs();
    expect(await screen.findByRole("button", { name: /walkthrough run 10/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-run10"),
    );
  });

  it("keeps the stored workspace on a project in no workspace", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-run10");
    vi.mocked(usePathname).mockReturnValue("/projects/p-legacy");
    renderCrumbs();
    await screen.findByRole("button", { name: /active project: legacy project/i });
    expect(screen.getByRole("button", { name: /walkthrough run 10/i })).toBeInTheDocument();
    // Choosing another workspace there stays on the page: the project is listed under every one.
    const { user, items } = await openMenu(/walkthrough run 10/i);
    await user.click(items.find((i) => i.textContent === "Walkthrough 706 re-run")!);
    expect(useRouter().push).not.toHaveBeenCalled();
  });

  it("choosing another workspace on a project page goes to that workspace's projects", async () => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-run10");
    renderCrumbs();
    const { user, items } = await openMenu(/walkthrough run 10/i);
    await user.click(items.find((i) => i.textContent === "Walkthrough 706 re-run")!);
    await waitFor(() => expect(useRouter().push).toHaveBeenCalledWith("/projects"));
    expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-rerun");
  });

  it("falls back to the stored workspace, then the first, when the project cannot be read", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-gone");
    vi.mocked(usePathname).mockReturnValue("/projects/p-missing");
    renderCrumbs();
    expect(
      await screen.findByRole("button", { name: /walkthrough 706 re-run/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-rerun"),
    );
  });
});

describe("a transient 500 on GET /api/workspaces (#1584, wave F)", () => {
  it("is retried by the app's query client rather than cached as no workspaces", async () => {
    let calls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (/\/workspaces$/.test(new URL(String(input), "http://x").pathname)) {
        calls += 1;
        if (calls === 1) return respond(null, 500);
      }
      return route(input);
    });
    vi.mocked(usePathname).mockReturnValue("/dashboard");
    render(<Breadcrumbs />, {
      wrapper: makeWrapper({ initialUser: TEST_USER, queryClient: createQueryClient() }),
    });
    expect(
      await screen.findByRole("button", { name: /walkthrough 706 re-run/i }, { timeout: 4_000 }),
    ).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("renders as no workspace when the list cannot be read at all", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      /\/workspaces$/.test(new URL(String(input), "http://x").pathname)
        ? respond(null, 500)
        : route(input),
    );
    vi.mocked(usePathname).mockReturnValue("/dashboard");
    renderCrumbs();
    expect(await screen.findByTestId("workspace-switcher")).toHaveTextContent("Workspace");
  });
});

describe("active-workspace store (#1584)", () => {
  function Probe() {
    return <span data-testid="probe">{useActiveWorkspaceId() ?? "none"}</span>;
  }

  it("re-renders a reader on a write in this tab and on a write from another tab", async () => {
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("none");
    act(() => writeStoredActiveWorkspaceId("ws-a"));
    expect(screen.getByTestId("probe")).toHaveTextContent("ws-a");
    // Another tab writes: this tab only hears the `storage` event.
    act(() => {
      window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-b");
      window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE_WORKSPACE_STORAGE_KEY }));
    });
    expect(screen.getByTestId("probe")).toHaveTextContent("ws-b");
    act(() => writeStoredActiveWorkspaceId(null));
    expect(screen.getByTestId("probe")).toHaveTextContent("none");
    expect(readStoredActiveWorkspaceId()).toBeNull();
  });

  it("does not announce a write that changes nothing", () => {
    const heard = vi.fn();
    window.addEventListener("metis:active-workspace", heard);
    writeStoredActiveWorkspaceId("ws-a");
    writeStoredActiveWorkspaceId("ws-a");
    window.removeEventListener("metis:active-workspace", heard);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
