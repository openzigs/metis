/**
 * #1626 — the entry links from a product and from an approved requirement.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PortfolioCheckLink,
  portfolioCheckHref,
} from "@/components/portfolio/portfolio-check-link";

describe("portfolioCheckHref", () => {
  it("carries the product", () => {
    expect(portfolioCheckHref({ productId: "p 1" })).toBe("/portfolio?productId=p+1");
  });

  it("carries the requirement id and a bounded, encoded title", () => {
    const href = portfolioCheckHref({ requirementId: "req-1", title: `a&b=${"x".repeat(300)}` });
    const params = new URL(href, "http://x").searchParams;
    expect(params.get("requirementId")).toBe("req-1");
    expect(params.get("title")).toBe(`a&b=${"x".repeat(196)}`);
  });
});

describe("PortfolioCheckLink", () => {
  it("renders a named link to the page", () => {
    render(<PortfolioCheckLink from={{ productId: "p1" }} />);
    expect(screen.getByRole("link", { name: "Check across portfolio" })).toHaveAttribute(
      "href",
      "/portfolio?productId=p1",
    );
  });
});
