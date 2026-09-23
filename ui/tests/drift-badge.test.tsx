/**
 * Tests for DriftBadge component.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DriftBadge } from "@/components/sync/drift-badge";

const PUSH_MOCK = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: PUSH_MOCK, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects/p1/overview",
}));

describe("DriftBadge", () => {
  beforeEach(() => PUSH_MOCK.mockClear());

  it("renders nothing when count is 0", () => {
    const { container } = render(<DriftBadge projectId="p1" count={0} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders the count when > 0", () => {
    render(<DriftBadge projectId="p1" count={3} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("navigates to sync page on click", async () => {
    const user = userEvent.setup();
    render(<DriftBadge projectId="p1" count={5} />);
    await user.click(screen.getByText("5"));
    expect(PUSH_MOCK).toHaveBeenCalledWith("/projects/p1/sync");
  });

  it("navigates with requirementId filter when provided", async () => {
    const user = userEvent.setup();
    render(<DriftBadge projectId="p1" count={2} requirementId="req-42" />);
    await user.click(screen.getByText("2"));
    expect(PUSH_MOCK).toHaveBeenCalledWith("/projects/p1/sync?requirementId=req-42");
  });

  it("is a button whose accessible name carries the count (#90)", () => {
    const { rerender } = render(<DriftBadge projectId="p1" count={1} />);
    expect(screen.getByRole("button", { name: "View 1 pending drift event" })).toBeInTheDocument();
    rerender(<DriftBadge projectId="p1" count={4} />);
    expect(screen.getByRole("button", { name: "View 4 pending drift events" })).toBeInTheDocument();
    // A control, not a live region: `role="status"` announced it as one.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is reachable by Tab and activated by Enter — keyboard only (#90)", async () => {
    const user = userEvent.setup();
    render(<DriftBadge projectId="p1" count={3} />);
    await user.tab();
    expect(screen.getByRole("button", { name: /3 pending drift events/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(PUSH_MOCK).toHaveBeenCalledWith("/projects/p1/sync");
  });

  it("is activated by Space — keyboard only (#90)", async () => {
    const user = userEvent.setup();
    render(<DriftBadge projectId="p1" count={2} requirementId="req-7" />);
    await user.tab();
    await user.keyboard(" ");
    expect(PUSH_MOCK).toHaveBeenCalledWith("/projects/p1/sync?requirementId=req-7");
  });

  it("does not submit an enclosing form (type=button)", async () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const user = userEvent.setup();
    render(
      <form onSubmit={onSubmit}>
        <DriftBadge projectId="p1" count={1} />
      </form>,
    );
    await user.click(screen.getByRole("button"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("updates count when prop changes", () => {
    const { rerender } = render(<DriftBadge projectId="p1" count={2} />);
    expect(screen.getByText("2")).toBeInTheDocument();
    rerender(<DriftBadge projectId="p1" count={7} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
