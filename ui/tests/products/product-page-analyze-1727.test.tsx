/**
 * #1727 — the product page after "Generate Documentation", and its Add Repo
 * picker:
 *  - the edges panel shows what the analysis detected without a reload;
 *  - a repo the analysis could not crawl (no clone yet) is named;
 *  - the picker leaves out repos already in the product and names each row's
 *    project and workspace.
 */
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { productsApi, type AnalyzeResult, type RepoConnectionOption } from "@/lib/products-api";
import ProductDetailPage from "@/app/(authed)/products/[id]/page";
import { TEST_USER, makeWrapper } from "../test-utils";
import { PRODUCT_ID, REPO_A, detectedEdge, product } from "./product-edges-fixtures";

const analyzed: AnalyzeResult = {
  analysisId: "an-1",
  status: "completed",
  documentsGenerated: 0,
  edgesDetected: 1,
  reposWithoutClone: [],
};

function option(over: Partial<RepoConnectionOption>): RepoConnectionOption {
  return {
    id: "rc-x",
    label: "primary",
    provider: "github",
    ownerOrOrg: "miniflux",
    repoName: "v2",
    defaultBranch: "main",
    status: "ready",
    projectId: "proj-1",
    projectName: null,
    workspaceName: null,
    ...over,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(productsApi, "getDocuments").mockResolvedValue([]);
  vi.spyOn(productsApi, "getAnalyses").mockResolvedValue([]);
});

async function renderPage() {
  const params = Promise.resolve({ id: PRODUCT_ID });
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ProductDetailPage params={params} />
      </Suspense>,
      {
        wrapper: makeWrapper({
          initialUser: {
            ...TEST_USER,
            role: "developer",
            permissions: ["project.read", "project.update"],
          },
        }),
      },
    );
  });
  await screen.findByRole("heading", { name: "Integration edges" });
}

describe("Generate Documentation (#1727)", () => {
  it("refreshes the edges panel with the edges the analysis detected", async () => {
    // The server holds no edge until the analysis has run.
    let ran = false;
    const get = vi
      .spyOn(productsApi, "get")
      .mockImplementation(async () => product({ edges: ran ? [detectedEdge] : [], resources: [] }));
    vi.spyOn(productsApi, "analyze").mockImplementation(async () => {
      ran = true;
      return analyzed;
    });
    await renderPage();
    expect(await screen.findByText("No integration edges yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/also detects the integration edges between these repositories/),
    ).toBeInTheDocument();

    const readsBefore = get.mock.calls.length;
    await userEvent.click(screen.getByTestId("generate-docs-button"));

    await screen.findByText("Documentation generated successfully.");
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.queryByText("No integration edges yet.")).not.toBeInTheDocument();
    expect(get.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(screen.queryByTestId("repos-without-clone")).not.toBeInTheDocument();
  });

  it("names the repos it could not analyse for want of a clone", async () => {
    vi.spyOn(productsApi, "get").mockResolvedValue(product());
    vi.spyOn(productsApi, "analyze").mockResolvedValue({
      ...analyzed,
      reposWithoutClone: [
        { repoConnectionId: "rc-b", name: "openzigs/metis-fixture-billing" },
        { repoConnectionId: "rc-n", name: "openzigs/metis-fixture-notify" },
      ],
    });
    await renderPage();
    await userEvent.click(screen.getByTestId("generate-docs-button"));
    const notice = await screen.findByTestId("repos-without-clone");
    expect(notice).toHaveTextContent(
      "Not analysed, with no clone yet: openzigs/metis-fixture-billing, openzigs/metis-fixture-notify.",
    );
    expect(notice).toHaveTextContent(/Update them on the project's Connections page/);
    expect(notice).not.toHaveTextContent(/sync/i);
  });
});

describe("Add Repo picker (#1727)", () => {
  async function openPicker(options: RepoConnectionOption[]) {
    vi.spyOn(productsApi, "get").mockResolvedValue(product());
    vi.spyOn(productsApi, "listRepoConnections").mockResolvedValue(options);
    await renderPage();
    await userEvent.click(screen.getByTestId("add-repo-button"));
    return screen.findByRole("dialog");
  }

  it("leaves out repos already in the product and names each row's project", async () => {
    const dialog = await openPicker([
      option({ id: REPO_A, ownerOrOrg: "acme", repoName: "checkout" }),
      option({ id: "rc-1", projectName: "Feeds", workspaceName: "Analytics" }),
      option({ id: "rc-2", projectName: "Loose" }),
    ]);
    const rows = await within(dialog).findAllByRole("button", { name: /miniflux\/v2/ });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Analytics / Feeds");
    expect(rows[1]).toHaveTextContent("Loose");
    expect(within(dialog).queryByText("acme/checkout")).not.toBeInTheDocument();

    await userEvent.click(rows[0]!);
    expect(within(dialog).getByText(/^Selected:/)).toHaveTextContent(
      "Selected: miniflux/v2 in Feeds",
    );
  });

  it("drops the pick when the search is edited, so Add cannot add a repo no longer shown", async () => {
    const dialog = await openPicker([option({ id: "rc-1", projectName: "Feeds" })]);
    const [row] = await within(dialog).findAllByRole("button", { name: /miniflux\/v2/ });
    await userEvent.click(row!);
    const add = within(dialog).getByRole("button", { name: "Add Repository" });
    expect(add).toBeEnabled();

    await userEvent.type(within(dialog).getByPlaceholderText(/Search repo connections/), "x");
    expect(within(dialog).queryByText(/^Selected:/)).not.toBeInTheDocument();
    expect(add).toBeDisabled();
  });

  it("says when every match is already in the product", async () => {
    const dialog = await openPicker([option({ id: REPO_A })]);
    expect(
      await within(dialog).findByText("Every matching connection is already in this product."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("No connections found.")).not.toBeInTheDocument();
  });

  it("says when nothing matches", async () => {
    const dialog = await openPicker([]);
    expect(await within(dialog).findByText("No connections found.")).toBeInTheDocument();
  });
});
