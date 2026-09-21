/**
 * Epic #1316 / issue #1321 — online-eval faithfulness trend.
 *
 * Pure SVG, mirroring `domain-trend-chart.tsx`. Plots the mean faithfulness of
 * each completed window over time and flags any window that raised a drift
 * alert with a hollow red marker.
 *
 * Windows scored by a lexical stub judge (#1317) are drawn differently on
 * purpose: an amber hollow square on a dashed segment, never a plain point on
 * the solid line. Scores from two different judges are not the same
 * measurement, and a single continuous line across the #1317 cutover would
 * read as one trend when it is two.
 *
 * A window whose mean faithfulness is `null` is UNVERIFIABLE and is NOT
 * plotted (#1329). `null` is not a low score, and every arithmetic route to a
 * y-coordinate turns it into one — `1 - null` is `1`, which lands the point on
 * the floor of the chart and draws a judge outage as a total collapse.
 */
"use client";

import type { OnlineEvalWindowSummary } from "@/lib/eval-api";

export interface OnlineTrendChartProps {
  windows: OnlineEvalWindowSummary[];
  width?: number;
  height?: number;
}

function clamp(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Narrows a window to one that actually has a faithfulness measurement. */
type PlottableWindow = OnlineEvalWindowSummary & { meanScores: { faithfulness: number } };

function isPlottable(w: OnlineEvalWindowSummary): w is PlottableWindow {
  return typeof w.meanScores.faithfulness === "number";
}

export function OnlineTrendChart({ windows, width = 480, height = 140 }: OnlineTrendChartProps) {
  // Drop unverifiable windows BEFORE the count check: two windows neither of
  // which was scored are not a trend (#1329).
  const plottable = windows.filter(isPlottable);
  const dropped = windows.length - plottable.length;
  if (plottable.length < 2) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="online-trend-empty">
        Need at least two completed windows with a measured faithfulness to render a trend.
        {dropped > 0 ? ` ${dropped} window(s) were unverifiable and are not plotted.` : ""}
      </p>
    );
  }
  const sorted = [...plottable].sort(
    (a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime(),
  );
  const padding = 16;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const stepX = innerWidth / (sorted.length - 1);
  const coord = (w: PlottableWindow, i: number) => ({
    x: padding + i * stepX,
    y: padding + innerHeight * (1 - clamp(w.meanScores.faithfulness)),
  });
  // Split into runs of same-honesty windows so the polyline for stub windows is
  // dashed and never joins a real-judge run with a solid stroke.
  const segments: { meaningful: boolean; points: string[] }[] = [];
  sorted.forEach((w, i) => {
    const { x, y } = coord(w, i);
    const point = `${x.toFixed(1)},${y.toFixed(1)}`;
    const last = segments[segments.length - 1];
    if (last && last.meaningful === w.judgeMeaningful) {
      last.points.push(point);
    } else {
      // Repeat the joining point so consecutive runs stay visually connected.
      const bridge = last ? [last.points[last.points.length - 1] as string] : [];
      segments.push({ meaningful: w.judgeMeaningful, points: [...bridge, point] });
    }
  });
  return (
    <svg
      role="img"
      aria-label="Mean faithfulness on sampled live runs over time"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      data-testid="online-trend-chart"
      className="block"
    >
      <rect x="0" y="0" width={width} height={height} className="fill-muted/30" />
      {segments.map((seg, i) => (
        <polyline
          key={`seg-${i}`}
          points={seg.points.join(" ")}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray={seg.meaningful ? undefined : "4 3"}
          className={seg.meaningful ? "text-primary" : "text-yellow-600"}
          data-testid={`online-trend-segment-${i}`}
          data-judge-meaningful={seg.meaningful ? "true" : "false"}
        />
      ))}
      {sorted.map((w, i) => {
        const { x, y } = coord(w, i);
        const r = w.driftAlert ? 5 : 3;
        const shared = {
          className: w.driftAlert
            ? "text-red-600"
            : w.judgeMeaningful
              ? "fill-primary text-primary"
              : "text-yellow-600",
          "data-testid": `online-point-${w.windowId}`,
          "data-drift-alert": w.driftAlert ? "true" : "false",
          "data-judge-meaningful": w.judgeMeaningful ? "true" : "false",
        };
        const label = `${w.windowId}: faithfulness ${(w.meanScores.faithfulness * 100).toFixed(1)}%${
          w.judgeMeaningful ? "" : ` — stub judge (${w.judge}), not a quality signal`
        }`;
        // Stub windows get a hollow square: distinguishable from a real-judge
        // point without relying on colour alone.
        return w.judgeMeaningful ? (
          <circle
            key={w.windowId}
            cx={x}
            cy={y}
            r={r}
            fill={w.driftAlert ? "none" : "currentColor"}
            stroke={w.driftAlert ? "currentColor" : "none"}
            strokeWidth={w.driftAlert ? 2 : 0}
            {...shared}
          >
            <title>{label}</title>
          </circle>
        ) : (
          <rect
            key={w.windowId}
            x={x - r}
            y={y - r}
            width={r * 2}
            height={r * 2}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            {...shared}
          >
            <title>{label}</title>
          </rect>
        );
      })}
    </svg>
  );
}
