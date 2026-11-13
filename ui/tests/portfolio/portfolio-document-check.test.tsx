/**
 * #2272 — a portfolio check of a document's requirements, in chosen products:
 * the form sends a document and several products as the contract accepts
 * them, the check's page lists each requirement checked and everything not
 * checked, the impact says how sure it is, and the links carry a document and
 * every chosen product.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PORTFOLIO_ASSESSMENT_MAX_PRODUCTS, createPortfolioAssessmentSchema } from "@metis/shared";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";
import { PortfolioRequirementsChecked } from "@/components/portfolio/portfolio-requirements-checked";
import { ImpactTierBadge, PortfolioImpactView } from "@/components/portfolio/portfolio-impact-view";
import { portfolioCheckHref } from "@/components/portfolio/portfolio-check-link";
import { hostPickerHref, impactGroups } from "@/lib/portfolio-impact";
import { view } from "./fixtures";
import { impactView } from "./impact-fixtures";
import { axeViolations } from "./axe";

const products = [
  { id: "p-billing", name: "Billing" },
  { id: "p-crm", name: "CRM" },
  { id: "p-ledger", name: "Ledger" },
];

function setup(props: Partial<Parameters<typeof PortfolioAssessmentForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const utils = render(
    <PortfolioAssessmentForm products={products} pending={false} onSubmit={onSubmit} {...props} />,
  );
  return { onSubmit, ...utils };
}

const host = () => screen.getByLabelText("Which product will build this? (optional)");

describe("#2272 — the form: several products, and a document", () => {
  it("sends every product ticked as one product scope, and waits for one", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText("Requirement statement"), "Pay by transfer");
    // #2351 — products are ticked in the shared scope picker.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    const submit = screen.getByRole("button", { name: "Check coverage" });
    await user.click(screen.getByRole("checkbox", { name: "Billing" }));
    await user.click(screen.getByRole("checkbox", { name: "Ledger" }));
    await user.click(screen.getByRole("checkbox", { name: "CRM" }));
    await user.click(screen.getByRole("checkbox", { name: "CRM" }));
    expect(screen.getByTestId("portfolio-scope-hint")).toHaveTextContent("2 products to check.");
    await user.click(submit);
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({
      statement: "Pay by transfer",
      scope: "product",
      productIds: ["p-billing", "p-ledger"],
    });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("offers only the products ticked to build it", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    // #2351 — products are ticked in the shared scope picker.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    await user.click(screen.getByRole("checkbox", { name: "Billing" }));
    await user.click(screen.getByRole("checkbox", { name: "Ledger" }));
    expect(
      within(host())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Not decided yet", "Billing", "Ledger"]);
    await user.selectOptions(host(), "p-ledger");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent.hostProductId).toBe("p-ledger");
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("keeps a ticked product, by name, when a search drops it from the list", async () => {
    const user = userEvent.setup();
    const onProductQueryChange = vi.fn();
    const { onSubmit, rerender } = setup({ onProductQueryChange, productTotal: 140 });
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    // #2351 — products are ticked in the shared scope picker.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    expect(screen.getByText(/Showing 3 of 140 products; type part of a name/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "CRM" }));
    await user.type(screen.getByLabelText("Find products"), "b");
    expect(onProductQueryChange).toHaveBeenLastCalledWith("b");
    rerender(
      <PortfolioAssessmentForm
        products={[products[0]]}
        onProductQueryChange={onProductQueryChange}
        pending={false}
        onSubmit={onSubmit}
      />,
    );
    // Typing in the search closed the picker; it reopens with CRM still ticked.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    expect(screen.getByRole("checkbox", { name: "CRM" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Billing" }));
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0].productIds).toEqual(["p-crm", "p-billing"]);
  });

  it("stops ticking at the cap", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: PORTFOLIO_ASSESSMENT_MAX_PRODUCTS + 1 }, (_, i) => ({
      id: `p${i}`,
      name: `Product ${i}`,
    }));
    setup({ products: many });
    // #2351 — products are ticked in the shared scope picker.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    for (const p of many.slice(0, PORTFOLIO_ASSESSMENT_MAX_PRODUCTS)) {
      await user.click(screen.getByRole("checkbox", { name: p.name }));
    }
    const last = screen.getByRole("checkbox", {
      name: `Product ${PORTFOLIO_ASSESSMENT_MAX_PRODUCTS}`,
    });
    expect(last).toBeDisabled();
    // A ticked one can still be unticked, which frees a place.
    await user.click(screen.getByRole("checkbox", { name: "Product 0" }));
    expect(last).toBeEnabled();
  });

  it("starts on several products it arrived with", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ initialProductIds: ["p-crm", "p-elsewhere"] });
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    expect(screen.getByRole("checkbox", { name: "CRM" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Selected product" })).toBeChecked();
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0].productIds).toEqual(["p-crm", "p-elsewhere"]);
  });

  it("sends a document, not a statement, when it arrived with one", async () => {
    const user = userEvent.setup();
    const onClearDocument = vi.fn();
    const { onSubmit } = setup({
      document: { id: "doc-1", title: "Payments FRD" },
      onClearDocument,
    });
    expect(screen.queryByLabelText("Requirement statement")).toBeNull();
    expect(screen.getByTestId("portfolio-form-document")).toHaveTextContent("Payments FRD");
    expect(screen.getByTestId("portfolio-form-document")).toHaveTextContent(
      "checks each requirement it finds",
    );
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({ documentId: "doc-1", scope: "all-accessible" });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
    await user.click(screen.getByRole("button", { name: "Type a statement instead" }));
    expect(onClearDocument).toHaveBeenCalledOnce();
  });

  it("passes axe with several products and a document", async () => {
    const user = userEvent.setup();
    const { container } = setup({ document: { id: "doc-1", title: "FRD" } });
    // #2351 — products are ticked in the shared scope picker.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    await user.click(screen.getByRole("checkbox", { name: "Billing" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("#2272 — what the check checked, and did not", () => {
  const checkedView = () =>
    view({
      productIds: ["p-billing", "p-crm"],
      productNames: { "p-billing": "Billing", "p-crm": "CRM" },
      notChecked: [
        { text: "Appendix B", reason: "section-unread", count: null },
        { text: "Refunds over 1k", reason: "budget", count: 2 },
      ],
      products: [
        {
          productId: "p-billing",
          coverage: "partial",
          impactKind: "none",
          via: null,
          edgeIds: [],
          severity: null,
          baSummary: "",
          technicalDetail: {
            criteria: [
              { criterion: "Pay by transfer", coveredBy: ["rc-1"] },
              { criterion: "Refunds over 1k", coveredBy: [] },
            ],
          },
        },
        {
          productId: "p-crm",
          coverage: "not-covered",
          impactKind: "none",
          via: null,
          edgeIds: [],
          severity: null,
          baSummary: "",
          technicalDetail: {
            criteria: [
              { criterion: "Pay by transfer", coveredBy: [] },
              { criterion: "Refunds over 1k", coveredBy: [] },
            ],
          },
        },
      ],
    });

  it("lists each requirement with the products found implementing it", () => {
    render(<PortfolioRequirementsChecked view={checkedView()} />);
    const rows = screen.getAllByTestId("portfolio-requirement-row").map((r) => r.textContent);
    expect(rows).toEqual([
      "Pay by transfer — implemented by Billing",
      "Refunds over 1k — no product found implementing it",
    ]);
    expect(screen.getByRole("heading", { name: "Requirements checked (2)" })).toBeInTheDocument();
  });

  it("lists everything not checked, with why", async () => {
    const { container } = render(<PortfolioRequirementsChecked view={checkedView()} />);
    const rows = screen.getAllByTestId("portfolio-not-checked-row");
    expect(rows.map((r) => r.getAttribute("data-reason"))).toEqual(["section-unread", "budget"]);
    expect(rows[0]).toHaveTextContent(
      "Appendix B Not checked: the model could not read this section of the document.",
    );
    expect(rows[1]).toHaveTextContent(
      "Refunds over 1k Not checked in 2 repositories: the check's budget ran out first.",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("shows neither for a one-requirement check with nothing cut", () => {
    const { container } = render(<PortfolioRequirementsChecked view={view()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("#2272 — impact tiers", () => {
  it("labels each tier", () => {
    render(
      <>
        <ImpactTierBadge tier="found-in-code" />
        <ImpactTierBadge tier="verified" />
        <ImpactTierBadge tier="needs-review" />
      </>,
    );
    expect(screen.getAllByTestId("portfolio-impact-tier").map((b) => b.textContent)).toEqual([
      "Found in code",
      "Verified by graph path",
      "Needs review",
    ]);
  });

  it("each affected product's card on the page shows its tier: found in code is never graph-verified", () => {
    const groups = impactGroups(impactView());
    render(<PortfolioImpactView affected={groups.affected} notAffected={groups.notAffected} />);
    const tierOf = (name: string) =>
      within(
        screen
          .getAllByTestId("portfolio-affected-product")
          .find((c) => within(c).queryByRole("heading", { name }))!,
      ).getByTestId("portfolio-impact-tier").textContent;
    // Billing must change, and the check found its code: no graph path was walked to it.
    expect(tierOf("Billing")).toBe("Found in code");
    // Ledger is reached by one detected hop at 0.9: verified by graph path.
    expect(tierOf("Ledger")).toBe("Verified by graph path");
    // Warehouse's path has a hop at 0.4.
    expect(tierOf("Warehouse")).toBe("Possible");
    expect(
      screen
        .getAllByTestId("portfolio-affected-product")
        .map((c) => within(c).queryAllByTestId("portfolio-impact-tier").length),
    ).toEqual(groups.affected.map(() => 1));
  });

  it("gives every affected product a tier", () => {
    const { affected } = impactGroups(
      view({
        productNames: { "p-billing": "Billing" },
        products: [
          {
            productId: "p-billing",
            coverage: "partial",
            impactKind: "direct-change",
            via: null,
            edgeIds: [],
            severity: null,
            baSummary: "",
            technicalDetail: {},
          },
          {
            productId: "p-x",
            coverage: "restricted",
            impactKind: "restricted",
            via: null,
            edgeIds: [],
            severity: null,
            baSummary: "",
            technicalDetail: {},
          },
        ],
      }),
    );
    expect(affected.map((a) => [a.productId, a.tier])).toEqual([
      ["p-billing", "found-in-code"],
      ["p-x", "needs-review"],
    ]);
  });
});

describe("#2272 — links carry a document and every chosen product", () => {
  it("the documents page's link carries the document id and its title", () => {
    const params = new URL(
      portfolioCheckHref({ documentId: "doc 1", title: "Payments FRD" }),
      "http://x",
    ).searchParams;
    expect(params.get("documentId")).toBe("doc 1");
    expect(params.get("title")).toBe("Payments FRD");
  });

  it("the host picker link re-opens a document check on its document and products", () => {
    const url = new URL(
      hostPickerHref(
        view({
          sourceDocumentId: "doc-1",
          statement:
            'Requirements read from "Payments FRD": the model read it in full and found 2 requirements. Each is checked on its own.',
          scope: "product",
          productIds: ["p-billing", "p-crm"],
        }),
      ),
      "http://x",
    );
    expect(url.searchParams.get("documentId")).toBe("doc-1");
    expect(url.searchParams.get("title")).toBe("Payments FRD");
    expect(url.searchParams.has("statement")).toBe(false);
    expect(url.searchParams.getAll("productId")).toEqual(["p-billing", "p-crm"]);
  });

  it("reads a document title that holds a quote whole, with or without the reading's tail", () => {
    for (const statement of [
      'Requirements read from "The "Pay" FRD": the model read it in full and found 2 requirements. Each is checked on its own.',
      'Requirements read from "The "Pay" FRD"',
      'Requirements read from "The "Pay" FRD": No requirement was found in the document.',
    ]) {
      const url = new URL(
        hostPickerHref(view({ sourceDocumentId: "doc-1", statement })),
        "http://x",
      );
      expect(url.searchParams.get("title")).toBe('The "Pay" FRD');
    }
  });

  it("names a document it cannot read the title of plainly", () => {
    const url = new URL(
      hostPickerHref(view({ sourceDocumentId: "doc-1", statement: "Something else" })),
      "http://x",
    );
    expect(url.searchParams.get("title")).toBe("Selected document");
  });
});
