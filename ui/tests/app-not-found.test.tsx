/**
 * Issue #430 — branded application-wide 404.
 *
 * The root `app/not-found.tsx` is what Next.js renders for *unmatched* URLs
 * (e.g. `/projects/{id}/code`). It must show app branding and a working
 * home/back action — not the bare built-in Next 404.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import NotFound from "@/app/not-found";

describe("app-level branded 404 (not-found.tsx)", () => {
  it("renders a branded 404 with the METIS mark and a 'not found' message", () => {
    render(<NotFound />);
    expect(screen.getByTestId("app-not-found")).toBeInTheDocument();
    // Branding present (app chrome, not a bare Next 404).
    expect(screen.getByText("METIS")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
  });

  it("exposes a working back/home action pointing at the dashboard", () => {
    render(<NotFound />);
    const homeAction = screen.getByTestId("app-not-found-home");
    expect(homeAction).toHaveAttribute("href", "/dashboard");
    expect(homeAction).toHaveTextContent(/back to dashboard/i);
  });

  it("announces itself as an alert for assistive tech", () => {
    render(<NotFound />);
    expect(screen.getByRole("alert")).toBe(screen.getByTestId("app-not-found"));
  });
});
