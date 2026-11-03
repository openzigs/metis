"use client";

/**
 * Issue #1615 — a requirement's kind (#1612): `functional` or `non-functional`,
 * with an NFR category on the latter. `null` means the analysis did not
 * classify it (the model did not say, the synthesis fell back, or the row
 * predates #1612): it renders nothing on the card and is its own filter option,
 * so an unclassified requirement is never shown as either kind.
 */
import type { NfrCategory, RequirementKind } from "@metis/shared";
import { Button } from "@/components/ui/button";

/** The list filter: a kind, the unclassified ones, or `null` for all. */
export type RequirementKindFilterValue = RequirementKind | "unclassified" | null;

export const REQUIREMENT_KIND_LABEL: Record<RequirementKind, string> = {
  functional: "Functional",
  "non-functional": "Non-functional",
};

/** #1636 — an NFR category as a reader sees it, not its lowercase enum value. */
export const NFR_CATEGORY_LABEL: Record<NfrCategory, string> = {
  performance: "Performance",
  security: "Security",
  scalability: "Scalability",
  availability: "Availability",
  reliability: "Reliability",
  usability: "Usability",
  maintainability: "Maintainability",
  compliance: "Compliance",
  observability: "Observability",
  other: "Other",
};

/** True when any requirement in the list is classified, so the kind filter has something to do. */
export function anyRequirementKind(
  reqs: ReadonlyArray<{ kind?: RequirementKind | null }>,
): boolean {
  return reqs.some((r) => r.kind != null);
}

const FILTER_OPTIONS: ReadonlyArray<[RequirementKindFilterValue, string]> = [
  [null, "All"],
  ["functional", "Functional"],
  ["non-functional", "Non-functional"],
  ["unclassified", "Not classified"],
];

/** True when a requirement belongs in the list under `filter`. */
export function matchesKindFilter(
  req: { kind?: RequirementKind | null },
  filter: RequirementKindFilterValue,
): boolean {
  if (filter === null) return true;
  const kind = req.kind ?? null;
  return filter === "unclassified" ? kind === null : kind === filter;
}

export function RequirementKindBadge({
  kind,
  nfrCategory,
}: {
  kind: RequirementKind | null | undefined;
  nfrCategory: NfrCategory | null | undefined;
}): React.ReactElement | null {
  if (!kind || !Object.hasOwn(REQUIREMENT_KIND_LABEL, kind)) return null;
  const label = REQUIREMENT_KIND_LABEL[kind];
  const category =
    nfrCategory && Object.hasOwn(NFR_CATEGORY_LABEL, nfrCategory)
      ? NFR_CATEGORY_LABEL[nfrCategory]
      : nfrCategory;
  const text = kind === "non-functional" && category ? `${label} · ${category}` : label;
  return (
    <span
      className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
      data-testid="requirement-kind"
      data-kind={kind}
    >
      {text}
    </span>
  );
}

export function RequirementKindFilter({
  value,
  onChange,
}: {
  value: RequirementKindFilterValue;
  onChange: (next: RequirementKindFilterValue) => void;
}): React.ReactElement {
  return (
    <div
      className="mb-2 flex flex-wrap items-center gap-1"
      data-testid="kind-filter"
      role="group"
      aria-label="Filter requirements by kind"
    >
      <span className="mr-1 text-xs text-muted-foreground">Kind:</span>
      {FILTER_OPTIONS.map(([option, label]) => (
        <Button
          key={label}
          size="sm"
          variant={value === option ? "default" : "outline"}
          aria-pressed={value === option}
          data-testid={`kind-filter-${option ?? "all"}`}
          onClick={() => onChange(option)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
