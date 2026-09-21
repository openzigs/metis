/**
 * #1296 — the AGPL-3.0 §13 source offer on the sign-in page.
 *
 * §13 says "all users interacting with it remotely", not "all signed-in users". The
 * sign-in page is the entire surface an unauthenticated visitor can see, so the offer
 * has to be there. Asserted separately from `<AppShell />` because the two mount
 * points are independent: removing either leaves the other's test green.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import LoginPage from "@/app/login/page";
import { makeWrapper } from "./test-utils";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoginPage — AGPL §13 source offer", () => {
  it("offers the source to a visitor who has not signed in", () => {
    render(<LoginPage />, { wrapper: makeWrapper({ initialUser: null }) });
    expect(screen.getByTestId("source-offer-footer")).toBeInTheDocument();
    expect(screen.getByTestId("source-offer-link")).toHaveAttribute(
      "href",
      "https://github.com/openzigs/metis",
    );
  });

  it("still renders the sign-in form beside it", () => {
    render(<LoginPage />, { wrapper: makeWrapper({ initialUser: null }) });
    expect(screen.getByRole("main")).toBeInTheDocument();
  });
});
