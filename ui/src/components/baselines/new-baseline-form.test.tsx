/**
 * #1137 — New baseline says how many requirements it will pin, of which
 * status, and how many unapproved imported items it leaves out, before it is
 * created.
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

const RUN8_SENTENCE =
  "Pins the current version of 30 requirements in this project: 19 approved, 11 not yet approved. 266 items imported from a tracker and not approved are left out.";

describe("describeBaselineScope", () => {
  it("names the count, the statuses and the imported items left out", () => {
    expect(describeBaselineScope({ pinCount: 30, approved: 19, excludedImported: 266 })).toBe(
      RUN8_SENTENCE,
    );
  });

  it("handles one, none and nothing left out", () => {
    expect(describeBaselineScope({ pinCount: 1, approved: 0, excludedImported: 0 })).toBe(
      "Pins the current version of 1 requirement in this project: 0 approved, 1 not yet approved.",
    );
    expect(describeBaselineScope({ pinCount: 0, approved: 0, excludedImported: 1 })).toBe(
      "There is nothing to pin yet. 1 item imported from a tracker and not approved is left out.",
    );
  });
});

describe("NewBaselineForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => cleanup());

  it("fetches the scope only once opened, and shows it before creating", async () => {
    scope.mockResolvedValue({ pinCount: 30, approved: 19, excludedImported: 266 });
    create.mockResolvedValue({ id: "b-1" });
    renderForm();
    expect(scope).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("new-baseline"));
    await waitFor(() =>
      expect(screen.getByTestId("new-baseline-scope")).toHaveTextContent(RUN8_SENTENCE),
    );
    expect(scope).toHaveBeenCalledWith("proj-1");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Run 8" } });
    fireEvent.click(screen.getByRole("button", { name: "Create baseline" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("proj-1", { name: "Run 8" }));
  });

  it("disables Create when there is nothing to pin", async () => {
    scope.mockResolvedValue({ pinCount: 0, approved: 0, excludedImported: 3 });
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
        "Pins the current version of the project's requirements, except unapproved imported items.",
      ),
    );
  });

  it("sends the description, shows a refusal, and closes on Cancel", async () => {
    const { ApiError } = await import("@/lib/api-client");
    scope.mockResolvedValue({ pinCount: 2, approved: 2, excludedImported: 0 });
    create.mockRejectedValue(new ApiError(400, "Name taken", "BASELINE_NAME_TAKEN"));
    renderForm();
    fireEvent.click(screen.getByTestId("new-baseline"));
    await screen.findByText(/2 requirements in this project/);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "B" } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), {
      target: { value: "  sign-off  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create baseline" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("proj-1", { name: "B", description: "sign-off" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Name taken");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("new-baseline")).toBeInTheDocument();
  });
});
