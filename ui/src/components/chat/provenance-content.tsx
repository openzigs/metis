"use client";

/**
 * Issue #540 — Render project provenance badges in chat messages.
 *
 * When the AI returns cross-project search results, chunks include
 * `[ProjectName]` tags. This component highlights them as colored badges
 * for visual clarity.
 */

const PROJECT_TAG_RE = /\[([^\]]+)\]\s+([\w\-.]+#\d+)/g;

/**
 * Colors assigned deterministically to project names for consistent
 * badge styling across messages. #301 — the chart series colour is the badge
 * BORDER, so the label keeps full text contrast in both themes.
 */
const BADGE_COLORS = [
  "border-chart-1",
  "border-chart-2",
  "border-chart-3",
  "border-chart-4",
  "border-chart-5",
  "border-chart-6",
];

function colorForProject(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return BADGE_COLORS[Math.abs(hash) % BADGE_COLORS.length];
}

interface Props {
  content: string;
}

/**
 * Renders chat content with project provenance tags styled as badges.
 * Falls back to plain text if no project tags are found.
 */
export function ProvenanceContent({ content }: Props) {
  const parts: (string | { type: "badge"; project: string; file: string })[] = [];
  let lastIdx = 0;

  for (const match of content.matchAll(PROJECT_TAG_RE)) {
    const idx = match.index!;
    if (idx > lastIdx) {
      parts.push(content.slice(lastIdx, idx));
    }
    parts.push({ type: "badge", project: match[1], file: match[2] });
    lastIdx = idx + match[0].length;
  }

  if (lastIdx < content.length) {
    parts.push(content.slice(lastIdx));
  }

  // No badges found — render plain
  if (parts.length === 1 && typeof parts[0] === "string") {
    return <span className="whitespace-pre-wrap">{content}</span>;
  }

  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) => {
        if (typeof part === "string") {
          return <span key={i}>{part}</span>;
        }
        return (
          <span key={i}>
            <span
              className={`inline-flex items-center rounded-full border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground ${colorForProject(part.project)}`}
            >
              {part.project}
            </span>{" "}
            <span className="font-mono text-xs text-muted-foreground">{part.file}</span>
          </span>
        );
      })}
    </span>
  );
}
