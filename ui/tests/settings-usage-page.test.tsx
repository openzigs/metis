/**
 * #31 — Settings → Usage & cost is the one home for usage, with scope as a tab.
 * The three panels have their own suites; here they are stubs naming their subject.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { makeWrapper, TEST_USER } from "./test-utils";
import SettingsUsagePage from "@/app/(authed)/settings/usage/page";

vi.mock("@/components/usage/project-usage-panel", () => ({
  ProjectUsagePanel: ({ projectId }: { projectId: string }) => (
    <div data-testid="project-panel">{projectId}</div>
  ),
}));
vi.mock("@/components/usage/platform-usage-panel", () => ({
  PlatformUsagePanel: () => <div data-testid="platform-panel" />,
}));
vi.mock("@/components/finops/workspace-finops-panel", () => ({
  WorkspaceFinopsPanel: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="workspace-panel">{workspaceId}</div>
  ),
}));

const listProjects = vi.fn();
vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: (...a: unknown[]) => listProjects(...a) },
}));

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: (...a: unknown[]) => apiFetch(...a) };
});

const useSearchParamsMock = vi.mocked(useSearchParams);
const replace = vi.mocked(useRouter)().replace as ReturnType<typeof vi.fn>;

function renderAt(query: string, role: "admin" | "reader" = "reader") {
  useSearchParamsMock.mockReturnValue(
    new URLSearchParams(query) as ReturnType<typeof useSearchParams>,
  );
  return render(<SettingsUsagePage />, {
    wrapper: makeWrapper({ initialUser: { ...TEST_USER, role } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  listProjects.mockResolvedValue({
    items: [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ],
    total: 2,
    limit: 100,
    offset: 0,
  });
  apiFetch.mockResolvedValue([
    { id: "ws-1", name: "One" },
    { id: "ws-2", name: "Two" },
  ]);
});

describe("<SettingsUsagePage /> (#31)", () => {
  it("opens on the Project scope and asks for a project", async () => {
    renderAt("");
    expect(screen.getByRole("heading", { level: 1, name: "Usage & cost" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("usage-project-empty")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument());
    expect(listProjects).toHaveBeenCalledWith({ limit: 100 });
  });

  it("shows the project named in the query", () => {
    renderAt("scope=project&projectId=p2");
    expect(screen.getByTestId("project-panel")).toHaveTextContent("p2");
  });

  it("keeps a project past the first page selectable", async () => {
    renderAt("projectId=p-far");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Current project" })).toHaveValue("p-far"),
    );
  });

  it("puts the chosen project in the URL, keeping the scope", async () => {
    renderAt("scope=project");
    const picker = screen.getByTestId("usage-project-picker");
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.change(picker, { target: { value: "p1" } });
    expect(replace).toHaveBeenCalledWith("/settings/usage?scope=project&projectId=p1");
  });

  it("clears the project from the URL when none is chosen", async () => {
    renderAt("scope=project&projectId=p1");
    const picker = screen.getByTestId("usage-project-picker");
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.change(picker, { target: { value: "" } });
    expect(replace).toHaveBeenCalledWith("/settings/usage?scope=project");
  });

  it("switches scope through the URL", async () => {
    renderAt("");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Workspace" }));
    expect(replace).toHaveBeenCalledWith("/settings/usage?scope=workspace");
  });

  it("scopes to the workspace named in the query", async () => {
    renderAt("scope=workspace&workspaceId=ws-2");
    await waitFor(() => expect(screen.getByTestId("workspace-panel")).toHaveTextContent("ws-2"));
    expect(screen.getByTestId("usage-workspace-picker")).toHaveValue("ws-2");
  });

  // A stale bookmark (e.g. an old /workspaces/<id>/finops link) must not make
  // the panel show one workspace while the picker shows another.
  it("ignores a workspace in the query that is not the caller's", async () => {
    window.localStorage.setItem("metis.activeWorkspaceId", "ws-2");
    renderAt("scope=workspace&workspaceId=ws-gone");
    await waitFor(() => expect(screen.getByTestId("workspace-panel")).toHaveTextContent("ws-2"));
    expect(screen.getByTestId("usage-workspace-picker")).toHaveValue("ws-2");
  });

  // PR #389 panel — the server lets a system admin read any workspace's FinOps
  // (require-workspace-role.ts), and /workspaces/:id/finops used to render any
  // id. An admin's bookmark to a workspace they are not a member of must still
  // open THAT workspace, with the picker agreeing.
  it("keeps a non-member workspace from the query for a system admin", async () => {
    window.localStorage.setItem("metis.activeWorkspaceId", "ws-2");
    renderAt("scope=workspace&workspaceId=ws-other", "admin");
    await waitFor(() =>
      expect(screen.getByTestId("workspace-panel")).toHaveTextContent("ws-other"),
    );
    expect(screen.getByTestId("usage-workspace-picker")).toHaveValue("ws-other");
  });

  it("defaults the Workspace scope to the header's active workspace", async () => {
    window.localStorage.setItem("metis.activeWorkspaceId", "ws-2");
    renderAt("scope=workspace");
    await waitFor(() => expect(screen.getByTestId("workspace-panel")).toHaveTextContent("ws-2"));
    expect(apiFetch).toHaveBeenCalledWith("/workspaces");
  });

  it("falls back to the first workspace when the stored one is not the caller's", async () => {
    window.localStorage.setItem("metis.activeWorkspaceId", "ws-gone");
    renderAt("scope=workspace");
    await waitFor(() => expect(screen.getByTestId("workspace-panel")).toHaveTextContent("ws-1"));
  });

  it("changes workspace through the URL", async () => {
    renderAt("scope=workspace");
    const picker = await screen.findByTestId("usage-workspace-picker");
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.change(picker, { target: { value: "ws-2" } });
    expect(replace).toHaveBeenCalledWith("/settings/usage?scope=workspace&workspaceId=ws-2");
  });

  it("says so when the caller belongs to no workspace", async () => {
    apiFetch.mockResolvedValue([]);
    renderAt("scope=workspace");
    await waitFor(() =>
      expect(screen.getByTestId("usage-workspace-empty")).toHaveTextContent(/not a member/),
    );
    expect(screen.getByRole("option", { name: "No workspaces" })).toBeInTheDocument();
  });

  it("offers All projects to admins", () => {
    renderAt("scope=platform", "admin");
    expect(screen.getByRole("tab", { name: "All projects" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("platform-panel")).toBeInTheDocument();
  });

  it("never offers All projects to a non-admin, even when the URL asks for it", () => {
    renderAt("scope=platform", "reader");
    expect(screen.queryByRole("tab", { name: "All projects" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("platform-panel")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
  });
});
