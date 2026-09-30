/**
 * Issue #30 — Previous / Next paging for the Analysis page's long lists.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ListPager } from "./ListPager";
import { paginate } from "./analysis-views";

const items = Array.from({ length: 45 }, (_, i) => i);

describe("ListPager (#30)", () => {
  it("renders nothing when everything fits on one page", () => {
    const { container } = render(
      <ListPager
        page={paginate(items.slice(0, 20), 0, 20)}
        noun="findings"
        onPageChange={vi.fn()}
        testId="p"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the range and moves forward and back", () => {
    const onPageChange = vi.fn();
    render(
      <ListPager
        page={paginate(items, 1, 20)}
        noun="findings"
        onPageChange={onPageChange}
        testId="p"
      />,
    );
    expect(screen.getByTestId("p-range")).toHaveTextContent("Showing 21–40 of 45 findings");
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenLastCalledWith(0);
  });

  it("disables Previous on the first page and Next on the last", () => {
    const { rerender } = render(
      <ListPager page={paginate(items, 0, 20)} noun="findings" onPageChange={vi.fn()} testId="p" />,
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    rerender(
      <ListPager page={paginate(items, 2, 20)} noun="findings" onPageChange={vi.fn()} testId="p" />,
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});
