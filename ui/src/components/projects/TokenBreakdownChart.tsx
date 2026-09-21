"use client";

/**
 * Epic #511 / Issue #513 — Token breakdown chart component.
 *
 * Displays per-category token usage as a donut chart and stacked bar breakdown.
 * Fetches data from GET /api/projects/:id/token-breakdown.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsApi, type TokenBreakdownCategory } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";

interface Props {
  projectId: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  system_prompt: "#6366f1", // indigo
  tool_manifests: "#f59e0b", // amber
  tool_results: "#10b981", // emerald
  rag_context: "#3b82f6", // blue
  user_message: "#8b5cf6", // violet
  history: "#ec4899", // pink
  code_context: "#14b8a6", // teal
};

const CATEGORY_LABELS: Record<string, string> = {
  system_prompt: "System Prompt",
  tool_manifests: "Tool Manifests",
  tool_results: "Tool Results",
  rag_context: "RAG Context",
  user_message: "User Message",
  history: "History",
  code_context: "Code Context",
};

type Range = "24h" | "7d" | "30d";

function DonutChart({ categories }: { categories: TokenBreakdownCategory[] }) {
  const size = 160;
  const radius = 60;
  const innerRadius = 38;
  const center = size / 2;

  let cumulativeAngle = 0;
  const slices = categories
    .filter((c) => c.percentage > 0)
    .map((cat) => {
      const startAngle = cumulativeAngle;
      const angle = cat.percentage * 360;
      cumulativeAngle += angle;
      return { ...cat, startAngle, angle };
    });

  function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(startAngle: number, endAngle: number, r: number, ir: number) {
    const start = polarToCartesian(center, center, r, startAngle);
    const end = polarToCartesian(center, center, r, endAngle);
    const innerStart = polarToCartesian(center, center, ir, endAngle);
    const innerEnd = polarToCartesian(center, center, ir, startAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    return [
      `M ${start.x} ${start.y}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
      `L ${innerStart.x} ${innerStart.y}`,
      `A ${ir} ${ir} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
      "Z",
    ].join(" ");
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label="Token category donut chart"
    >
      {slices.map((slice) => (
        <path
          key={slice.category}
          d={describeArc(slice.startAngle, slice.startAngle + slice.angle, radius, innerRadius)}
          fill={CATEGORY_COLORS[slice.category] ?? "#94a3b8"}
        >
          <title>
            {CATEGORY_LABELS[slice.category] ?? slice.category}:{" "}
            {(slice.percentage * 100).toFixed(1)}%
          </title>
        </path>
      ))}
    </svg>
  );
}

function StackedBar({ categories }: { categories: TokenBreakdownCategory[] }) {
  return (
    <div
      className="flex h-4 w-full overflow-hidden rounded-full"
      role="img"
      aria-label="Token category stacked bar"
    >
      {categories
        .filter((c) => c.percentage > 0)
        .map((cat) => (
          <div
            key={cat.category}
            className="h-full transition-all"
            style={{
              width: `${cat.percentage * 100}%`,
              backgroundColor: CATEGORY_COLORS[cat.category] ?? "#94a3b8",
            }}
            title={`${CATEGORY_LABELS[cat.category] ?? cat.category}: ${(cat.percentage * 100).toFixed(1)}%`}
          />
        ))}
    </div>
  );
}

function TrendIndicator({ trend }: { trend: number | null }) {
  if (trend === null) return <span className="text-muted-foreground text-xs">—</span>;
  const isUp = trend > 0;
  const color = isUp ? "text-red-500" : "text-green-500";
  const arrow = isUp ? "↑" : "↓";
  return (
    <span className={`text-xs font-medium ${color}`}>
      {arrow} {Math.abs(trend * 100).toFixed(0)}%
    </span>
  );
}

export function TokenBreakdownChart({ projectId }: Props) {
  const [range, setRange] = useState<Range>("7d");

  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(projectId), "token-breakdown", range],
    queryFn: () => projectsApi.getTokenBreakdown(projectId, { range }),
  });

  const ranges: Range[] = ["24h", "7d", "30d"];

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Token Usage by Category</h3>
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                range === r
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
      {error && <p className="text-sm text-red-500">Failed to load breakdown</p>}

      {data && (
        <>
          <div className="flex items-center gap-6">
            <DonutChart categories={data.categories} />
            <div className="flex-1 space-y-1">
              <p className="text-2xl font-bold">{data.totalTokens.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">total tokens ({range})</p>
            </div>
          </div>

          <StackedBar categories={data.categories} />

          <div className="space-y-2">
            {data.categories.map((cat) => (
              <div key={cat.category} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: CATEGORY_COLORS[cat.category] ?? "#94a3b8" }}
                  />
                  <span>{CATEGORY_LABELS[cat.category] ?? cat.category}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs">{cat.tokens.toLocaleString()}</span>
                  <span className="text-muted-foreground text-xs w-10 text-right">
                    {(cat.percentage * 100).toFixed(0)}%
                  </span>
                  <TrendIndicator trend={cat.trend} />
                </div>
              </div>
            ))}
          </div>

          {data.suggestions.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-200 mb-1">
                Optimization Suggestions
              </p>
              <ul className="list-disc pl-4 text-xs text-amber-700 dark:text-amber-300 space-y-0.5">
                {data.suggestions.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
