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
 * confidence. Candidates with no mapped code show an explicit empty state:
 * since #1063 a direct match is shown only when the symbol's NAME (with its
 * enclosing type or table; never its file path) shares two of the
 * requirement's terms, and since #706 run 9 also its subject (the rules in
 * `sharesRequirementSubject`, server side) and is not test code, so "no link"
 * is an ordinary, honest outcome. The code
 * agent's own seed list is wider and is not what this panel shows.
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
    ? "bg-success-muted text-success border-success/40"
    : "bg-muted text-foreground border-border";
}

export function AffectedCodePanel({ affectedCode }: Props): React.ReactElement | null {
  const candidates = affectedCode?.candidates ?? [];
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (candidates.length === 0) return null;

  return (
    <div data-testid="affected-code-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Affected code (deterministic mapping)
      </h4>
      <p className="text-xs text-muted-foreground">
        Each new requirement mapped to existing code via Impact Analysis (mapper + blast radius). A
        direct match is shown only when the symbol&apos;s name (with its enclosing type or table,
        never its file path) shares at least two of the requirement&apos;s terms and its subject:
        when the requirement names something the project stores (such as a feed), the symbol must
        name it too, and a type or a table column is shown only when the requirement names that type
        or table. Test code is not shown, and callers and importers of a direct match are listed
        with it. Confidence is relative to the best link for that requirement, not a probability.
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
              className="rounded border border-border bg-muted/30"
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen((prev) => ({ ...prev, [candidate.id]: !isOpen }))}
                className="flex w-full items-center justify-between gap-2 p-3 text-left"
              >
                <span className="text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{candidate.id}</span>{" "}
                  <span className="font-medium text-foreground">{candidate.title}</span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {candidate.symbols.length} symbol{candidate.symbols.length === 1 ? "" : "s"}
                </span>
              </button>
              {isOpen ? (
                <div className="border-t border-border p-3">
                  {candidate.symbols.length === 0 ? (
                    <p
                      data-testid={`affected-code-empty-${candidate.id}`}
                      className="text-xs text-muted-foreground"
                    >
                      No code matched. No symbol&apos;s name shares two of this requirement&apos;s
                      terms and its subject, so nothing is linked rather than showing a weak guess.
                      The code agent still investigates it, and may start from weaker candidates
                      that are not shown here; see the coverage indicator.
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
                          <span className="font-mono text-foreground">{symbol.qualifiedName}</span>
                          <span className="font-mono text-muted-foreground">
                            {symbolLocator(symbol)}
                          </span>
                          <span className="text-muted-foreground">
                            conf {symbol.confidence.toFixed(2)}
                          </span>
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
