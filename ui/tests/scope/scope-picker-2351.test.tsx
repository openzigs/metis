/**
 * Issue #2351 — one scope picker for chat, impact analysis and the portfolio
 * check: the same three options and wording, the same keyboard behaviour, and
 * in the portfolio form the defaults per launch context.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PORTFOLIO_ASSESSMENT_MAX_PRODUCTS, createPortfolioAssessmentSchema } from "@metis/shared";
import {
  SCOPE_WORDS,
  ScopePicker,
  scopeLabel,
  workspaceText,
  type ScopePickerProps,
} from "@/components/scope/scope-picker";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";

const items = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
  { id: "c", name: "Gamma" },
];

function picker(props: Partial<ScopePickerProps> = {}) {
  const handlers = { onPickThis: vi.fn(), onPickWorkspace: vi.fn(), onToggle: vi.fn() };
  render(
    <ScopePicker
      kind={null}
      chosenIds={[]}
      items={items}
      testIdBase="t"
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("#2351 — the shared picker's wording", () => {
  it("names each option the same way, and says how many products a workspace is", () => {
    const nameOf = (id: string) => items.find((p) => p.id === id)?.name;
    expect(workspaceText("Payments", 3)).toBe("Payments (3 products)");
    expect(workspaceText("Payments", 1)).toBe("Payments (1 product)");
    expect(workspaceText("Payments", null)).toBe("Payments");
    expect(scopeLabel({ kind: null, chosenIds: [], nameOf })).toEqual({
      lead: null,
      detail: SCOPE_WORDS.nothing,
    });
    expect(scopeLabel({ kind: "this", chosenIds: [], nameOf, current: items[0] })).toEqual({
      lead: "This project:",
      detail: "Alpha",
    });
    expect(
      scopeLabel({
        kind: "workspace",
        chosenIds: [],
        nameOf,
        workspace: { name: "Pay", count: 2 },
      }),
    ).toEqual({ lead: "Whole workspace:", detail: "Pay (2 products)" });
    expect(scopeLabel({ kind: "chosen", chosenIds: ["a", "b"], nameOf }).detail).toBe(
      "Alpha + Beta",
    );
    expect(scopeLabel({ kind: "chosen", chosenIds: ["a", "b", "c"], nameOf }).detail).toBe(
      "Alpha + 2 more",
    );
  });
});

describe("#2351 — ScopePicker", () => {
  it("offers the three options, and says why one is not there", async () => {
    const user = userEvent.setup();
    picker({ currentNote: "No project is open.", workspaceNote: "No workspace is open." });
    await user.click(screen.getByTestId("t-selector"));
    expect(screen.getByTestId("t-this")).toBeDisabled();
    expect(screen.getByText("No project is open.")).toBeVisible();
    expect(screen.getByTestId("t-workspace")).toBeDisabled();
    expect(screen.getByText("No workspace is open.")).toBeVisible();
    expect(screen.getByRole("group", { name: SCOPE_WORDS.chosen })).toBeVisible();
  });

  it("picks this project or the workspace, and closes", async () => {
    const user = userEvent.setup();
    const h = picker({
      current: items[0],
      workspace: { id: "w", name: "Payments", count: 3 },
    });
    await user.click(screen.getByTestId("t-selector"));
    expect(screen.getByTestId("t-this")).toHaveTextContent("This project: Alpha");
    expect(screen.getByTestId("t-workspace")).toHaveTextContent(
      "Whole workspace: Payments (3 products)",
    );
    await user.click(screen.getByTestId("t-this"));
    expect(h.onPickThis).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("t-this")).toBeNull();
    await user.click(screen.getByTestId("t-selector"));
    await user.click(screen.getByTestId("t-workspace"));
    expect(h.onPickWorkspace).toHaveBeenCalledOnce();
  });

  it("ticks products, keeps the popover open, and stops at the cap", async () => {
    const user = userEvent.setup();
    const h = picker({ kind: "chosen", chosenIds: ["a", "b"], maxChosen: 2 });
    await user.click(screen.getByTestId("t-selector"));
    expect(screen.getByLabelText("Alpha")).toBeChecked();
    expect(screen.getByLabelText("Gamma")).toBeDisabled();
    expect(screen.getByText(/Up to 2\./)).toBeVisible();
    await user.click(screen.getByLabelText("Alpha"));
    expect(h.onToggle).toHaveBeenCalledWith(items[0]);
    expect(screen.getByLabelText("Beta")).toBeVisible();
  });

  it("closes on Escape and gives the focus back to its button", async () => {
    const user = userEvent.setup();
    picker({ current: items[0] });
    await user.click(screen.getByTestId("t-selector"));
    await user.tab();
    expect(screen.getByTestId("t-this")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("t-this")).toBeNull();
    expect(screen.getByTestId("t-selector")).toHaveFocus();
    expect(screen.getByTestId("t-selector")).toHaveAttribute("aria-expanded", "false");
  });

  it("does not show ticks for an option other than Chosen products", async () => {
    const user = userEvent.setup();
    picker({ kind: "this", chosenIds: ["a"], current: items[0] });
    await user.click(screen.getByTestId("t-selector"));
    expect(screen.getByLabelText("Alpha")).not.toBeChecked();
  });
});

describe("#2351 — the portfolio form's defaults per launch context", () => {
  const products = items;
  const form = (props: Partial<Parameters<typeof PortfolioAssessmentForm>[0]>) => {
    const onSubmit = vi.fn();
    render(
      <PortfolioAssessmentForm
        products={products}
        pending={false}
        onSubmit={onSubmit}
        initialStatement="Pay by transfer"
        {...props}
      />,
    );
    return onSubmit;
  };

  it("launched from a change request, starts on its project's product", async () => {
    const user = userEvent.setup();
    const onSubmit = form({ current: { id: "b", name: "Beta" } });
    expect(screen.getByTestId("portfolio-scope-selector")).toHaveTextContent("This project: Beta");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent).toEqual({ statement: "Pay by transfer", scope: "product", productIds: ["b"] });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("says when the project is in no product, and starts on every product the analyst can read", () => {
    form({
      current: null,
      currentNote: "Spike is not part of a product, so it is not in the portfolio.",
      workspace: { id: "w", name: "Payments", productIds: ["a", "c"], count: 2 },
    });
    expect(screen.getByTestId("portfolio-scope-selector")).toHaveTextContent(
      "Every product you can read",
    );
    fireEvent.click(screen.getByTestId("portfolio-scope-selector"));
    expect(screen.getByTestId("portfolio-scope-this")).toBeDisabled();
    expect(
      screen.getByText("Spike is not part of a product, so it is not in the portfolio."),
    ).toBeVisible();
    expect(screen.getByTestId("portfolio-scope-workspace")).toHaveTextContent(
      "Whole workspace: Payments (2 products)",
    );
  });

  it("over the whole workspace, sends the workspace's products", async () => {
    const user = userEvent.setup();
    const onSubmit = form({
      workspace: { id: "w", name: "Payments", productIds: ["a", "c"], count: 2 },
    });
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    await user.click(screen.getByTestId("portfolio-scope-workspace"));
    expect(screen.getByTestId("portfolio-scope-hint")).toHaveTextContent("2 products to check.");
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      statement: "Pay by transfer",
      scope: "product",
      productIds: ["a", "c"],
    });
  });

  it("says a workspace with more products than a check takes, and waits for a choice", () => {
    const n = PORTFOLIO_ASSESSMENT_MAX_PRODUCTS + 1;
    const pickWorkspace = () => {
      fireEvent.click(screen.getByTestId("portfolio-scope-selector"));
      fireEvent.click(screen.getByTestId("portfolio-scope-workspace"));
    };
    form({
      workspace: {
        id: "w",
        name: "Big",
        productIds: Array.from({ length: n }, (_, i) => `p${i}`),
        count: n,
      },
    });
    pickWorkspace();
    expect(screen.getByTestId("portfolio-scope-hint")).toHaveTextContent(
      `The workspace has more than ${PORTFOLIO_ASSESSMENT_MAX_PRODUCTS} products`,
    );
    expect(screen.getByRole("button", { name: "Check coverage" })).toBeDisabled();
  });

  it("from elsewhere, checks every product the analyst can read, as before", async () => {
    const user = userEvent.setup();
    const onSubmit = form({ productTotal: 7 });
    expect(screen.getByTestId("portfolio-scope-selector")).toHaveTextContent(
      "Every product you can read",
    );
    // With no workspace open, Whole workspace is the same set, and says how many.
    await user.click(screen.getByTestId("portfolio-scope-selector"));
    expect(screen.getByTestId("portfolio-scope-workspace")).toHaveTextContent(
      "Whole workspace: every product you can read (7 products)",
    );
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      statement: "Pay by transfer",
      scope: "all-accessible",
    });
  });
});
