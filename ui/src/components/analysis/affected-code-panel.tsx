"use client";

/**
 * Issue #735 (Epic #726) — deterministic requirement→code mapping on the
 * analysis results page.
 *
 * When an "Evaluate new requirements" run supplies free-text new requirements
 * and the project has a code graph, the code agent reuses Impact Analysis's
 * mapper + blast radius to map each parsed requirement candidate to affected
 * code. This panel renders that deterministic mapping: one collapsible section
 * per candidate, each listing the affected symbols with their
 * `filePath:startLine` locator, relation (direct vs blast-radius), and
 * confidence. Candidates with no mapped code show an explicit empty state.
 *
 * Renders nothing when there is no mapping (plain runs / no new requirements /
 * no code graph), so it never adds noise to a standard analysis.
 */
import { useState } from "react";
import type { AnalysisAffectedCode, AffectedCodeSymbol } from "@/lib/analysis-api";

interface Props {
  affectedCode: AnalysisAffectedCode | null;
}

/** Format a symbol's source locator as `filePath:startLine` (path only when no line). */
function symbolLocator(s: AffectedCodeSymbol): string {
  return s.startLine != null ? `${s.filePath}:${s.startLine}` : s.filePath;
}

/** A blast-radius relation gets a muted badge; a direct mapper hit an accent one. */
function relationClass(relation: AffectedCodeSymbol["relation"]): string {
  return relation === "direct"
    ? "bg-emerald-900/40 text-emerald-300 border-emerald-700/50"
    : "bg-zinc-800 text-zinc-300 border-zinc-700";
}

export function AffectedCodePanel({ affectedCode }: Props): React.ReactElement | null {
  const candidates = affectedCode?.candidates ?? [];
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (candidates.length === 0) return null;

  return (
    <div data-testid="affected-code-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Affected code (deterministic mapping)
      </h4>
      <p className="text-xs text-zinc-500">
        Each new requirement mapped to existing code via Impact Analysis (mapper + blast radius).
        {affectedCode?.truncated
          ? " Some entries were omitted from the analysis prompt for length."
          : ""}
      </p>
      <ul className="space-y-2">
        {candidates.map((candidate) => {
          const isOpen = open[candidate.id] ?? true;
          return (
            <li
              key={candidate.id}
              data-testid={`affected-code-candidate-${candidate.id}`}
              className="rounded border border-zinc-800 bg-zinc-900/30"
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen((prev) => ({ ...prev, [candidate.id]: !isOpen }))}
                className="flex w-full items-center justify-between gap-2 p-3 text-left"
              >
                <span className="text-sm">
                  <span className="font-mono text-xs text-zinc-500">{candidate.id}</span>{" "}
                  <span className="font-medium text-zinc-200">{candidate.title}</span>
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {candidate.symbols.length} symbol{candidate.symbols.length === 1 ? "" : "s"}
                </span>
              </button>
              {isOpen ? (
                <div className="border-t border-zinc-800 p-3">
                  {candidate.symbols.length === 0 ? (
                    <p
                      data-testid={`affected-code-empty-${candidate.id}`}
                      className="text-xs text-zinc-500"
                    >
                      No code matched — see the coverage indicator.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {candidate.symbols.map((symbol) => (
                        <li
                          key={`${symbol.filePath}:${symbol.startLine}:${symbol.qualifiedName}`}
                          className="flex flex-wrap items-center gap-2 text-xs"
                        >
                          <span
                            className={`rounded border px-1.5 py-0.5 font-medium ${relationClass(symbol.relation)}`}
                          >
                            {symbol.relation}
                          </span>
                          <span className="font-mono text-zinc-200">{symbol.qualifiedName}</span>
                          <span className="font-mono text-zinc-500">{symbolLocator(symbol)}</span>
                          <span className="text-zinc-500">conf {symbol.confidence.toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
