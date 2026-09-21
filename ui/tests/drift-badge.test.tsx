/**
 * Tests for DriftBadge component.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DriftBadge } from "@/components/sync/drift-badge";

const PUSH_MOCK = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: PUSH_MOCK, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/projects/p1/overview",
}));

describe("DriftBadge", () => {
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

  it("has correct aria-label", () => {
    render(<DriftBadge projectId="p1" count={1} />);
    expect(screen.getByLabelText("1 pending drift events")).toBeInTheDocument();
  });

  it("updates count when prop changes", () => {
    const { rerender } = render(<DriftBadge projectId="p1" count={2} />);
    expect(screen.getByText("2")).toBeInTheDocument();
    rerender(<DriftBadge projectId="p1" count={7} />);
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
