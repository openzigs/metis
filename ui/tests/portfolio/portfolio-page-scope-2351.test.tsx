/**
 * #2351 review — the portfolio page's scope while what it depends on is still
 * being read: "This project" is looked up before a check can start, "Whole
 * workspace" is never silently every product while the workspace's products
 * are loading or unreadable, and its every-product count ignores the search.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSearchParams } from "next/navigation";
import { makeWrapper } from "../test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  return {
    ...actual,
    useRouter: vi.fn(() => router),
    usePathname: () => "/portfolio",
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

vi.mock("@/lib/portfolio-api", () => ({
  portfolioApi: { get: vi.fn(), list: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));
const productsApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/products-api", () => ({ productsApi }));
const projectsApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/projects-api", () => ({ projectsApi }));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch };
});

import PortfolioPage from "@/app/(authed)/portfolio/page";

const BILLING = { id: "p-billing", name: "Billing" };
const CRM = { id: "p-crm", name: "CRM" };

function workspaces(list: unknown[]) {
  apiFetch.mockImplementation(async (path: string) => (path === "/workspaces" ? list : []));
}
const PAYMENTS = { id: "w-1", name: "Payments", slug: "payments", logoUrl: null, role: "member" };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);
  productsApi.list.mockResolvedValue({ items: [BILLING, CRM], total: 2 });
  workspaces([]);
});

describe("portfolio page — scope while it loads (#2351)", () => {
  it("from a change request, says it is looking up the project's product and holds the submit until it is known", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ analysisId: "an-1", projectId: "p1", title: "Reset" }) as never,
    );
    let resolveProject: (p: unknown) => void = () => {};
    projectsApi.get.mockReturnValue(new Promise((r) => (resolveProject = r)));
    productsApi.get.mockResolvedValue(BILLING);
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("portfolio-scope-hint")).toHaveTextContent(
      "Looking up this project's product…",
    );
    expect(screen.getByRole("button", { name: "Check coverage" })).toBeDisabled();
    fireEvent.click(screen.getByTestId("portfolio-scope-selector"));
    expect(
      screen.getByText("Looking up this project's product…", { selector: "p.px-2" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Open this from a change request/)).toBeNull();

    resolveProject({ id: "p1", name: "Spike", productId: "p-billing" });
    await waitFor(() =>
      expect(screen.getByTestId("portfolio-scope-selector")).toHaveTextContent(
        "This project: Billing",
      ),
    );
    expect(screen.getByRole("button", { name: "Check coverage" })).toBeEnabled();
  });

  it("says the project could not be read, instead of telling the analyst to open it from a change request", async () => {
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams({ analysisId: "an-1", projectId: "p1" }) as never,
    );
    projectsApi.get.mockRejectedValue(new Error("403"));
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByTestId("portfolio-scope-selector"));
    expect(
      await screen.findByText("Could not read this project, so its product is not offered."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Open this from a change request/)).toBeNull();
  });

  it("keeps Whole workspace disabled, and says why, while the workspace's products load", async () => {
    workspaces([PAYMENTS]);
    localStorage.setItem("metis.activeWorkspaceId", "w-1");
    productsApi.list.mockImplementation(async (params: { workspaceId?: string }) =>
      params.workspaceId ? new Promise(() => {}) : { items: [BILLING, CRM], total: 2 },
    );
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByTestId("portfolio-scope-selector"));
    expect(await screen.findByText("Loading the workspace's products…")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-scope-workspace")).toBeDisabled();
    expect(screen.getByTestId("portfolio-scope-workspace")).not.toHaveTextContent(
      "every product you can read",
    );
  });

  it("keeps Whole workspace disabled, and says why, when the workspace's products cannot be read", async () => {
    workspaces([PAYMENTS]);
    localStorage.setItem("metis.activeWorkspaceId", "w-1");
    productsApi.list.mockImplementation(async (params: { workspaceId?: string }) => {
      if (params.workspaceId) throw new Error("boom");
      return { items: [BILLING, CRM], total: 2 };
    });
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByTestId("portfolio-scope-selector"));
    expect(await screen.findByText("Could not read the workspace's products.")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-scope-workspace")).toBeDisabled();
  });

  it("with no workspace open, counts every product the analyst can read, not the search's matches", async () => {
    productsApi.list.mockImplementation(async (params: { search?: string }) =>
      params.search ? { items: [BILLING], total: 1 } : { items: [BILLING, CRM], total: 7 },
    );
    render(<PortfolioPage />, { wrapper: makeWrapper() });
    fireEvent.change(await screen.findByLabelText("Find products"), { target: { value: "bil" } });
    await waitFor(() =>
      expect(productsApi.list).toHaveBeenCalledWith(expect.objectContaining({ search: "bil" })),
    );
    fireEvent.click(screen.getByTestId("portfolio-scope-selector"));
    expect(screen.getByTestId("portfolio-scope-workspace")).toHaveTextContent(
      "Whole workspace: every product you can read (7 products)",
    );
    // One search: the host picker has none of its own.
    expect(screen.queryByLabelText("Find a product to build it")).toBeNull();
  });
});
