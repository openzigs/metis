"use client";

/**
 * Virtualized requirement × test-case coverage matrix (Epic #856 issue #868).
 *
 * Uses `@tanstack/react-virtual` to keep DOM size bounded for grids
 * containing thousands of cells. Cells colour-code on `score`:
 *
 *   score ≥ 0.8  → green (covered)
 *   score ≥ 0.5  → amber (partial)
 *   score <  0.5 → red   (uncovered)
 *
 * Cells without a mapping render empty (neutral background).
 */
import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { cn } from "@/lib/utils";

export interface MatrixRequirement {
  id: string;
  title: string;
}

export interface MatrixTestCase {
  id: string;
  title: string;
}

export interface MatrixCellValue {
  requirementId: string;
  testCaseId: string;
  score: number;
}

export interface CoverageMatrixProps {
  requirements: ReadonlyArray<MatrixRequirement>;
  testCases: ReadonlyArray<MatrixTestCase>;
  cells: ReadonlyArray<MatrixCellValue>;
  onCellClick?: (cell: { requirementId: string; testCaseId: string; score: number | null }) => void;
}

const ROW_HEIGHT = 36;
const COL_WIDTH = 48;
const REQ_COL_WIDTH = 280;
const HEADER_HEIGHT = 36;

function scoreClass(score: number): string {
  if (score >= 0.8) return "bg-green-500/80 text-white";
  if (score >= 0.5) return "bg-amber-500/80 text-white";
  return "bg-red-500/80 text-white";
}

export function CoverageMatrix({
  requirements,
  testCases,
  cells,
  onCellClick,
}: CoverageMatrixProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const cellIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells) m.set(`${c.requirementId}::${c.testCaseId}`, c.score);
    return m;
  }, [cells]);

  const rowVirt = useVirtualizer({
    count: requirements.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const colVirt = useVirtualizer({
    count: testCases.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => COL_WIDTH,
    horizontal: true,
    overscan: 4,
  });

  return (
    <div
      ref={parentRef}
      className="relative overflow-auto border border-border rounded-md"
      style={{ height: 480 }}
      data-testid="coverage-matrix"
      role="grid"
      aria-rowcount={requirements.length + 1}
      aria-colcount={testCases.length + 1}
    >
      {/* sticky top-left corner */}
      <div
        className="sticky top-0 left-0 z-30 bg-card border-b border-r border-border text-xs font-semibold flex items-center px-3"
        style={{
          width: REQ_COL_WIDTH,
          height: HEADER_HEIGHT,
        }}
      >
        Requirement
      </div>

      {/* sticky header row */}
      <div
        className="sticky top-0 z-20 bg-card border-b border-border"
        style={{
          left: REQ_COL_WIDTH,
          height: HEADER_HEIGHT,
          width: colVirt.getTotalSize(),
          position: "sticky",
        }}
      >
        {colVirt.getVirtualItems().map((col) => {
          const tc = testCases[col.index];
          return (
            <div
              key={tc.id}
              role="columnheader"
              title={tc.title}
              className="absolute top-0 flex items-center justify-center text-[10px] font-medium text-muted-foreground border-r border-border px-1 truncate"
              style={{
                left: col.start,
                width: col.size,
                height: HEADER_HEIGHT,
              }}
            >
              {tc.title.length > 12 ? `${tc.title.slice(0, 12)}…` : tc.title}
            </div>
          );
        })}
      </div>

      {/* virtualised rows */}
      <div
        style={{
          height: rowVirt.getTotalSize(),
          width: REQ_COL_WIDTH + colVirt.getTotalSize(),
          position: "relative",
        }}
      >
        {rowVirt.getVirtualItems().map((row) => {
          const req = requirements[row.index];
          return (
            <div
              key={req.id}
              role="row"
              className="absolute left-0 right-0"
              style={{
                top: row.start,
                height: row.size,
              }}
            >
              {/* sticky requirement column */}
              <div
                className="sticky left-0 z-10 bg-card border-r border-b border-border text-xs flex items-center px-3 truncate"
                style={{
                  width: REQ_COL_WIDTH,
                  height: row.size,
                }}
                title={req.title}
                role="rowheader"
              >
                {req.title}
              </div>

              {colVirt.getVirtualItems().map((col) => {
                const tc = testCases[col.index];
                const score = cellIndex.get(`${req.id}::${tc.id}`) ?? null;
                const cls = score === null ? "bg-muted/30" : scoreClass(score);
                return (
                  <button
                    key={tc.id}
                    type="button"
                    role="gridcell"
                    aria-label={`${req.title} × ${tc.title}: ${
                      score === null ? "no mapping" : `score ${score.toFixed(2)}`
                    }`}
                    className={cn(
                      "absolute border-r border-b border-border text-[10px] flex items-center justify-center transition",
                      cls,
                      onCellClick && "hover:ring-2 hover:ring-primary cursor-pointer",
                    )}
                    style={{
                      left: REQ_COL_WIDTH + col.start,
                      width: col.size,
                      height: row.size,
                    }}
                    onClick={() =>
                      onCellClick?.({
                        requirementId: req.id,
                        testCaseId: tc.id,
                        score,
                      })
                    }
                  >
                    {score === null ? "" : score.toFixed(2)}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
