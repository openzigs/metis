/**
 * S1 (#143) — route-segment boundary rendering (loading / error / not-found).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AuthedLoading from "@/app/(authed)/loading";
import AuthedError from "@/app/(authed)/error";
import AuthedNotFound from "@/app/(authed)/not-found";
import { ApiError } from "@/lib/api-client";

describe("authed segment boundaries", () => {
  it("loading.tsx renders announced skeletons (no bare 'Loading…' paragraph)", () => {
    render(<AuthedLoading />);
    expect(screen.getByTestId("authed-loading")).toBeInTheDocument();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("error.tsx renders the shared ErrorState and wires retry to reset()", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    // Error carries a stack — must never reach the DOM.
    const err = new ApiError(500, "Boom") as Error & { digest?: string };
    err.stack = "Error: Boom\n    at leak (/srv/secret.ts:1:1)";
    render(<AuthedError error={err} reset={reset} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret.ts");
    await user.click(screen.getByTestId("error-state-retry"));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("not-found.tsx renders a 404 with an escape link", () => {
    render(<AuthedNotFound />);
    expect(screen.getByTestId("authed-not-found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });
});
