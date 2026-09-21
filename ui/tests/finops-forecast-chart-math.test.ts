/**
 * Unit tests for the FinOps forecast-chart SVG math (Epic #47 / Issue #54).
 */
import { describe, expect, it } from "vitest";
import {
  plotPoints,
  referenceLineY,
  toPolyline,
  type ChartPoint,
} from "@/components/finops/forecast-chart-math";

const DIMS = { width: 100, height: 100, padding: 10 };

describe("plotPoints", () => {
  it("returns an empty array for no points", () => {
    expect(plotPoints([], DIMS)).toEqual([]);
  });

  it("centers a single point horizontally", () => {
    const out = plotPoints([{ label: "a", value: 50 }], DIMS);
    expect(out).toHaveLength(1);
    // usable width 80, centered → padding + 40 = 50
    expect(out[0].x).toBeCloseTo(50, 6);
  });

  it("spreads multiple points across the usable width", () => {
    const points: ChartPoint[] = [
      { label: "a", value: 0 },
      { label: "b", value: 100 },
    ];
    const out = plotPoints(points, DIMS);
    expect(out[0].x).toBeCloseTo(10, 6); // left edge
    expect(out[1].x).toBeCloseTo(90, 6); // right edge
    // value 0 → bottom; value 100 (==max) → top
    expect(out[0].y).toBeCloseTo(90, 6);
    expect(out[1].y).toBeCloseTo(10, 6);
  });

  it("honours a max override so a budget line shares the scale", () => {
    const out = plotPoints([{ label: "a", value: 50 }], DIMS, 100);
    // 50/100 ratio → midway: padding + 80*(1-0.5) = 10 + 40 = 50
    expect(out[0].y).toBeCloseTo(50, 6);
  });
});

describe("toPolyline", () => {
  it("formats plotted points into an SVG points string", () => {
    const out = plotPoints(
      [
        { label: "a", value: 0 },
        { label: "b", value: 100 },
      ],
      DIMS,
    );
    expect(toPolyline(out)).toBe("10.00,90.00 90.00,10.00");
  });
});

describe("referenceLineY", () => {
  it("places the budget line on the same scale", () => {
    const points: ChartPoint[] = [{ label: "a", value: 200 }];
    // budget 100 with max 200 → 50% → midway
    expect(referenceLineY(100, points, DIMS)).toBeCloseTo(50, 6);
  });

  it("clamps a budget above the max to the top", () => {
    const points: ChartPoint[] = [{ label: "a", value: 50 }];
    expect(referenceLineY(1000, points, DIMS)).toBeCloseTo(10, 6); // top (padding)
  });
});
