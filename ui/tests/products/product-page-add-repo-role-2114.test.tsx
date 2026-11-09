/**
 * #2114 — the product page's Add repository dialog offered roles the API
 * rejects (shared-library, infrastructure, worker, other answered 400). Every
 * Role it offers now passes `addProductRepoSchema`, the validator the server's
 * POST /products/:id/repos parses with, and the chosen one is what is sent.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { addProductRepoSchema } from "@metis/shared";
import { productsApi, type RepoConnectionOption } from "@/lib/products-api";
import ProductDetailPage from "@/app/(authed)/products/[id]/page";
import { TEST_USER, makeWrapper } from "../test-utils";
import { PRODUCT_ID, product } from "./product-edges-fixtures";

const CONNECTION: RepoConnectionOption = {
  id: "rc-new-1111",
  label: "GitHub",
  provider: "github",
  ownerOrOrg: "acme",
  repoName: "billing",
  defaultBranch: "main",
  status: "active",
  projectId: "proj-1",
};

async function openAddRepoDialog() {
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
  fireEvent.click(await screen.findByTestId("add-repo-button"));
  return screen.findByLabelText("Role");
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(productsApi, "get").mockResolvedValue(product());
  vi.spyOn(productsApi, "getDocuments").mockResolvedValue([]);
  vi.spyOn(productsApi, "getAnalyses").mockResolvedValue([]);
  vi.spyOn(productsApi, "listRepoConnections").mockResolvedValue([CONNECTION]);
});

describe("product page Add repository role (#2114)", () => {
  it("offers only roles the API accepts", async () => {
    const select = await openAddRepoDialog();
    const roles = Array.from((select as HTMLSelectElement).options).map((o) => o.value);
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      const parsed = addProductRepoSchema.safeParse({ repoConnectionId: CONNECTION.id, role });
      expect(parsed.success, `role "${role}" is rejected by the API`).toBe(true);
    }
  });

  it("sends the chosen role", async () => {
    const addRepo = vi.spyOn(productsApi, "addRepo").mockResolvedValue({} as never);
    const select = await openAddRepoDialog();
    fireEvent.click(await screen.findByRole("button", { name: /acme\/billing/ }));
    fireEvent.change(select, { target: { value: "shared-lib" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Repository" }));
    await waitFor(() =>
      expect(addRepo).toHaveBeenCalledWith(PRODUCT_ID, {
        repoConnectionId: CONNECTION.id,
        role: "shared-lib",
      }),
    );
  });
});
