/**
 * #2353 — the Projects hub's one Portfolio tab: the coverage check and the
 * products it checks across, on one page. Nothing either former page did is
 * lost: the check still starts from the page, and the products are listed,
 * opened and created from it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter, useSearchParams } from "next/navigation";
import type { QueryClient } from "@tanstack/react-query";
import { MAX_PAGE_SIZE } from "@metis/shared";
import { createQueryClient } from "@/lib/query-client";
import { makeWrapper } from "../test-utils";
import { axeViolations } from "./axe";

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
vi.mock("@/lib/products-api", () => ({
  productsApi: { list: vi.fn(), get: vi.fn(), create: vi.fn() },
}));

import { productsApi } from "@/lib/products-api";
import { ApiError } from "@/lib/api-client";
import PortfolioPage from "@/app/(authed)/portfolio/page";

const products = vi.mocked(productsApi);

const BILLING = {
  id: "p-billing",
  name: "Billing",
  description: "Invoices and payments",
  createdAt: "2026-11-01T10:00:00.000Z",
};

function openAt(query: Record<string, string> = {}, queryClient?: QueryClient) {
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(query) as never);
  return render(<PortfolioPage />, { wrapper: makeWrapper({ queryClient }) });
}

const router = () => vi.mocked(useRouter)();

beforeEach(() => {
  vi.clearAllMocks();
  products.list.mockResolvedValue({ items: [BILLING], total: 1 } as never);
});

describe("the Portfolio tab (#2353)", () => {
  it("is one page titled Portfolio, opening on the coverage check", async () => {
    openAt();
    expect(screen.getByRole("heading", { level: 1, name: "Portfolio" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Coverage" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Products" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByLabelText("Requirement statement")).toBeInTheDocument();
    expect(await screen.findByTestId("portfolio-recent-empty")).toBeInTheDocument();
  });

  it("opens on Products from the old /products link (?tab=products)", async () => {
    openAt({ tab: "products" });
    expect(screen.getByRole("tab", { name: "Products" })).toHaveAttribute("aria-selected", "true");
    const card = await screen.findByRole("link", { name: /Billing/ });
    expect(card).toHaveAttribute("href", "/products/p-billing");
    expect(within(card).getByText("Invoices and payments")).toBeInTheDocument();
    expect(screen.queryByLabelText("Requirement statement")).not.toBeInTheDocument();
  });

  it("ignores a tab it does not have", () => {
    openAt({ tab: "repositories" });
    expect(screen.getByRole("tab", { name: "Coverage" })).toHaveAttribute("aria-selected", "true");
  });

  it("moves between the two sections", async () => {
    const user = userEvent.setup();
    openAt();
    await user.click(screen.getByRole("tab", { name: "Products" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Products" })).toBeVisible();
    expect(screen.getByTestId("new-product-button")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Coverage" }));
    expect(screen.getByLabelText("Requirement statement")).toBeInTheDocument();
  });

  it("keeps the section in the URL, so Back from a product and a reload reopen it", async () => {
    const user = userEvent.setup();
    openAt();
    await user.click(screen.getByRole("tab", { name: "Products" }));
    expect(router().replace).toHaveBeenLastCalledWith("/portfolio?tab=products", {
      scroll: false,
    });
    await user.click(screen.getByRole("tab", { name: "Coverage" }));
    expect(router().replace).toHaveBeenLastCalledWith("/portfolio", { scroll: false });
    expect(router().push).not.toHaveBeenCalled();
  });

  it("keeps the rest of the query when it changes section", async () => {
    const user = userEvent.setup();
    openAt({ statement: "Export invoices" });
    await user.click(screen.getByRole("tab", { name: "Products" }));
    expect(router().replace).toHaveBeenLastCalledWith(
      "/portfolio?statement=Export+invoices&tab=products",
      { scroll: false },
    );
  });

  it("re-reads the Coverage product picker after a product is created (app QueryClient)", async () => {
    const user = userEvent.setup();
    products.create.mockResolvedValue({ ...BILLING, id: "p-new", name: "Orders" } as never);
    openAt({}, createQueryClient());
    const pickerReads = () =>
      products.list.mock.calls.filter(([arg]) => arg?.pageSize === MAX_PAGE_SIZE).length;
    await waitFor(() => expect(pickerReads()).toBe(1));

    await user.click(screen.getByRole("tab", { name: "Products" }));
    await user.click(await screen.findByTestId("new-product-button"));
    await user.type(screen.getByLabelText("Name", { exact: true }), "Orders");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByText("Create product")).not.toBeInTheDocument());

    await user.click(screen.getByRole("tab", { name: "Coverage" }));
    // Within the 30s staleTime: only the invalidation makes it read again.
    await waitFor(() => expect(pickerReads()).toBe(2));
  });

  it("passes axe on each section", async () => {
    const coverage = openAt();
    await screen.findByTestId("portfolio-recent-empty");
    expect(await axeViolations(coverage.container)).toEqual([]);
    coverage.unmount();

    const list = openAt({ tab: "products" });
    await screen.findByRole("link", { name: /Billing/ });
    expect(await axeViolations(list.container)).toEqual([]);
  });
});

describe("the Products section (#2353, formerly /products)", () => {
  it("says there are no products yet", async () => {
    products.list.mockResolvedValue({ items: [], total: 0 } as never);
    openAt({ tab: "products" });
    expect(await screen.findByTestId("products-empty")).toHaveTextContent("No products yet.");
  });

  it("names a product with no description as such", async () => {
    products.list.mockResolvedValue({
      items: [{ ...BILLING, description: null }],
      total: 1,
    } as never);
    openAt({ tab: "products" });
    expect(await screen.findByText("No description")).toBeInTheDocument();
  });

  it("creates a product, deriving its short name from the name, and re-reads the list", async () => {
    const user = userEvent.setup();
    products.create.mockResolvedValue({ ...BILLING, id: "p-new" } as never);
    openAt({ tab: "products" });
    await screen.findByRole("link", { name: /Billing/ });

    await user.click(screen.getByTestId("new-product-button"));
    await user.type(screen.getByLabelText("Name", { exact: true }), "Order Hub!  2");
    expect(screen.getByLabelText("Short name")).toHaveValue("order-hub-2");
    await user.type(screen.getByLabelText("Description"), "Orders");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(products.create).toHaveBeenCalledWith({
        name: "Order Hub!  2",
        slug: "order-hub-2",
        description: "Orders",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Create product")).not.toBeInTheDocument());
    await waitFor(() => expect(products.list).toHaveBeenCalledTimes(2));
  });

  it("keeps a short name typed by hand, and sends no empty description", async () => {
    const user = userEvent.setup();
    products.create.mockResolvedValue({ ...BILLING, id: "p-new" } as never);
    openAt({ tab: "products" });

    await user.click(screen.getByTestId("new-product-button"));
    await user.type(screen.getByLabelText("Short name"), "crm");
    await user.type(screen.getByLabelText("Name", { exact: true }), "Customer");
    expect(screen.getByLabelText("Short name")).toHaveValue("crm");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(products.create).toHaveBeenCalledWith({
        name: "Customer",
        slug: "crm",
        description: undefined,
      }),
    );
  });

  it("shows the server's reason when a product cannot be created", async () => {
    const user = userEvent.setup();
    products.create.mockRejectedValue(new ApiError(409, "That short name is taken"));
    openAt({ tab: "products" });

    await user.click(screen.getByTestId("new-product-button"));
    await user.type(screen.getByLabelText("Name", { exact: true }), "Billing");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("That short name is taken")).toBeInTheDocument();
    expect(screen.getByText("Create product")).toBeInTheDocument();
  });

  it("falls back to a plain message for an unexpected failure", async () => {
    const user = userEvent.setup();
    products.create.mockRejectedValue(new Error("socket hang up"));
    openAt({ tab: "products" });

    await user.click(screen.getByTestId("new-product-button"));
    await user.type(screen.getByLabelText("Name", { exact: true }), "Billing");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("Failed to create product")).toBeInTheDocument();
  });
});
