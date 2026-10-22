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
 * the symbol's NAME must share two of the requirement's terms (#1063): "the
 * keyword rule". #1330: the keyword rule also decides a hybrid ranking with an
 * embedding model the confidence is not calibrated for, and, within a hybrid
 * ranking, every link to a symbol with no usable embedding (a database table
 * or column, which is never embedded, or code not embedded yet). Each
 * requirement records the rule that decided it (`linkRule`) and why the
 * keyword rule did (`keywordRuleCause`), so the panel names the rule that ran
 * and its actual cause. Both
 * apply the subject rules and leave test code out, so "no link" is an
 * ordinary, honest outcome. Links under `STRONG_LINK_CONFIDENCE` are folded
 * under "N weaker matches", and a `mixed` run labels each requirement with the
 * ranking that answered it. The code agent's own seed list is wider and is not
 * what this panel shows.
 *
 * Renders nothing when there is no mapping (plain runs / no new requirements /
 * no code graph), so it never adds noise to a standard analysis.
 */
import { useState } from "react";
import type {
  AnalysisAffectedCode,
  AffectedCodeCandidate,
  AffectedCodeSymbol,
} from "@/lib/analysis-api";

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

type RunMode = AnalysisAffectedCode["retrievalMode"];
type CandidateMode = AffectedCodeCandidate["retrievalMode"];
type LinkRule = NonNullable<AffectedCodeCandidate["linkRule"]>;

/**
 * #1330 — the rule that decided a requirement's links: recorded since #1330;
 * before it, implied by the ranking (a pre-#1097 run's is the two-term rule).
 */
function ruleOf(candidate: AffectedCodeCandidate, mode: RunMode): LinkRule {
  if (candidate.linkRule) return candidate.linkRule;
  return (candidate.retrievalMode ?? mode) === "hybrid" ? "confidence" : "shared-terms";
}

/** #1330 — whether the embeddings ranked a requirement whose links the keyword rule decided. */
function keywordGatedHybrid(candidate: AffectedCodeCandidate, mode: RunMode): boolean {
  return (
    (candidate.retrievalMode ?? mode) === "hybrid" && ruleOf(candidate, mode) === "shared-terms"
  );
}

type KeywordRuleCause = NonNullable<AffectedCodeCandidate["keywordRuleCause"]>;

/**
 * #1330 — the sentence naming why the keyword rule decided links the
 * embeddings ranked, one per cause the run records. `all` is whether every
 * requirement of the run was decided so (wording only).
 */
function keywordRuleCauseNote(cause: KeywordRuleCause, all: boolean): string {
  if (cause === "uncalibrated-model") {
    return all
      ? " The embedding model in use is not the one METIS's confidence is calibrated for, so the keyword rule decided which links are shown."
      : " For the requirements marked so, the embedding model in use is not the one METIS's confidence is calibrated for, so the keyword rule decided which links are shown.";
  }
  if (cause === "schema-not-embedded") {
    return " Database tables and columns are never embedded, so a table or column is shown only by the keyword rule.";
  }
  return " Some code has no usable embedding (it is still being embedded, or was embedded with another model), so it is shown only by the keyword rule; re-run once embedding has finished.";
}

/**
 * #1097 (review of PR #1325) — a link at or above this confidence is listed;
 * the rest of a requirement's links are folded under "N weaker matches".
 *
 * Basis, on the run-7 Miniflux replay (`eval-data/reqmap-replay/`, one
 * annotator, in-sample): with the hybrid ranking, the 53 links at 0.15 or more
 * were right 34% of the time and the 45 below it 27%; listing only the former
 * keeps the list about the size it was before the embeddings found more code
 * (58 links), and folding, not dropping, the rest hides nothing.
 */
export const STRONG_LINK_CONFIDENCE = 0.15;

/** #1097 — the sentence that says which ranking produced the links. */
function retrievalModeNote(mode: RunMode): string {
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
  if (mode === "mixed") {
    return (
      " Some requirements were ranked by meaning and keywords together (the project's symbol " +
      "embeddings); others by keywords only, because the embeddings did not answer for them. " +
      "Each requirement says which."
    );
  }
  return "";
}

/**
 * #1097 — what a confidence means. A run recorded before #1097 carries no
 * ranking, and its confidences are relative to each requirement's best link.
 */
function confidenceNote(mode: RunMode): string {
  return mode
    ? `Confidence estimates how often a link like this one is right, on the same scale for every requirement: 0.30 means about three in ten such links were right on METIS's own measurement sample, so most links read well under 1.00. Links under ${STRONG_LINK_CONFIDENCE.toFixed(2)} are folded under "weaker matches".`
    : "Confidence is relative to the best link for that requirement, not a probability.";
}

/** #1330 — the two rules, each named in the panel's own words. */
const CONFIDENCE_RULE = "the confidence rule (its confidence is at least 0.08)";
const KEYWORD_RULE =
  "the keyword rule (the symbol's name, with its enclosing type or table and never its file path, shares at least two of the requirement's terms)";

/**
 * #1097 — what a direct match needs to be shown. #1330: worded from the rules
 * that decided the links, not from the ranking, which can differ.
 */
function linkRuleText(rules: ReadonlySet<LinkRule>): string {
  if (rules.has("confidence") && rules.has("shared-terms")) {
    return `Depending on the requirement (each says which), a direct match is shown by ${CONFIDENCE_RULE} or by ${KEYWORD_RULE}, and either way only when it is about the requirement's subject`;
  }
  if (rules.has("confidence")) {
    return `Ranked with meaning and keywords, a direct match is shown by ${CONFIDENCE_RULE}, and only when it is about the requirement's subject`;
  }
  return `A direct match is shown by ${KEYWORD_RULE}, and only when it is about the requirement's subject`;
}

/** #1097 — the ranking one requirement's links came from; #1330 — and the rule, when it is not the ranking's. */
function candidateLabel(candidate: AffectedCodeCandidate, mode: RunMode): string | null {
  const ranking: CandidateMode = candidate.retrievalMode ?? (mode === "mixed" ? undefined : mode);
  if (ranking === "bm25-only") return "keywords only";
  if (ranking !== "hybrid") return null;
  return keywordGatedHybrid(candidate, mode)
    ? "meaning + keywords, shown by the keyword rule"
    : "meaning + keywords, shown by confidence";
}

function SymbolRow({ symbol }: { symbol: AffectedCodeSymbol }): React.ReactElement {
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      <span
        className={`rounded border px-1.5 py-0.5 font-medium ${relationClass(symbol.relation)}`}
      >
        {symbol.relation}
      </span>
      <span className="font-mono text-foreground">{symbol.qualifiedName}</span>
      <span className="font-mono text-muted-foreground">{symbolLocator(symbol)}</span>
      <span className="text-muted-foreground">conf {symbol.confidence.toFixed(2)}</span>
    </li>
  );
}

const symbolKey = (s: AffectedCodeSymbol): string =>
  `${s.filePath}:${s.startLine}:${s.qualifiedName}`;

export function AffectedCodePanel({ affectedCode }: Props): React.ReactElement | null {
  const candidates = affectedCode?.candidates ?? [];
  const mode = affectedCode?.retrievalMode;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (candidates.length === 0) return null;
  const rules = new Set(candidates.map((c) => ruleOf(c, mode)));
  // Label each requirement when they were not all ranked, or not all gated, alike.
  const labelEach = mode === "mixed" || rules.size > 1;
  const causes = new Set(
    candidates.flatMap((c) => (c.keywordRuleCause ? [c.keywordRuleCause] : [])),
  );
  const allGated = candidates.every((c) => keywordGatedHybrid(c, mode));
  const gateNote = [...causes].map((c) => keywordRuleCauseNote(c, allGated)).join("");

  return (
    <div data-testid="affected-code-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Affected code (deterministic mapping)
      </h4>
      <p data-testid="affected-code-explainer" className="text-xs text-muted-foreground">
        Each new requirement mapped to existing code via Impact Analysis (mapper + blast radius).
        {retrievalModeNote(mode)}
        {gateNote} {linkRuleText(rules)}: when the requirement names something the project stores
        (such as a feed), the symbol or the type it belongs to must name it too; a type is shown
        only when the requirement uses the last word of its name, and a table column only when the
        requirement names its table. Test code is not shown, and callers and importers of a direct
        match are listed with it. {confidenceNote(mode)}
        {affectedCode?.truncated
          ? " Some entries were omitted from the analysis prompt for length."
          : ""}
      </p>
      <ul className="space-y-2">
        {candidates.map((candidate) => {
          const isOpen = open[candidate.id] ?? true;
          const ranking = labelEach ? candidateLabel(candidate, mode) : null;
          // Only absolute confidences (a run that records its ranking) are folded.
          const fold = Boolean(mode);
          const strong = fold
            ? candidate.symbols.filter((s) => s.confidence >= STRONG_LINK_CONFIDENCE)
            : candidate.symbols;
          const weaker = fold
            ? candidate.symbols.filter((s) => s.confidence < STRONG_LINK_CONFIDENCE)
            : [];
          const emptyRuleHybrid = ruleOf(candidate, mode) === "confidence";
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
                  {ranking ? (
                    <span
                      data-testid={`affected-code-ranking-${candidate.id}`}
                      className="ml-2 text-xs text-muted-foreground"
                    >
                      ({ranking})
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {candidate.symbols.length} symbol
                  {candidate.symbols.length === 1 ? "" : "s"}
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
                      {emptyRuleHybrid
                        ? "No symbol is close enough to this requirement and about its subject"
                        : "No symbol's name shares two of this requirement's terms and its subject"}
                      , so nothing is linked rather than showing a weak guess. The code agent still
                      investigates it, and may start from weaker candidates that are not shown here;
                      see the coverage indicator.
                    </p>
                  ) : (
                    <>
                      {strong.length > 0 ? (
                        <ul className="space-y-1.5">
                          {strong.map((symbol) => (
                            <SymbolRow key={symbolKey(symbol)} symbol={symbol} />
                          ))}
                        </ul>
                      ) : (
                        <p
                          data-testid={`affected-code-no-strong-${candidate.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          No link reaches {STRONG_LINK_CONFIDENCE.toFixed(2)}; only weaker matches.
                        </p>
                      )}
                      {weaker.length > 0 ? (
                        <details
                          data-testid={`affected-code-weaker-${candidate.id}`}
                          className="mt-2 text-xs"
                        >
                          <summary className="cursor-pointer text-muted-foreground">
                            {weaker.length} weaker match
                            {weaker.length === 1 ? "" : "es"} (confidence under{" "}
                            {STRONG_LINK_CONFIDENCE.toFixed(2)})
                          </summary>
                          <ul className="mt-1.5 space-y-1.5">
                            {weaker.map((symbol) => (
                              <SymbolRow key={symbolKey(symbol)} symbol={symbol} />
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </>
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
