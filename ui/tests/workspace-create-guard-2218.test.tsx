/**
 * #2218 — review follow-ups on the #2208 create guard:
 *
 * - a failed REFETCH of the workspaces disabled Create although the list was
 *   cached: TanStack keeps `data` with `status: "error"`, and the hook checked
 *   `isError` first. A list once read still validates the active workspace;
 * - Try again gave no sign it was running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, useQuery } from "@tanstack/react-query";
import {
  ACTIVE_WORKSPACE_STORAGE_KEY,
  useValidatedActiveWorkspaceId,
  workspaceListQuery,
} from "@/lib/active-workspace";
import { WorkspaceStatusNotice } from "@/components/projects/workspace-status-notice";
import { makeWrapper, TEST_USER } from "./test-utils";

const WORKSPACES = [{ id: "ws-a", name: "Alpha", slug: "a", logoUrl: null, role: "member" }];

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

beforeEach(() => {
  workspacesStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      /\/workspaces$/.test(new URL(String(input), "http://x").pathname)
        ? respond(workspacesStatus === 200 ? WORKSPACES : null, workspacesStatus)
        : respond(null, 404),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("useValidatedActiveWorkspaceId keeps a cached list through a failed refetch (#2218)", () => {
  it("stays ready, with the workspace, when a re-read fails after a good one", async () => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, "ws-a");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The list query read beside the hook, so both come from the same render.
    const { result } = renderHook(
      () => ({ workspace: useValidatedActiveWorkspaceId(), list: useQuery(workspaceListQuery) }),
      { wrapper: makeWrapper({ initialUser: TEST_USER, queryClient }) },
    );
    await waitFor(() => expect(result.current.workspace.status).toBe("ready"));

    workspacesStatus = 500;
    await act(async () => {
      await result.current.workspace.retry();
    });
    await waitFor(() => expect(result.current.list.isError).toBe(true));
    expect(result.current.list.data).toEqual(WORKSPACES);
    expect(result.current.workspace.status).toBe("ready");
    expect(result.current.workspace.workspaceId).toBe("ws-a");
  });

  it("is an error while no list has ever been read", async () => {
    workspacesStatus = 500;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useValidatedActiveWorkspaceId(), {
      wrapper: makeWrapper({ initialUser: TEST_USER, queryClient }),
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.workspaceId).toBeNull();
  });
});

describe("Try again says it is running (#2218)", () => {
  it("reads Trying again…, disabled, until the re-read settles", async () => {
    let settle: () => void = () => undefined;
    const onRetry = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
    const user = userEvent.setup();
    render(<WorkspaceStatusNotice status="error" onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole("button", { name: "Trying again…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");

    await act(async () => settle());
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });
});
