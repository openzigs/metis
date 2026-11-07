/**
 * #1965 — a repository card on the product page shows its role only when one is
 * set. A repo attached without a role (through the API, say) showed an empty
 * "Role:" label.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { productsApi } from "@/lib/products-api";
import ProductDetailPage from "@/app/(authed)/products/[id]/page";
import { TEST_USER, makeWrapper } from "../test-utils";
import { PRODUCT_ID, product } from "./product-edges-fixtures";

async function renderPage() {
  const params = Promise.resolve({ id: PRODUCT_ID });
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ProductDetailPage params={params} />
      </Suspense>,
      {
        wrapper: makeWrapper({
          initialUser: { ...TEST_USER, role: "developer", permissions: ["project.read"] },
        }),
      },
    );
  });
  await screen.findByRole("heading", { name: "Integration edges" });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(productsApi, "getDocuments").mockResolvedValue([]);
  vi.spyOn(productsApi, "getAnalyses").mockResolvedValue([]);
});

describe("product page repository role (#1965)", () => {
  it("names the role of a repo that has one, and shows no empty label for one that has none", async () => {
    const base = product();
    const [withRole, withoutRole] = base.repos!;
    vi.spyOn(productsApi, "get").mockResolvedValue({
      ...base,
      repos: [withRole!, { ...withoutRole!, role: null }],
    });
    await renderPage();
    expect(screen.getByText("Role: backend-api")).toBeInTheDocument();
    expect(screen.getAllByText(/^Role:/)).toHaveLength(1);
  });
});
