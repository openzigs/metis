/**
 * #2197 — follow-ups from #2195 on the active workspace.
 *
 *   • /projects reads the VALIDATED active workspace, not the raw stored id: a
 *     second user on a shared browser inherited a workspace they are not in,
 *     and the list it filtered held only the unassigned projects.
 *   • It re-lists when the top bar switches workspace (it never subscribed).
 *   • Opening a project in another workspace switches the stored workspace,
 *     on purpose, and it stays switched after leaving the project's pages.
 *   • Both top-bar switchers read the project id from one `projectIdFromPath`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { usePathname } from "next/navigation";
import ProjectsPage from "@/app/(authed)/projects/page";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { projectIdFromPath } from "@/lib/active-project";
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  resolveActiveWorkspaceId,
  useValidatedActiveWorkspaceId,
  writeStoredActiveWorkspaceId,
} from "@/lib/active-workspace";
import { makeWrapper, TEST_USER } from "./test-utils";

const WORKSPACES = [
  { id: "ws-a", name: "Alpha workspace", slug: "a", logoUrl: null, role: "member" },
  { id: "ws-b", name: "Beta workspace", slug: "b", logoUrl: null, role: "member" },
];
const project = (id: string, name: string, workspaceId: string | null) => ({
  id,
  name,
  slug: id,
  status: "active",
  description: null,
  workspaceId,
  createdById: "u-1",
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
});
const PROJECTS = [
  project("p-a", "Alpha project", "ws-a"),
  project("p-b", "Beta project", "ws-b"),
  project("p-open", "Unassigned project", null),
];

function respond(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Error",
    text: () =>
      Promise.resolve(
        JSON.stringify(
          status < 400 ? { success: true, data } : { success: false, error: { code: "E" } },
        ),
      ),
  });
}

let workspacesStatus = 200;
/** The fake API: workspaces, one project by id, and the server-scoped list. */
function route(input: RequestInfo | URL) {
  const url = new URL(String(input), "http://x");
  if (/\/workspaces$/.test(url.pathname)) {
    return workspacesStatus === 200 ? respond(WORKSPACES) : respond(null, workspacesStatus);
  }
  const one = url.pathname.match(/\/projects\/([^/]+)$/);
  if (one) {
    const p = PROJECTS.find((x) => x.id === one[1]);
    return p ? respond(p) : respond(null, 404);
  }
  if (/\/projects$/.test(url.pathname)) {
    // The server's member rule (#1584): a workspace the caller is not in
    // leaves only the projects in no workspace.
    const ws = url.searchParams.get("workspaceId");
    const mine = WORKSPACES.some((w) => w.id === ws);
    const items = PROJECTS.filter(
      (p) => p.workspaceId === null || (!ws ? true : mine && p.workspaceId === ws),
    );
    return respond({ items, total: items.length, limit: 25, offset: 0 });
  }
  return respond(null, 404);
}

let fetchMock: ReturnType<typeof vi.fn>;
/** The `workspaceId` of every project-list request, in order (`null` when unscoped). */
const listScopes = () =>
  fetchMock.mock.calls
    .map(([u]) => new URL(String(u), "http://x"))
    .filter((u) => /\/projects$/.test(u.pathname))
    .map((u) => u.searchParams.get("workspaceId"));

beforeEach(() => {
  window.localStorage.clear();
  workspacesStatus = 200;
  fetchMock = vi.fn(route);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(usePathname).mockReturnValue("/");
});

const renderProjects = () =>
  render(<ProjectsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });

describe("/projects reads the validated active workspace (#2197)", () => {
  it("a stored workspace the caller is not in lists their first workspace's projects", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-previous-user");
    renderProjects();
    expect(await screen.findByRole("heading", { name: "Alpha project" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unassigned project" })).toBeInTheDocument();
    // The raw id was never sent: the list waited for the workspaces.
    expect(listScopes()).toEqual(["ws-a"]);
  });

  it("keeps a stored workspace the caller is in", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-b");
    renderProjects();
    expect(await screen.findByRole("heading", { name: "Beta project" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alpha project" })).not.toBeInTheDocument();
    expect(listScopes()).toEqual(["ws-b"]);
  });

  it("re-lists when the top bar switches workspace", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-a");
    renderProjects();
    await screen.findByRole("heading", { name: "Alpha project" });
    act(() => writeStoredActiveWorkspaceId("ws-b"));
    expect(await screen.findByRole("heading", { name: "Beta project" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alpha project" })).not.toBeInTheDocument();
    expect(listScopes()).toEqual(["ws-a", "ws-b"]);
  });

  it("lists unfiltered when the workspaces cannot be read (the server still scopes)", async () => {
    workspacesStatus = 500;
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-previous-user");
    renderProjects();
    expect(await screen.findByRole("heading", { name: "Beta project" })).toBeInTheDocument();
    expect(listScopes()).toEqual([null]);
  });
});

describe("useValidatedActiveWorkspaceId (#2197)", () => {
  it("is loading, with no id, until the workspaces are read", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-b");
    const { result } = renderHook(() => useValidatedActiveWorkspaceId(), {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(result.current).toMatchObject({ workspaceId: null, status: "loading" });
    await waitFor(() =>
      expect(result.current).toMatchObject({ workspaceId: "ws-b", status: "ready" }),
    );
  });
});

describe("resolveActiveWorkspaceId (#2197)", () => {
  it("keeps a member's stored id, else the first workspace, else none", () => {
    expect(resolveActiveWorkspaceId("ws-b", WORKSPACES)).toBe("ws-b");
    expect(resolveActiveWorkspaceId("ws-x", WORKSPACES)).toBe("ws-a");
    expect(resolveActiveWorkspaceId(null, WORKSPACES)).toBe("ws-a");
    expect(resolveActiveWorkspaceId("ws-b", [])).toBeNull();
  });
});

describe("opening a project in another workspace switches the active one (#2197)", () => {
  it("stays switched after leaving the project's pages", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-a");
    vi.mocked(usePathname).mockReturnValue("/projects/p-b/reviews");
    const { rerender } = render(<Breadcrumbs />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(await screen.findByRole("button", { name: /beta workspace/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY)).toBe("ws-b"),
    );
    vi.mocked(usePathname).mockReturnValue("/dashboard");
    rerender(<Breadcrumbs />);
    expect(await screen.findByRole("button", { name: /beta workspace/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /alpha workspace/i })).not.toBeInTheDocument();
  });
});

describe("projectIdFromPath (#2197: one copy for both switchers)", () => {
  it("reads the id from a project path only", () => {
    expect(projectIdFromPath("/projects/p-1")).toBe("p-1");
    expect(projectIdFromPath("/projects/p-1/reviews/r-2")).toBe("p-1");
    expect(projectIdFromPath("/projects")).toBeNull();
    expect(projectIdFromPath("/projects/")).toBeNull();
    expect(projectIdFromPath("/dashboard/projects/p-1")).toBeNull();
    expect(projectIdFromPath(null)).toBeNull();
  });
});
