/**
 * S4 (#145) — <ErrorState /> rendering, retry, and redaction tests.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorState } from "@/components/ui/error-state";
import { ApiError } from "@/lib/api-client";

describe("<ErrorState />", () => {
  it("renders an alert with title and a safe message", () => {
    render(<ErrorState error={new ApiError(404, "")} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("aria-live", "assertive");
    expect(screen.getByText(/couldn't find/i)).toBeInTheDocument();
  });

  it("wires the retry button to onRetry", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorState error={new Error("nope")} onRetry={onRetry} />);
    await user.click(screen.getByTestId("error-state-retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders an escape link by default and hides it when homeHref is null", () => {
    const { rerender } = render(<ErrorState error={new Error("x")} />);
    expect(screen.getByTestId("error-state-home")).toHaveAttribute("href", "/dashboard");
    rerender(<ErrorState error={new Error("x")} homeHref={null} />);
    expect(screen.queryByTestId("error-state-home")).not.toBeInTheDocument();
  });

  it("does NOT render stack traces or secrets in the DOM", () => {
    const err = new Error(
      "Failed with token=eyJhbGciOiJ.IUzI1NiJ.s5d8Fabcd at /srv/app/secret.ts:42:13",
    );
    err.stack = `Error\n    at leak (/srv/app/secret.ts:42:13)`;
    const { container } = render(<ErrorState error={err} />);
    expect(container.textContent).not.toContain("eyJhbGciOiJ");
    expect(container.textContent).not.toContain("secret.ts");
    expect(container.textContent).not.toContain("at leak");
  });

  it("prefers an explicit safe description over the error", () => {
    render(
      <ErrorState error={new Error("raw internal detail")} description="Couldn't load data." />,
    );
    expect(screen.getByText("Couldn't load data.")).toBeInTheDocument();
    expect(screen.queryByText("raw internal detail")).not.toBeInTheDocument();
  });
});
