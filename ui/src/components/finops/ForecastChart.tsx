"use client";

/**
 * FinOps forecast chart (Epic #47 / Issue #54).
 *
 * Pure SVG line chart of the projected month-end spend vs the configured
 * budget. No chart library — geometry comes from `forecast-chart-math.ts`,
 * matching the project's existing hand-rolled chart convention.
 */
import { formatCents, type CostForecast } from "@/lib/finops-api";
import { plotPoints, referenceLineY, toPolyline, type ChartPoint } from "./forecast-chart-math";

interface Props {
  forecast: CostForecast | null;
  budgetCents: number | null;
}

const DIMS = { width: 480, height: 180, padding: 24 };

export function ForecastChart({ forecast, budgetCents }: Props) {
  if (!forecast) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">Spend Forecast</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          No forecast computed yet. Forecasts are recomputed nightly.
        </p>
      </div>
    );
  }

  // Two-point projection: month-to-date actual → projected month-end.
  const points: ChartPoint[] = [
    { label: "MTD", value: forecast.monthToDateCents },
    { label: "Projected", value: forecast.projectedMonthEndCents },
  ];
  const maxOverride = budgetCents ?? undefined;
  const plotted = plotPoints(points, DIMS, maxOverride);
  const budgetY =
    budgetCents != null ? referenceLineY(budgetCents, points, DIMS, maxOverride) : null;
  const overBudget = budgetCents != null && forecast.projectedMonthEndCents > budgetCents;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Spend Forecast</h3>
        <span className={`text-xs font-medium ${overBudget ? "text-red-500" : "text-green-600"}`}>
          {overBudget ? "Over budget" : "On track"}
        </span>
      </div>

      <svg
        width="100%"
        viewBox={`0 0 ${DIMS.width} ${DIMS.height}`}
        role="img"
        aria-label="Projected month-end spend"
        className="overflow-visible"
      >
        {budgetY != null && (
          <line
            x1={DIMS.padding}
            x2={DIMS.width - DIMS.padding}
            y1={budgetY}
            y2={budgetY}
            stroke="#ef4444"
            strokeDasharray="4 3"
            strokeWidth={1}
          />
        )}
        <polyline
          points={toPolyline(plotted)}
          fill="none"
          stroke={overBudget ? "#ef4444" : "#2563eb"}
          strokeWidth={2}
        />
        {plotted.map((p) => (
          <g key={p.label}>
            <circle cx={p.x} cy={p.y} r={4} fill={overBudget ? "#ef4444" : "#2563eb"}>
              <title>{`${p.label}: ${formatCents(p.value)}`}</title>
            </circle>
            <text
              x={p.x}
              y={DIMS.height - 4}
              textAnchor="middle"
              className="fill-current text-[10px] text-muted-foreground"
            >
              {p.label}
            </text>
          </g>
        ))}
      </svg>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Month to date</dt>
          <dd className="font-mono">{formatCents(forecast.monthToDateCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Projected</dt>
          <dd className="font-mono">{formatCents(forecast.projectedMonthEndCents)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Run-rate / day</dt>
          <dd className="font-mono">{formatCents(forecast.dailyRunRateCents)}</dd>
        </div>
      </dl>
      {forecast.backtestMape != null && (
        <p className="text-xs text-muted-foreground">
          Backtest accuracy (MAPE): {(forecast.backtestMape * 100).toFixed(1)}%
        </p>
      )}
    </div>
  );
}
