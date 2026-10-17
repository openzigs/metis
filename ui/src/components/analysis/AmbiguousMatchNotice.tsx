"use client";

/**
 * Issue #1204 — say on a requirement card when the analysis could not tell
 * which grouped item was this requirement's, and show those items.
 *
 * Promotion joins each approved requirement to the item the analysis grouped
 * its acceptance criteria and evidence under. When several items fit equally
 * well it takes none rather than guess (#1033), so the requirement arrives with
 * no criteria. Without this the analyst saw only the empty list. The items are
 * listed with their criteria so the analyst can copy across the ones that apply.
 */
import type { PromotionMatching } from "@/lib/analysis-api";

type AmbiguousEntry = PromotionMatching["ambiguous"][number];

/**
 * Read the key directly (not through `readEnhancementMetadata`): this renders
 * on every requirement card, and the page-level suites replace
 * `@/lib/analysis-api` wholesale. Metadata is stored JSON, so every field is
 * checked before it is rendered.
 */
export function findAmbiguousMatch(
  metadata: Record<string, unknown> | null | undefined,
  requirementId: string,
): AmbiguousEntry | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = (metadata as { promotionMatching?: unknown }).promotionMatching;
  if (!record || typeof record !== "object") return undefined;
  const ambiguous = (record as { ambiguous?: unknown }).ambiguous;
  if (!Array.isArray(ambiguous)) return undefined;
  const entry = ambiguous.find(
    (a): a is AmbiguousEntry =>
      !!a &&
      typeof a === "object" &&
      (a as AmbiguousEntry).requirementId === requirementId &&
      Array.isArray((a as AmbiguousEntry).candidates),
  );
  if (!entry) return undefined;
  const candidates = entry.candidates.filter(
    (c) => !!c && typeof c === "object" && typeof c.title === "string",
  );
  return candidates.length > 0 ? { ...entry, candidates } : undefined;
}

export function AmbiguousMatchNotice({
  metadata,
  requirementId,
  hasCriteria = false,
}: {
  metadata: Record<string, unknown> | null | undefined;
  requirementId: string;
  /**
   * The requirement has acceptance criteria now (someone added them). The
   * notice then stops asking for them: it says why the items are listed, in a
   * muted tone, and keeps the items collapsed for reference.
   */
  hasCriteria?: boolean;
}): React.ReactElement | null {
  const entry = findAmbiguousMatch(metadata, requirementId);
  if (!entry) return null;
  const n = entry.candidates.length;
  const why =
    n === 1
      ? "The analysis could not tell whether the grouped item below belongs to this requirement or to another one, so its acceptance criteria were not added."
      : `The analysis could not tell which of ${n} grouped items belongs to this requirement, so none of their acceptance criteria were added.`;

  if (hasCriteria) {
    return (
      <div
        role="note"
        data-testid={`ambiguous-match-${requirementId}`}
        className="mt-2 text-xs text-muted-foreground"
      >
        <details>
          <summary className="cursor-pointer">
            {n === 1 ? "Show the grouped item" : `Show the ${n} grouped items`} the analysis could
            not place
          </summary>
          <p className="mt-1">{why} This requirement has acceptance criteria now.</p>
          <CandidateList candidates={entry.candidates} />
        </details>
      </div>
    );
  }

  return (
    <div
      role="note"
      data-testid={`ambiguous-match-${requirementId}`}
      className="mt-2 rounded border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning"
    >
      <p>
        <span aria-hidden>⚠</span> {why} Copy across any that apply.
      </p>
      <CandidateList candidates={entry.candidates} />
    </div>
  );
}

function CandidateList({
  candidates,
}: {
  candidates: AmbiguousEntry["candidates"];
}): React.ReactElement {
  return (
    <ul className="mt-1 space-y-1">
      {candidates.map((c, i) => {
        const criteria = Array.isArray(c.acceptanceCriteria)
          ? c.acceptanceCriteria.filter((x): x is string => typeof x === "string")
          : [];
        return (
          <li key={`${i}-${c.title}`}>
            <details>
              <summary className="cursor-pointer text-foreground">{c.title}</summary>
              {criteria.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-foreground">
                  {criteria.map((text, j) => (
                    <li key={j}>{text}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-muted-foreground">This item has no acceptance criteria.</p>
              )}
            </details>
          </li>
        );
      })}
    </ul>
  );
}
