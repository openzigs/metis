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
}: {
  metadata: Record<string, unknown> | null | undefined;
  requirementId: string;
}): React.ReactElement | null {
  const entry = findAmbiguousMatch(metadata, requirementId);
  if (!entry) return null;
  const n = entry.candidates.length;

  return (
    <div
      role="note"
      data-testid={`ambiguous-match-${requirementId}`}
      className="mt-2 rounded border border-warning/40 bg-warning-muted px-3 py-2 text-xs text-warning"
    >
      <p>
        <span aria-hidden>⚠</span>{" "}
        {n === 1
          ? "The analysis could not tell whether the grouped item below belongs to this requirement or to another one, so its acceptance criteria were not added."
          : `The analysis could not tell which of ${n} grouped items belongs to this requirement, so none of their acceptance criteria were added.`}{" "}
        Copy across any that apply.
      </p>
      <ul className="mt-1 space-y-1">
        {entry.candidates.map((c, i) => {
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
                  <p className="mt-1 text-muted-foreground">
                    This item has no acceptance criteria.
                  </p>
                )}
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
