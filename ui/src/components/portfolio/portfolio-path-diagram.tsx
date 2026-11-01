/**
 * Epic #1608 (#1627) — the hop chain from a product that must change to a
 * downstream product, as a small SVG: one box per product, one labelled arrow
 * per hop. The whole chain is also its accessible name, in words.
 */
import { useId } from "react";
import { viaLabel } from "@/lib/portfolio-impact";

const BOX_W = 132;
const BOX_H = 36;
const GAP = 96;
const PAD = 4;
const NAME_MAX = 18;

function short(name: string): string {
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
}

export function PortfolioPathDiagram({
  path,
  edges,
}: {
  path: Array<{ productId: string; name: string | null }>;
  edges: string[];
}) {
  const markerId = `portfolio-path-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  if (path.length < 2) return null;
  const names = path.map((p) => p.name ?? "A product you cannot read");
  const words = names
    .map((n, i) => (i === 0 ? n : `${viaLabel(edges[i - 1]) ?? "an unclassified link"} to ${n}`))
    .join(", then ");
  const width = PAD * 2 + path.length * BOX_W + (path.length - 1) * GAP;
  const height = BOX_H + PAD * 2 + 16;
  return (
    <svg
      role="img"
      aria-label={`Path: ${words}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="max-w-full text-foreground"
      data-testid="portfolio-path-diagram"
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {names.map((n, i) => {
        const x = PAD + i * (BOX_W + GAP);
        const y = PAD + 16;
        return (
          <g key={`${path[i].productId}-${i}`}>
            <rect
              x={x}
              y={y}
              width={BOX_W}
              height={BOX_H}
              rx={6}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
            />
            <text
              x={x + BOX_W / 2}
              y={y + BOX_H / 2 + 4}
              textAnchor="middle"
              fontSize={12}
              fill="currentColor"
            >
              {short(n)}
            </text>
            {i < names.length - 1 ? (
              <>
                <line
                  x1={x + BOX_W + 4}
                  y1={y + BOX_H / 2}
                  x2={x + BOX_W + GAP - 4}
                  y2={y + BOX_H / 2}
                  stroke="currentColor"
                  strokeWidth={1}
                  markerEnd={`url(#${markerId})`}
                />
                <text
                  x={x + BOX_W + GAP / 2}
                  y={y - 4}
                  textAnchor="middle"
                  fontSize={11}
                  fill="currentColor"
                >
                  {edges[i] ?? "unclassified"}
                </text>
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
