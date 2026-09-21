/**
 * Tests for `<CoverageMatrix />` (Epic #856 issue #868).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub the virtualizer — jsdom has no real layout, so the real
// `useVirtualizer` would emit zero virtual items. The stub passes through
// every requirement / test-case so we can assert on cells directly.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => {
    const size = opts.estimateSize();
    const items = Array.from({ length: opts.count }, (_, index) => ({
      index,
      key: index,
      start: index * size,
      end: (index + 1) * size,
      size,
      lane: 0,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * size,
    };
  },
}));

import { CoverageMatrix } from "@/components/test-coverage/coverage-matrix";

const reqs = Array.from({ length: 3 }, (_, i) => ({
  id: `r${i}`,
  title: `Requirement ${i}`,
}));
const tcs = Array.from({ length: 3 }, (_, i) => ({
  id: `t${i}`,
  title: `TestCase ${i}`,
}));
const cells = [
  { requirementId: "r0", testCaseId: "t0", score: 0.95 },
  { requirementId: "r0", testCaseId: "t1", score: 0.6 },
  { requirementId: "r1", testCaseId: "t2", score: 0.2 },
];

describe("<CoverageMatrix />", () => {
  it("renders a grid with the right row/col count", () => {
    render(<CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} />);
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "4");
    expect(grid).toHaveAttribute("aria-colcount", "4");
  });

  it("colour-codes cells by score band", () => {
    render(<CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} />);
    const covered = screen.getByLabelText(/Requirement 0 × TestCase 0: score 0\.95/);
    const partial = screen.getByLabelText(/Requirement 0 × TestCase 1: score 0\.60/);
    const uncovered = screen.getByLabelText(/Requirement 1 × TestCase 2: score 0\.20/);
    expect(covered.className).toContain("bg-green");
    expect(partial.className).toContain("bg-amber");
    expect(uncovered.className).toContain("bg-red");
  });

  it("renders empty cell for missing mapping", () => {
    render(<CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} />);
    const empty = screen.getByLabelText(/Requirement 2 × TestCase 0: no mapping/);
    expect(empty.textContent).toBe("");
  });

  it("invokes onCellClick with the cell coords + score", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} onCellClick={onClick} />,
    );
    await user.click(screen.getByLabelText(/Requirement 0 × TestCase 0: score 0\.95/));
    expect(onClick).toHaveBeenCalledWith({
      requirementId: "r0",
      testCaseId: "t0",
      score: 0.95,
    });
  });

  it("handles large grids without crashing", { timeout: 15000 }, () => {
    // 60x60 = 3,600 cells — large enough to exercise the full N×M render path and
    // catch crash/keying regressions, but fast and CI-stable. The previous 200x200
    // (40k cells) took ~16s to render in jsdom and flaked against the 15s timeout
    // under CI load (this suite runs in BOTH the `api` and `ui` jobs).
    const bigReqs = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      title: `R${i}`,
    }));
    const bigTcs = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      title: `T${i}`,
    }));
    render(<CoverageMatrix requirements={bigReqs} testCases={bigTcs} cells={[]} />);
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "61");
  });
});
