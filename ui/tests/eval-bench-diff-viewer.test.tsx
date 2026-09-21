/**
 * Epic #194 (C.5) — Bench diff viewer tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BenchDiffViewer } from "@/components/eval/bench-diff-viewer";
import type { BenchTaskRow } from "@/lib/eval-api";

function mkTask(over: Partial<BenchTaskRow> = {}): BenchTaskRow {
  return {
    id: "t1",
    taskId: "task-1",
    passed: false,
    score: 0,
    tokens: 0,
    costCents: 0,
    latencyMs: 0,
    expected: null,
    actual: null,
    error: null,
    ...over,
  };
}

describe("BenchDiffViewer", () => {
  it("renders admin-only fallbacks when content is null", () => {
    render(<BenchDiffViewer task={mkTask()} />);
    expect(screen.getByTestId("diff-expected-empty")).toBeInTheDocument();
    expect(screen.getByTestId("diff-actual-empty")).toBeInTheDocument();
  });

  it("renders both expected and actual content", () => {
    render(
      <BenchDiffViewer task={mkTask({ expected: "EXPECTED CONTENT", actual: "ACTUAL CONTENT" })} />,
    );
    expect(screen.getByTestId("diff-expected")).toHaveTextContent("EXPECTED CONTENT");
    expect(screen.getByTestId("diff-actual")).toHaveTextContent("ACTUAL CONTENT");
  });
});
