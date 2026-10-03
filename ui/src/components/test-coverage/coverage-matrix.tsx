"use client";

/**
 * Virtualized requirement × test-case coverage matrix (Epic #856 issue #868).
 *
 * Uses `@tanstack/react-virtual` to keep DOM size bounded for grids
 * containing thousands of cells. #794 — cells colour-code on the mapping's
 * persisted `status` (the matcher's, the judge's or a reviewer's verdict),
 * not on a score band: the RRF `fused` score the cells used to show is
 * ~0.01–0.02 and could never reach a "≥ 0.8 covered" band, so every cell
 * read red. The number shown is the judge's confidence where it ran, else the
 * cosine similarity.
 *
 *   COVERED / OVERRIDDEN → green
 *   AMBIGUOUS            → amber
 *   UNCOVERED            → red
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
  /** `COVERED|UNCOVERED|AMBIGUOUS|OVERRIDDEN` — what the cell is coloured by. */
  status: string;
  /** The coverage mapping behind the cell, for an override. */
  mappingId?: string;
}

export interface MatrixCellClick {
  requirementId: string;
  testCaseId: string;
  score: number | null;
  status: string | null;
  mappingId: string | null;
}

export interface CoverageMatrixProps {
  requirements: ReadonlyArray<MatrixRequirement>;
  testCases: ReadonlyArray<MatrixTestCase>;
  cells: ReadonlyArray<MatrixCellValue>;
  onCellClick?: (cell: MatrixCellClick) => void;
}

const ROW_HEIGHT = 36;
const COL_WIDTH = 48;
const REQ_COL_WIDTH = 280;
const HEADER_HEIGHT = 36;

export function statusClass(status: string): string {
  if (status === "COVERED" || status === "OVERRIDDEN")
    return "bg-success/80 text-success-foreground";
  if (status === "AMBIGUOUS") return "bg-warning/80 text-warning-foreground";
  return "bg-destructive/80 text-destructive-foreground";
}

export function CoverageMatrix({
  requirements,
  testCases,
  cells,
  onCellClick,
}: CoverageMatrixProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const cellIndex = useMemo(() => {
    const m = new Map<string, MatrixCellValue>();
    for (const c of cells) m.set(`${c.requirementId}::${c.testCaseId}`, c);
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
                const cell = cellIndex.get(`${req.id}::${tc.id}`) ?? null;
                const score = cell?.score ?? null;
                const cls = cell === null ? "bg-muted/30" : statusClass(cell.status);
                return (
                  <button
                    key={tc.id}
                    type="button"
                    role="gridcell"
                    aria-label={`${req.title} × ${tc.title}: ${
                      cell === null
                        ? "no mapping"
                        : `${cell.status.toLowerCase()}, score ${cell.score.toFixed(2)}`
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
                        status: cell?.status ?? null,
                        mappingId: cell?.mappingId ?? null,
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
