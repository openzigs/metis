/**
 * #1628 — the product page hands the edge panel the edit right from the
 * signed-in user's permissions: `project.update`, the right #1620's writes
 * require. Without it the list is read-only.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { PermissionKey } from "@metis/shared";
import { productsApi } from "@/lib/products-api";
import ProductDetailPage from "@/app/(authed)/products/[id]/page";
import { TEST_USER, makeWrapper } from "../test-utils";
import { PRODUCT_ID, product } from "./product-edges-fixtures";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(productsApi, "get").mockResolvedValue(product());
  vi.spyOn(productsApi, "getDocuments").mockResolvedValue([]);
  vi.spyOn(productsApi, "getAnalyses").mockResolvedValue([]);
});

async function renderPage(permissions: PermissionKey[]) {
  const params = Promise.resolve({ id: PRODUCT_ID });
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ProductDetailPage params={params} />
      </Suspense>,
      { wrapper: makeWrapper({ initialUser: { ...TEST_USER, role: "developer", permissions } }) },
    );
  });
  await screen.findByRole("heading", { name: "Integration edges" });
}

describe("product page edge rights (#1628)", () => {
  it("offers the editor to a holder of project.update", async () => {
    await renderPage(["project.read", "project.update"]);
    expect(screen.getByRole("button", { name: /Declare edge/ })).toBeInTheDocument();
    expect(screen.queryByText(/^Restricted:/)).not.toBeInTheDocument();
  });

  it("shows the list read-only to a reader", async () => {
    await renderPage(["project.read"]);
    expect(screen.queryByRole("button", { name: /Declare edge/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete edge/ })).not.toBeInTheDocument();
    expect(screen.getByText(/^Restricted:/)).toBeInTheDocument();
  });
});
