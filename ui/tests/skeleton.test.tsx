/**
 * S2 (#144) — Skeleton primitive + announced SkeletonText block.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";

describe("<Skeleton />", () => {
  it("is decorative (aria-hidden) and animated, honoring reduced motion", () => {
    const { container } = render(<Skeleton className="h-4 w-10" data-testid="sk" />);
    const el = container.querySelector('[data-testid="sk"]') as HTMLElement;
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("motion-reduce:animate-none");
    expect(el.className).toContain("h-4");
    expect(el.className).toContain("w-10");
  });
});

describe("<SkeletonText />", () => {
  it("renders an announced loading region with visually-hidden status text", () => {
    render(<SkeletonText lines={3} />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders the requested number of placeholder lines", () => {
    render(<SkeletonText lines={5} label="Fetching data" />);
    expect(screen.getByText("Fetching data")).toBeInTheDocument();
    // 5 skeleton bars are aria-hidden divs inside the region.
    const region = screen.getByRole("status");
    const bars = region.querySelectorAll('[aria-hidden="true"]');
    expect(bars.length).toBe(5);
  });
});
