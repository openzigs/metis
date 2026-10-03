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
  { requirementId: "r0", testCaseId: "t0", score: 0.95, status: "COVERED", mappingId: "m0" },
  { requirementId: "r0", testCaseId: "t1", score: 0.6, status: "AMBIGUOUS", mappingId: "m1" },
  { requirementId: "r1", testCaseId: "t2", score: 0.2, status: "UNCOVERED", mappingId: "m2" },
  // #794 — a reviewer override reads covered whatever its score.
  { requirementId: "r1", testCaseId: "t0", score: 0.55, status: "OVERRIDDEN", mappingId: "m3" },
];

describe("<CoverageMatrix />", () => {
  it("renders a grid with the right row/col count", () => {
    render(<CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} />);
    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-rowcount", "4");
    expect(grid).toHaveAttribute("aria-colcount", "4");
  });

  // #794 — by the persisted verdict, not a score band the cells can never reach.
  it("colour-codes cells by mapping status", () => {
    render(<CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} />);
    const covered = screen.getByLabelText(/Requirement 0 × TestCase 0: covered, score 0\.95/);
    const ambiguous = screen.getByLabelText(/Requirement 0 × TestCase 1: ambiguous, score 0\.60/);
    const uncovered = screen.getByLabelText(/Requirement 1 × TestCase 2: uncovered, score 0\.20/);
    const overridden = screen.getByLabelText(/Requirement 1 × TestCase 0: overridden, score 0\.55/);
    expect(covered.className).toContain("bg-success");
    expect(ambiguous.className).toContain("bg-warning");
    expect(uncovered.className).toContain("bg-destructive");
    expect(overridden.className).toContain("bg-success");
  });

  it("a low-scoring COVERED cell is still green (#794)", () => {
    render(
      <CoverageMatrix
        requirements={reqs}
        testCases={tcs}
        cells={[{ requirementId: "r2", testCaseId: "t2", score: 0.02, status: "COVERED" }]}
      />,
    );
    expect(screen.getByLabelText(/Requirement 2 × TestCase 2: covered/).className).toContain(
      "bg-success",
    );
  });

  it("renders empty cell for missing mapping", () => {
    render(<CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} />);
    const empty = screen.getByLabelText(/Requirement 2 × TestCase 0: no mapping/);
    expect(empty.textContent).toBe("");
  });

  it("invokes onCellClick with the cell coords, score, status and mapping", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <CoverageMatrix requirements={reqs} testCases={tcs} cells={cells} onCellClick={onClick} />,
    );
    await user.click(screen.getByLabelText(/Requirement 0 × TestCase 0: covered, score 0\.95/));
    expect(onClick).toHaveBeenCalledWith({
      requirementId: "r0",
      testCaseId: "t0",
      score: 0.95,
      status: "COVERED",
      mappingId: "m0",
    });
    await user.click(screen.getByLabelText(/Requirement 2 × TestCase 1: no mapping/));
    expect(onClick).toHaveBeenLastCalledWith({
      requirementId: "r2",
      testCaseId: "t1",
      score: null,
      status: null,
      mappingId: null,
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
