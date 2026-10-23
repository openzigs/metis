/**
 * #1137 — New baseline says how many requirements it will pin, and of which
 * status, before it is created; it pins the approved ones only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const scope = vi.fn();
const create = vi.fn();
vi.mock("@/lib/baselines-api", () => ({
  baselinesApi: {
    scope: (...args: unknown[]) => scope(...args),
    create: (...args: unknown[]) => create(...args),
  },
}));

import { NewBaselineForm, describeBaselineScope } from "./new-baseline-form";

function renderForm() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <NewBaselineForm projectId="proj-1" />
    </QueryClientProvider>,
  );
}

describe("describeBaselineScope", () => {
  it("names the approved count and what is left out", () => {
    expect(
      describeBaselineScope({
        pinCount: 19,
        status: "approved",
        excluded: { total: 277, imported: 266 },
      }),
    ).toBe(
      "Pins the current version of the 19 approved requirements in this project. 277 not yet approved are left out, 266 of them imported from a tracker.",
    );
  });

  it("handles one, none and nothing left out", () => {
    expect(
      describeBaselineScope({
        pinCount: 1,
        status: "approved",
        excluded: { total: 0, imported: 0 },
      }),
    ).toBe("Pins the current version of the 1 approved requirement in this project.");
    expect(
      describeBaselineScope({
        pinCount: 0,
        status: "approved",
        excluded: { total: 1, imported: 0 },
      }),
    ).toBe(
      "No requirement in this project is approved yet, so there is nothing to pin. 1 not yet approved is left out.",
    );
  });
});

describe("NewBaselineForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("fetches the scope only once opened, and shows it before creating", async () => {
    scope.mockResolvedValue({
      pinCount: 19,
      status: "approved",
      excluded: { total: 266, imported: 266 },
    });
    create.mockResolvedValue({ id: "b-1" });
    renderForm();
    expect(scope).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("new-baseline"));
    await waitFor(() =>
      expect(screen.getByTestId("new-baseline-scope")).toHaveTextContent(
        "Pins the current version of the 19 approved requirements in this project. 266 not yet approved are left out, 266 of them imported from a tracker.",
      ),
    );
    expect(scope).toHaveBeenCalledWith("proj-1");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Run 8" } });
    fireEvent.click(screen.getByRole("button", { name: "Create baseline" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("proj-1", { name: "Run 8" }));
  });

  it("disables Create when nothing is approved", async () => {
    scope.mockResolvedValue({
      pinCount: 0,
      status: "approved",
      excluded: { total: 3, imported: 0 },
    });
    renderForm();
    fireEvent.click(screen.getByTestId("new-baseline"));
    await screen.findByText(/nothing to pin/);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Empty" } });
    expect(screen.getByRole("button", { name: "Create baseline" })).toBeDisabled();
  });

  it("falls back to the rule when the count cannot be loaded", async () => {
    scope.mockRejectedValue(new Error("boom"));
    renderForm();
    fireEvent.click(screen.getByTestId("new-baseline"));
    await waitFor(() =>
      expect(screen.getByTestId("new-baseline-scope")).toHaveTextContent(
        "Pins the current version of every approved requirement in this project.",
      ),
    );
  });

  it("sends the description, shows a refusal, and closes on Cancel", async () => {
    const { ApiError } = await import("@/lib/api-client");
    scope.mockResolvedValue({
      pinCount: 2,
      status: "approved",
      excluded: { total: 0, imported: 0 },
    });
    create.mockRejectedValue(new ApiError(400, "Nothing approved", "EMPTY_BASELINE"));
    renderForm();
    fireEvent.click(screen.getByTestId("new-baseline"));
    await screen.findByText(/the 2 approved requirements/);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "B" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "  sign-off  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create baseline" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("proj-1", { name: "B", description: "sign-off" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing approved");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("new-baseline")).toBeInTheDocument();
  });
});
