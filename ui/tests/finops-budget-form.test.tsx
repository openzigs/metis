/**
 * Tests for the FinOps BudgetForm component (Epic #47 / Issue #54).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BudgetForm, dollarsToCents } from "@/components/finops/BudgetForm";

const { api } = vi.hoisted(() => ({
  api: { setBudget: vi.fn() },
}));

vi.mock("@/lib/finops-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, finopsApi: { ...(actual.finopsApi as object), setBudget: api.setBudget } };
});

function renderForm(currentBudgetCents: number | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BudgetForm workspaceId="w1" currentBudgetCents={currentBudgetCents} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.setBudget.mockReset();
  api.setBudget.mockResolvedValue({ monthlyBudgetCents: 5000 });
});

describe("dollarsToCents", () => {
  it("converts dollars to integer cents", () => {
    expect(dollarsToCents("50")).toBe(5000);
    expect(dollarsToCents("12.34")).toBe(1234);
  });

  it("returns null for empty input", () => {
    expect(dollarsToCents("  ")).toBeNull();
  });

  it("returns null for negative or NaN input", () => {
    expect(dollarsToCents("-5")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
  });
});

describe("BudgetForm", () => {
  it("shows the current budget", () => {
    renderForm(2500);
    expect(screen.getByText(/Current: \$25\.00/)).toBeTruthy();
  });

  it("submits the budget in cents", async () => {
    const user = userEvent.setup();
    renderForm(null);
    const input = screen.getByLabelText("Monthly budget in dollars");
    await user.type(input, "75");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.setBudget).toHaveBeenCalledWith("w1", 7500));
  });

  // SC 3.3.3 (#663): a negative amount has a detectable cause, so the message
  // suggests the corrected non-negative value and the API is NOT called.
  it("suggests a non-negative amount for a negative entry (#663)", async () => {
    renderForm(null);
    const input = screen.getByLabelText("Monthly budget in dollars") as HTMLInputElement;
    // A negative value trips the number field's min=0 constraint, so the browser
    // blocks a click-submit; dispatch submit directly to exercise the JS guard.
    fireEvent.change(input, { target: { value: "-50" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/non-negative amount — try 50/i),
    );
    expect(api.setBudget).not.toHaveBeenCalled();
  });

  it("clears the budget (null) when submitted empty", async () => {
    const user = userEvent.setup();
    renderForm(5000);
    const input = screen.getByLabelText("Monthly budget in dollars");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(api.setBudget).toHaveBeenCalledWith("w1", null));
  });
});
