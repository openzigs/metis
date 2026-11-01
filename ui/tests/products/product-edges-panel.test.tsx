/**
 * #1628 — the product page's edge list and declared-edge editor. The panel
 * reads the product through `productsApi.get`, so every "after save" assertion
 * is on what a re-read of the GET returns, not on what the form held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api-client";
import { productsApi, type ProductWithRepos } from "@/lib/products-api";
import { ProductEdgesPanel } from "@/components/products/product-edges-panel";
import { makeWrapper } from "../test-utils";
import {
  PRODUCT_ID,
  REPO_A,
  REPO_B,
  declaredEdge,
  detectedEdge,
  edge,
  idp,
  product,
} from "./product-edges-fixtures";

let getMock: ReturnType<typeof vi.spyOn>;

/** Serve `views` from the GET in turn, repeating the last. */
function serve(...views: ProductWithRepos[]) {
  let i = 0;
  getMock = vi.spyOn(productsApi, "get").mockImplementation(async () => {
    const v = views[Math.min(i, views.length - 1)];
    i += 1;
    return v;
  });
}

function renderPanel(canEdit = true) {
  return render(<ProductEdgesPanel productId={PRODUCT_ID} canEdit={canEdit} />, {
    wrapper: makeWrapper({ withAuth: false }),
  });
}

function rows() {
  const table = screen.getByRole("table");
  return within(table).getAllByRole("row").slice(1);
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("the edge list", () => {
  it("shows kind, strength, direction, origin and confidence per edge", async () => {
    serve(product());
    renderPanel(false);
    await screen.findByRole("table");
    const [detected, declared] = rows();
    expect(detected).toHaveTextContent("acme/checkout");
    expect(detected).toHaveTextContent("acme/ledger");
    expect(detected).toHaveTextContent("api");
    expect(detected).toHaveTextContent("contract");
    expect(detected).toHaveTextContent("consumes");
    expect(detected).toHaveTextContent("Detected");
    expect(detected).toHaveTextContent("72%");
    expect(declared).toHaveTextContent("Okta (identity-provider)");
    expect(declared).toHaveTextContent("identity");
    expect(declared).toHaveTextContent("functional");
    expect(declared).toHaveTextContent("depends-on");
    expect(declared).toHaveTextContent("Declared");
    expect(declared).toHaveTextContent("100%");
  });

  it("filters the rendered rows by kind", async () => {
    serve(product());
    renderPanel(false);
    await screen.findByRole("table");
    expect(rows()).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("Filter by kind"), "identity");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Okta");
    await userEvent.selectOptions(screen.getByLabelText("Filter by kind"), "event");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("No edges of this kind.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Filter by kind"), "all");
    expect(rows()).toHaveLength(2);
  });

  it("says when the product has no edges, and labels an unclassified one", async () => {
    serve(product({ edges: [], resources: [] }));
    const { unmount } = renderPanel(false);
    expect(await screen.findByText("No integration edges yet.")).toBeInTheDocument();
    expect(screen.getByText("No shared resources yet.")).toBeInTheDocument();
    unmount();
    serve(product({ edges: [edge({ integrationKind: null, strength: null, direction: null })] }));
    renderPanel(false);
    await screen.findByRole("table");
    expect(rows()[0]).toHaveTextContent("unclassified");
  });

  it("renders a resource locator as text, never a link", async () => {
    serve(product());
    renderPanel(false);
    const list = await screen.findByRole("list", { name: "Shared resources" });
    expect(within(list).getByText("https://acme.okta.com").tagName).toBe("CODE");
    expect(within(list).queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("without edit rights", () => {
  it("renders the list read-only: no control of any kind", async () => {
    serve(product());
    renderPanel(false);
    await screen.findByRole("table");
    expect(screen.getByRole("note")).toHaveTextContent(/^Restricted:/);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // The kind filter is the only select: no strength override.
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

describe("with edit rights", () => {
  it("offers a declared edge edit and delete, and a detected edge only a strength override", async () => {
    serve(product());
    renderPanel(true);
    await screen.findByRole("table");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    const [detected, declared] = rows();
    expect(within(detected).queryByRole("button")).not.toBeInTheDocument();
    expect(
      within(detected).getByRole("combobox", {
        name: /Override strength of edge from acme\/checkout/,
      }),
    ).toHaveValue("contract");
    expect(within(declared).getByRole("button", { name: /^Delete edge/ })).toBeInTheDocument();
    expect(within(declared).getByRole("button", { name: /^Edit edge/ })).toBeInTheDocument();
    expect(within(declared).queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("treats an overridden edge as detected: no delete", async () => {
    serve(product({ edges: [edge({ origin: "overridden", strength: "intrusive" })] }));
    renderPanel(true);
    await screen.findByRole("table");
    const [row] = rows();
    expect(row).toHaveTextContent("Detected (overridden)");
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(within(row).getByRole("combobox")).toHaveValue("intrusive");
  });

  it("overrides a detected edge's strength with a PATCH of the strength alone, then re-reads", async () => {
    const overridden = edge({ origin: "overridden", strength: "intrusive" });
    serve(product(), product({ edges: [overridden, declaredEdge] }));
    const update = vi.spyOn(productsApi, "updateEdge").mockResolvedValue(overridden);
    renderPanel(true);
    await screen.findByRole("table");
    await userEvent.selectOptions(within(rows()[0]).getByRole("combobox"), "intrusive");
    expect(update).toHaveBeenCalledWith(PRODUCT_ID, detectedEdge.id, { strength: "intrusive" });
    await waitFor(() => expect(rows()[0]).toHaveTextContent("Detected (overridden)"));
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("declares an edge; the row shown after save is the one the GET returns", async () => {
    const created = edge({
      id: "edge-new00001",
      origin: "declared",
      confidence: 1,
      integrationKind: "event",
      strength: "model",
      direction: "provides",
      declaredById: "u-1",
    });
    serve(product({ edges: [] }), product({ edges: [created] }));
    const declare = vi.spyOn(productsApi, "declareEdge").mockResolvedValue(created);
    renderPanel(true);
    await screen.findByText("No integration edges yet.");
    await userEvent.click(screen.getByRole("button", { name: /Declare edge/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("From repository")).toHaveValue(REPO_A);
    await userEvent.selectOptions(within(dialog).getByLabelText("To repository"), REPO_B);
    await userEvent.selectOptions(within(dialog).getByLabelText("Kind"), "event");
    await userEvent.selectOptions(within(dialog).getByLabelText("Strength"), "model");
    await userEvent.selectOptions(within(dialog).getByLabelText("Direction"), "provides");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save edge" }));

    expect(declare).toHaveBeenCalledWith(PRODUCT_ID, {
      sourceRepoId: REPO_A,
      targetRepoId: REPO_B,
      resourceId: null,
      edgeType: "calls",
      integrationKind: "event",
      strength: "model",
      direction: "provides",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("event");
    expect(rows()[0]).toHaveTextContent("Declared");
  });

  it("refuses an edge with neither target nor resource before any request", async () => {
    serve(product());
    const declare = vi.spyOn(productsApi, "declareEdge");
    renderPanel(true);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: /Declare edge/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save edge" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Choose a target repository, a shared resource, or both.",
    );
    expect(declare).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    serve(product());
    vi.spyOn(productsApi, "declareEdge").mockRejectedValue(
      new ApiError(409, "This product already has that edge", "EDGE_EXISTS"),
    );
    renderPanel(true);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: /Declare edge/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Through shared resource"), idp.id);
    await userEvent.click(within(dialog).getByRole("button", { name: "Save edge" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "This product already has that edge",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("edits a declared edge: prefilled, source locked, PATCH without the source", async () => {
    const changed = { ...declaredEdge, strength: "intrusive" as const };
    serve(product(), product({ edges: [detectedEdge, changed] }));
    const update = vi.spyOn(productsApi, "updateEdge").mockResolvedValue(changed);
    renderPanel(true);
    await screen.findByRole("table");
    await userEvent.click(within(rows()[1]).getByRole("button", { name: /^Edit edge/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit declared edge")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("From repository")).toBeDisabled();
    expect(within(dialog).getByLabelText("From repository")).toHaveValue(REPO_B);
    expect(within(dialog).getByLabelText("Through shared resource")).toHaveValue(idp.id);
    expect(within(dialog).getByLabelText("Strength")).toHaveValue("functional");
    await userEvent.selectOptions(within(dialog).getByLabelText("Strength"), "intrusive");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save edge" }));
    expect(update).toHaveBeenCalledWith(PRODUCT_ID, declaredEdge.id, {
      targetRepoId: null,
      resourceId: idp.id,
      edgeType: "consumes",
      integrationKind: "identity",
      strength: "intrusive",
      direction: "depends-on",
    });
    await waitFor(() => expect(rows()[1]).toHaveTextContent("intrusive"));
  });

  it("deletes a declared edge, then shows the list the GET returns", async () => {
    serve(product(), product({ edges: [detectedEdge] }));
    const remove = vi.spyOn(productsApi, "deleteEdge").mockResolvedValue(undefined);
    renderPanel(true);
    await screen.findByRole("table");
    await userEvent.click(within(rows()[1]).getByRole("button", { name: /^Delete edge/ }));
    expect(remove).toHaveBeenCalledWith(PRODUCT_ID, declaredEdge.id);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it("shows a refused delete or override", async () => {
    serve(product());
    vi.spyOn(productsApi, "deleteEdge").mockRejectedValue(
      new ApiError(409, "A detected edge cannot be deleted", "DETECTED_EDGE_UNDELETABLE"),
    );
    vi.spyOn(productsApi, "updateEdge").mockRejectedValue(new Error("network"));
    renderPanel(true);
    await screen.findByRole("table");
    await userEvent.click(within(rows()[1]).getByRole("button", { name: /^Delete edge/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A detected edge cannot be deleted");
    await userEvent.selectOptions(within(rows()[0]).getByRole("combobox"), "model");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to override the strength."),
    );
  });

  it("disables declaring an edge when the product shows no repos", async () => {
    serve(product({ repos: [], edges: [], resources: [] }));
    renderPanel(true);
    expect(await screen.findByRole("button", { name: /Declare edge/ })).toBeDisabled();
  });

  it("declares a shared resource, then re-reads", async () => {
    const bucket = {
      ...idp,
      id: "res-bucket01",
      kind: "bucket" as const,
      name: "nightly-drops",
      locator: null,
    };
    serve(product({ resources: [] }), product({ resources: [bucket] }));
    const declare = vi.spyOn(productsApi, "declareResource").mockResolvedValue(bucket);
    renderPanel(true);
    await screen.findByText("No shared resources yet.");
    const form = screen.getByRole("form", { name: "Declare a shared resource" });
    const submit = within(form).getByRole("button", { name: "Declare resource" });
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(within(form).getByLabelText("Resource kind"), "bucket");
    await userEvent.type(within(form).getByLabelText("Resource name"), "  nightly-drops ");
    await userEvent.click(submit);
    expect(declare).toHaveBeenCalledWith(PRODUCT_ID, {
      kind: "bucket",
      name: "nightly-drops",
      locator: null,
    });
    const list = await screen.findByRole("list", { name: "Shared resources" });
    expect(list).toHaveTextContent("nightly-drops");
    expect(within(form).getByLabelText("Resource name")).toHaveValue("");
  });

  it("shows a refused resource", async () => {
    serve(product());
    vi.spyOn(productsApi, "declareResource").mockRejectedValue(
      new ApiError(400, "a locator must not carry credentials", "VALIDATION_ERROR"),
    );
    renderPanel(true);
    const form = await screen.findByRole("form", { name: "Declare a shared resource" });
    await userEvent.type(within(form).getByLabelText("Resource name"), "db");
    await userEvent.type(within(form).getByLabelText(/Locator/), "postgres://u:p@h/db");
    await userEvent.click(within(form).getByRole("button", { name: "Declare resource" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "a locator must not carry credentials",
    );
  });
});
