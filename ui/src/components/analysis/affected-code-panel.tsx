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
 * confidence. Since #1097 the mapping ranks with the project's symbol
 * embeddings fused with keywords (`retrievalMode: "hybrid"`) and falls back to
 * keywords alone (`"bm25-only"`), and the panel says which ran. Confidence is
 * ABSOLUTE: an estimate of how often a link like it is right, the same scale
 * on every requirement. What is shown depends on the ranking: with the
 * embeddings, a link needs a confidence of at least 0.08; with keywords alone,
 * the symbol's NAME must share two of the requirement's terms (#1063). Both
 * apply the subject rules and leave test code out, so "no link" is an
 * ordinary, honest outcome. The code agent's own seed list is wider and is not
 * what this panel shows.
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

/** #1097 — the sentence that says which ranking produced the links. */
function retrievalModeNote(mode: AnalysisAffectedCode["retrievalMode"]): string {
  if (mode === "hybrid") {
    return " Ranked by meaning and keywords together (the project's symbol embeddings).";
  }
  if (mode === "bm25-only") {
    return (
      " Ranked by keywords only: the project's symbols are not embedded yet, or no embedding " +
      "model is configured, so code that uses other words for the same thing can be missed. " +
      "Re-run once embedding has finished to compare."
    );
  }
  return "";
}

/**
 * #1097 — what a confidence means. A run recorded before #1097 carries no
 * ranking, and its confidences are relative to each requirement's best link.
 */
function confidenceNote(mode: AnalysisAffectedCode["retrievalMode"]): string {
  return mode
    ? "Confidence estimates how often a link like this one is right, on the same scale for every requirement: 0.30 means about three in ten such links were right when METIS measured it, so most links read well under 1.00."
    : "Confidence is relative to the best link for that requirement, not a probability.";
}

/** #1097 — what a direct match needs to be shown, for the ranking that ran. */
function linkRule(mode: AnalysisAffectedCode["retrievalMode"]): string {
  return mode === "hybrid"
    ? "A direct match is shown when its confidence is at least 0.08 and it is about the requirement's subject"
    : "A direct match is shown only when the symbol's name (with its enclosing type or table, never its file path) shares at least two of the requirement's terms and its subject";
}

export function AffectedCodePanel({ affectedCode }: Props): React.ReactElement | null {
  const candidates = affectedCode?.candidates ?? [];
  const mode = affectedCode?.retrievalMode;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (candidates.length === 0) return null;

  return (
    <div data-testid="affected-code-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Affected code (deterministic mapping)
      </h4>
      <p data-testid="affected-code-explainer" className="text-xs text-muted-foreground">
        Each new requirement mapped to existing code via Impact Analysis (mapper + blast radius).
        {retrievalModeNote(mode)} {linkRule(mode)}: when the requirement names something the project
        stores (such as a feed), the symbol or the type it belongs to must name it too; a type is
        shown only when the requirement uses the last word of its name, and a table column only when
        the requirement names its table. Test code is not shown, and callers and importers of a
        direct match are listed with it. {confidenceNote(mode)}
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
                      No code matched.{" "}
                      {mode === "hybrid"
                        ? "No symbol is close enough to this requirement and about its subject"
                        : "No symbol's name shares two of this requirement's terms and its subject"}
                      , so nothing is linked rather than showing a weak guess. The code agent still
                      investigates it, and may start from weaker candidates that are not shown here;
                      see the coverage indicator.
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
