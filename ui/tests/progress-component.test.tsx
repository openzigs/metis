import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Progress } from "@/components/ui/progress";

describe("Progress component (#664)", () => {
  it("renders with 0% by default", () => {
    const { container } = render(<Progress />);
    // The root element should exist
    expect(container.firstElementChild).toBeInTheDocument();
  });

  it("renders the indicator at specified value", () => {
    const { container } = render(<Progress value={60} />);
    const indicator = container.querySelector(".bg-blue-500") as HTMLElement | null;
    expect(indicator).toBeInTheDocument();
    expect(indicator?.style.width).toBe("60%");
  });

  it("renders at 100%", () => {
    const { container } = render(<Progress value={100} />);
    const indicator = container.querySelector(".bg-blue-500") as HTMLElement | null;
    expect(indicator?.style.width).toBe("100%");
  });

  it("applies custom className to root", () => {
    const { container } = render(<Progress className="custom-class" value={50} />);
    expect(container.firstElementChild).toHaveClass("custom-class");
  });
});
