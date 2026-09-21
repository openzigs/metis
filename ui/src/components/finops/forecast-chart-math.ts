/**
 * Pure SVG-path math for the FinOps forecast chart (Epic #47 / Issue #54).
 *
 * The project favours hand-rolled SVG over a chart library (see the existing
 * TokenBreakdownChart + project usage page: "pure SVG, no chart library
 * dependency"). These helpers map a series of daily cost points to polyline
 * coordinates so the chart component stays declarative and the geometry is
 * unit-testable without a DOM.
 */

export interface ChartPoint {
  /** X label (e.g. ISO day). */
  label: string;
  /** Y value in cents. */
  value: number;
}

export interface PlottedPoint {
  x: number;
  y: number;
  label: string;
  value: number;
}

export interface PlotDims {
  width: number;
  height: number;
  padding: number;
}

/**
 * Map points to pixel coordinates within `dims`. The Y axis is inverted
 * (SVG origin top-left) and scaled to `[0, maxValue]` (or a provided max so
 * a budget line shares the scale). Returns an empty array for empty input.
 */
export function plotPoints(
  points: ChartPoint[],
  dims: PlotDims,
  maxOverride?: number,
): PlottedPoint[] {
  if (points.length === 0) return [];
  const { width, height, padding } = dims;
  const usableW = Math.max(1, width - padding * 2);
  const usableH = Math.max(1, height - padding * 2);
  const maxValue = Math.max(maxOverride ?? 0, ...points.map((p) => p.value), 1);
  const stepX = points.length === 1 ? 0 : usableW / (points.length - 1);

  return points.map((p, i) => {
    const x = padding + (points.length === 1 ? usableW / 2 : stepX * i);
    const yRatio = p.value / maxValue;
    const y = padding + usableH * (1 - yRatio);
    return { x, y, label: p.label, value: p.value };
  });
}

/** Build an SVG polyline `points` attribute string from plotted points. */
export function toPolyline(plotted: PlottedPoint[]): string {
  return plotted.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

/**
 * Compute the Y pixel for a horizontal reference line (e.g. the budget) on
 * the same scale used by `plotPoints`.
 */
export function referenceLineY(
  value: number,
  points: ChartPoint[],
  dims: PlotDims,
  maxOverride?: number,
): number {
  const { height, padding } = dims;
  const usableH = Math.max(1, height - padding * 2);
  const maxValue = Math.max(maxOverride ?? 0, ...points.map((p) => p.value), 1);
  const yRatio = Math.min(1, value / maxValue);
  return padding + usableH * (1 - yRatio);
}
