/**
 * #731 — the project Settings "Workspace" card adds an unassigned project to a
 * workspace the user administers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { makeWrapper } from "./test-utils";

const apiFetch = vi.hoisted(() => vi.fn());
const refreshAccessToken = vi.hoisted(() => vi.fn());
const assignWorkspace = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch, refreshAccessToken };
});
vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return { ...actual, projectsApi: { ...actual.projectsApi, assignWorkspace } };
});

import { ApiError } from "@/lib/api-client";
import { WorkspaceAssignCard } from "@/components/projects/workspace-assign-card";

const WORKSPACES = [
  { id: "ws-own", name: "Owned", role: "owner" },
  { id: "ws-adm", name: "Administered", role: "admin" },
  { id: "ws-mem", name: "Member only", role: "member" },
];

function renderCard(node: React.ReactElement, queryClient?: QueryClient) {
  const Wrapper = makeWrapper({ withAuth: false, queryClient });
  return render(<Wrapper>{node}</Wrapper>);
}

beforeEach(() => {
  apiFetch.mockReset();
  refreshAccessToken.mockReset();
  assignWorkspace.mockReset();
  apiFetch.mockResolvedValue(WORKSPACES);
  refreshAccessToken.mockResolvedValue(true);
});

describe("WorkspaceAssignCard", () => {
  it("offers only workspaces the user owns or administers", async () => {
    renderCard(<WorkspaceAssignCard projectId="p1" workspaceId={null} />);
    const select = (await screen.findByTestId("workspace-assign-select")) as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(["", "ws-own", "ws-adm"]);
    expect(apiFetch).toHaveBeenCalledWith("/workspaces");
    expect(screen.getByTestId("workspace-assign-button")).toBeDisabled();
  });

  it("adds the project, re-mints the token and refetches the project", async () => {
    assignWorkspace.mockResolvedValue({ id: "p1", workspaceId: "ws-adm" });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderCard(<WorkspaceAssignCard projectId="p1" workspaceId={null} />, queryClient);
    fireEvent.change(await screen.findByTestId("workspace-assign-select"), {
      target: { value: "ws-adm" },
    });
    fireEvent.click(screen.getByTestId("workspace-assign-button"));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["projects"] }));
    expect(assignWorkspace).toHaveBeenCalledWith("p1", "ws-adm");
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(refreshAccessToken.mock.invocationCallOrder[0]).toBeLessThan(
      invalidate.mock.invocationCallOrder[0],
    );
  });

  it("shows the server's refusal", async () => {
    assignWorkspace.mockRejectedValue(
      new ApiError(403, "Workspace admin role required", "FORBIDDEN"),
    );
    renderCard(<WorkspaceAssignCard projectId="p1" workspaceId={null} />);
    fireEvent.change(await screen.findByTestId("workspace-assign-select"), {
      target: { value: "ws-own" },
    });
    fireEvent.click(screen.getByTestId("workspace-assign-button"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace admin role required");
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("explains what to do when the user administers no workspace", async () => {
    apiFetch.mockResolvedValue([{ id: "ws-mem", name: "Member only", role: "member" }]);
    renderCard(<WorkspaceAssignCard projectId="p1" workspaceId={null} />);
    expect(await screen.findByTestId("workspace-assign-none")).toHaveTextContent(
      /owner or admin role/,
    );
    expect(screen.queryByTestId("workspace-assign-select")).not.toBeInTheDocument();
  });

  it("names the current workspace and offers no move for an assigned project", async () => {
    renderCard(<WorkspaceAssignCard projectId="p1" workspaceId="ws-mem" />);
    await waitFor(() =>
      expect(screen.getByTestId("workspace-assign-current")).toHaveTextContent("Member only"),
    );
    expect(screen.queryByTestId("workspace-assign-select")).not.toBeInTheDocument();
  });
});
