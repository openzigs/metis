/**
 * #2339 — the workspace switcher's "Open workspace" opens the ACTIVE
 * workspace's page: on a project's pages, that project's workspace (#1584),
 * from where Governing documents and Traceability are one click away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter } from "next/navigation";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { ACTIVE_WORKSPACE_STORAGE_KEY } from "@/lib/active-workspace";
import { makeWrapper, TEST_USER } from "./test-utils";

const WORKSPACES = [
  { id: "ws-a", name: "Alpha", slug: "alpha", logoUrl: null, role: "member" },
  { id: "ws-b", name: "Beta", slug: "beta", logoUrl: null, role: "member" },
];

function respond(status: number, data: unknown) {
  return Promise.resolve(
    new Response(
      JSON.stringify(
        status < 400 ? { success: true, data } : { success: false, error: { code: "NOT_FOUND" } },
      ),
      { status },
    ),
  );
}

function route(input: RequestInfo | URL) {
  const url = new URL(String(input), "http://x");
  if (/\/workspaces$/.test(url.pathname)) return respond(200, WORKSPACES);
  if (/\/projects\/p-b$/.test(url.pathname)) {
    return respond(200, { id: "p-b", name: "Beta project", slug: "p-b", workspaceId: "ws-b" });
  }
  return respond(404, null);
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(route));
  vi.mocked(useRouter().push).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(usePathname).mockReturnValue("/");
});

async function openWorkspace() {
  const user = userEvent.setup();
  render(<WorkspaceSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
  await user.click(await screen.findByTestId("workspace-switcher"));
  await user.click(await screen.findByRole("menuitem", { name: "Open workspace" }));
}

describe("WorkspaceSwitcher — Open workspace (#2339)", () => {
  it("opens the active workspace's page", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-b");
    await openWorkspace();
    await waitFor(() => expect(useRouter().push).toHaveBeenCalledWith("/workspaces/ws-b"));
  });

  it("on a project's page, opens that project's workspace", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-a");
    vi.mocked(usePathname).mockReturnValue("/projects/p-b/analysis");
    const user = userEvent.setup();
    render(<WorkspaceSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    // The crumb follows the project once it loads (#1584).
    await waitFor(() => expect(screen.getByTestId("workspace-switcher")).toHaveTextContent("Beta"));
    await user.click(screen.getByTestId("workspace-switcher"));
    await user.click(await screen.findByRole("menuitem", { name: "Open workspace" }));
    await waitFor(() => expect(useRouter().push).toHaveBeenCalledWith("/workspaces/ws-b"));
  });

  it("is not offered when the user belongs to no workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond(200, [])),
    );
    const user = userEvent.setup();
    render(<WorkspaceSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await user.click(await screen.findByTestId("workspace-switcher"));
    expect(await screen.findByRole("menuitem", { name: "Create workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open workspace" })).toBeNull();
  });
});
