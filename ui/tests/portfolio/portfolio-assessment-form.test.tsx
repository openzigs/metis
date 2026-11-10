/**
 * #1626 — the form sends what `createPortfolioAssessmentSchema` accepts:
 * exactly one of statement and requirement, and a scope that names exactly
 * one product or none. Keyboard operable; axe passes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortfolioAssessmentSchema } from "@metis/shared";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";
import { axeViolations } from "./axe";

const products = [
  { id: "p-billing", name: "Billing" },
  { id: "p-crm", name: "CRM" },
];

function setup(props: Partial<Parameters<typeof PortfolioAssessmentForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const utils = render(
    <PortfolioAssessmentForm products={products} pending={false} onSubmit={onSubmit} {...props} />,
  );
  return { onSubmit, ...utils };
}

describe("PortfolioAssessmentForm", () => {
  it("sends a statement across every product the analyst can access by default", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    const submit = screen.getByRole("button", { name: "Check coverage" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Requirement statement"), "  Pay by transfer  ");
    await user.click(submit);
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({ statement: "Pay by transfer", scope: "all-accessible" });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("does not send a blank statement", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText("Requirement statement"), "   ");
    expect(screen.getByRole("button", { name: "Check coverage" })).toBeDisabled();
    await user.type(screen.getByLabelText("Requirement statement"), "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sends one product when the scope is one product, and waits for a choice", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.type(screen.getByLabelText("Requirement statement"), "Pay by transfer");
    await user.click(screen.getByRole("radio", { name: "One product" }));
    const submit = screen.getByRole("button", { name: "Check coverage" });
    expect(submit).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Product"), "p-crm");
    await user.click(submit);
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({ statement: "Pay by transfer", scope: "product", productIds: ["p-crm"] });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("#1673 — offers a search, says the list is partial, and keeps the chosen product as it narrows", async () => {
    const user = userEvent.setup();
    const onProductQueryChange = vi.fn();
    const { onSubmit, rerender } = setup({ onProductQueryChange, productTotal: 140 });
    await user.type(screen.getByLabelText("Requirement statement"), "Pay by transfer");
    await user.click(screen.getByRole("radio", { name: "One product" }));
    expect(screen.getByLabelText("Product")).toHaveAccessibleDescription(
      "Showing 2 of 140 products. Type part of a name to find another.",
    );
    await user.selectOptions(screen.getByLabelText("Product"), "p-crm");
    await user.type(screen.getByLabelText("Find a product"), "b");
    expect(onProductQueryChange).toHaveBeenLastCalledWith("b");
    // The search narrows the list to Billing: CRM stays chosen, by name.
    rerender(
      <PortfolioAssessmentForm
        products={[products[0]]}
        productTotal={1}
        onProductQueryChange={onProductQueryChange}
        pending={false}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByLabelText("Product")).toHaveValue("p-crm");
    expect(
      within(screen.getByLabelText("Product")).getByRole("option", { name: "CRM" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      statement: "Pay by transfer",
      scope: "product",
      productIds: ["p-crm"],
    });
  });

  it("names a product it arrived with that the list does not hold", async () => {
    const user = userEvent.setup();
    setup({ initialProductId: "p-elsewhere" });
    expect(screen.getByLabelText("Product")).toHaveValue("p-elsewhere");
    expect(
      within(screen.getByLabelText("Product")).getByRole("option", { name: "Selected product" }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Product"), "p-billing");
    expect(
      within(screen.getByLabelText("Product")).queryByRole("option", { name: "Selected product" }),
    ).toBeNull();
  });

  it("#1689 — keeps the name of a product it arrived with once a search drops it", () => {
    const onProductQueryChange = vi.fn();
    // The first page holds it, so the page never reads its name on its own.
    const { rerender } = setup({ initialProductId: "p-crm", onProductQueryChange });
    expect(screen.getByLabelText("Product")).toHaveValue("p-crm");
    rerender(
      <PortfolioAssessmentForm
        products={[products[0]]}
        initialProductId="p-crm"
        onProductQueryChange={onProductQueryChange}
        pending={false}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Product")).toHaveValue("p-crm");
    expect(
      within(screen.getByLabelText("Product")).getByRole("option", { name: "CRM" }),
    ).toHaveValue("p-crm");
    expect(
      within(screen.getByLabelText("Product")).queryByRole("option", { name: "Selected product" }),
    ).toBeNull();
  });

  it("names a product it arrived with by the name it was given (#1680)", () => {
    setup({ initialProductId: "p-elsewhere", initialProductName: "Treasury" });
    expect(
      within(screen.getByLabelText("Product")).getByRole("option", { name: "Treasury" }),
    ).toHaveValue("p-elsewhere");
    expect(
      within(screen.getByLabelText("Product")).queryByRole("option", { name: "Selected product" }),
    ).toBeNull();
  });

  it("starts on the product it arrived from", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ initialProductId: "p-billing" });
    expect(screen.getByRole("radio", { name: "One product" })).toBeChecked();
    expect(screen.getByLabelText("Product")).toHaveValue("p-billing");
    await user.type(screen.getByLabelText("Requirement statement"), "x");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0].productIds).toEqual(["p-billing"]);
  });

  it("sends the requirement, not a statement, when it arrived with one", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ requirement: { id: "req-1", title: "Pay by transfer" } });
    expect(screen.queryByLabelText("Requirement statement")).toBeNull();
    expect(screen.getByTestId("portfolio-form-requirement")).toHaveTextContent("Pay by transfer");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({ requirementId: "req-1", scope: "all-accessible" });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("offers to type a statement instead of the requirement", async () => {
    const user = userEvent.setup();
    const onClearRequirement = vi.fn();
    setup({ requirement: { id: "req-1", title: "T" }, onClearRequirement });
    await user.click(screen.getByRole("button", { name: "Type a statement instead" }));
    expect(onClearRequirement).toHaveBeenCalledOnce();
  });

  it("shows the server's error and disables the button while starting", () => {
    setup({ pending: true, error: "Requirement not found" });
    expect(screen.getByRole("alert")).toHaveTextContent("Requirement not found");
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
  });

  it("says products are loading", async () => {
    const user = userEvent.setup();
    setup({ productsLoading: true });
    await user.click(screen.getByRole("radio", { name: "One product" }));
    expect(screen.getByLabelText("Product")).toBeDisabled();
    expect(
      within(screen.getByLabelText("Product")).getByRole("option", { name: "Loading products…" }),
    ).toBeInTheDocument();
  });

  it("is keyboard operable from the statement to the submit button", async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.tab();
    expect(screen.getByLabelText("Requirement statement")).toHaveFocus();
    await user.keyboard("Pay by transfer");
    await user.tab();
    expect(screen.getByRole("radio", { name: "All products I can access" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "One product" })).toBeChecked();
    await user.tab();
    expect(screen.getByLabelText("Product")).toHaveFocus();
    await user.selectOptions(screen.getByLabelText("Product"), "p-billing");
    await user.tab();
    // #1725 — the optional host picker comes next.
    expect(screen.getByLabelText("Which product will build this? (optional)")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Check coverage" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("passes axe in both scopes", async () => {
    const user = userEvent.setup();
    const { container } = setup({ error: "Something failed" });
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole("radio", { name: "One product" }));
    expect(await axeViolations(container)).toEqual([]);
  });
});

// #1749 — the "choose the product that will build it" link lands at
// `#portfolio-host`; the picker gets the focus, not only the scroll.
describe("PortfolioAssessmentForm — arriving at the host picker (#1749)", () => {
  afterEach(() => {
    window.location.hash = "";
  });

  const picker = () => screen.getByLabelText("Which product will build this? (optional)");

  it("focuses the host picker when the page is opened at #portfolio-host", () => {
    window.location.hash = "#portfolio-host";
    setup();
    expect(picker()).toHaveFocus();
  });

  it("waits for the product list, since the picker is disabled until then", () => {
    window.location.hash = "#portfolio-host";
    const { rerender, onSubmit } = setup({ productsLoading: true });
    expect(picker()).not.toHaveFocus();
    rerender(<PortfolioAssessmentForm products={products} pending={false} onSubmit={onSubmit} />);
    expect(picker()).toHaveFocus();
  });

  it("leaves the focus alone on any other arrival", () => {
    setup();
    expect(picker()).not.toHaveFocus();
  });

  it("focuses it once, not again when the list reloads", async () => {
    window.location.hash = "#portfolio-host";
    const user = userEvent.setup();
    const { rerender, onSubmit } = setup();
    const statement = screen.getByLabelText("Requirement statement");
    await user.click(statement);
    rerender(
      <PortfolioAssessmentForm
        products={products}
        productsLoading
        pending={false}
        onSubmit={onSubmit}
      />,
    );
    rerender(<PortfolioAssessmentForm products={products} pending={false} onSubmit={onSubmit} />);
    expect(statement).toHaveFocus();
  });
});
