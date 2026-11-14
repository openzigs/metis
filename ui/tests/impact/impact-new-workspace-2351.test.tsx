/**
 * #2351 review — impact analysis's "Whole workspace" counts the workspace's
 * projects on the server, and refuses (and says so) a workspace bigger than one
 * run takes, as the portfolio check does, instead of keeping its first 50.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IMPACT_MAX_PROJECTS } from "@metis/shared";
import { makeWrapper } from "../test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => "/impact-analyses/new",
    useSearchParams: () => new URLSearchParams(),
  };
});

const mutate = vi.fn();
vi.mock("@/lib/impact-analysis-hooks", () => ({
  useCreateImpactAnalysis: () => ({ mutate, isPending: false, error: null }),
}));

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch };
});

const listProjects = vi.hoisted(() => vi.fn());
vi.mock("@/lib/projects-api", () => ({
  projectsApi: { list: listProjects },
  documentsApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));

import NewImpactAnalysisPage from "@/app/(authed)/impact-analyses/new/page";

function projects(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `p-${i}`, name: `Project ${i}` }));
}

function serve(workspaceTotal: number) {
  listProjects.mockImplementation(async (params?: { workspaceId?: string }) =>
    params?.workspaceId
      ? {
          items: projects(Math.min(workspaceTotal, 100)),
          total: workspaceTotal,
          limit: 100,
          offset: 0,
        }
      : { items: projects(3), total: 3, limit: 100, offset: 0 },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("metis.activeWorkspaceId", "w-1");
  apiFetch.mockImplementation(async (path: string) =>
    path === "/workspaces"
      ? [{ id: "w-1", name: "Payments", slug: "payments", logoUrl: null, role: "member" }]
      : [],
  );
});

async function pickWorkspace() {
  fireEvent.click(screen.getByTestId("impact-scope-selector"));
  const option = await screen.findByTestId("impact-scope-workspace");
  await waitFor(() => expect(option).toBeEnabled());
  fireEvent.click(option);
}

describe("impact analysis — Whole workspace (#2351)", () => {
  it("counts the workspace's projects on the server and selects them all", async () => {
    serve(4);
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await pickWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("multi-project-count")).toHaveTextContent("4 selected"),
    );
    expect(screen.getByTestId("impact-scope-selector")).toHaveTextContent(
      "Whole workspace: Payments (4 products)",
    );
    // #2424 — the workspace's own projects: not those in no workspace, which the
    // top bar's list carries too (they made it 17, not 2, in a shared stack).
    expect(listProjects).toHaveBeenCalledWith({
      workspaceId: "w-1",
      onlyWorkspace: true,
      limit: 100,
    });
  });

  it("refuses a workspace bigger than one run takes, and says so, instead of keeping the first 50", async () => {
    serve(IMPACT_MAX_PROJECTS + 7);
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    await pickWorkspace();
    await waitFor(() =>
      expect(screen.getByTestId("multi-project-count")).toHaveTextContent(
        `The workspace has more than ${IMPACT_MAX_PROJECTS} projects: choose up to ${IMPACT_MAX_PROJECTS}.`,
      ),
    );
    expect(screen.getByTestId("impact-scope-selector")).toHaveTextContent(
      `(${IMPACT_MAX_PROJECTS + 7} products)`,
    );
    expect(screen.getByTestId("run-impact-analysis")).toBeDisabled();
  });

  it("keeps Whole workspace disabled, and says why, while the workspace's projects cannot be read", async () => {
    listProjects.mockImplementation(async (params?: { workspaceId?: string }) => {
      if (params?.workspaceId) throw new Error("boom");
      return { items: projects(3), total: 3, limit: 100, offset: 0 };
    });
    render(<NewImpactAnalysisPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByTestId("impact-scope-selector"));
    expect(await screen.findByText("Could not read the workspace's projects.")).toBeInTheDocument();
    expect(screen.getByTestId("impact-scope-workspace")).toBeDisabled();
  });
});
