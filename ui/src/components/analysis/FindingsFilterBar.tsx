"use client";

/**
 * Issue #30 — filter a run's findings by severity, category, agent and
 * verification status. Options come from the run itself, so a filter never
 * offers a value that would match nothing.
 *
 * The verification buttons keep their #740 test ids; the three new facets are
 * native selects, which stay usable with a keyboard and a screen reader
 * without any extra wiring.
 */
import { Button } from "@/components/ui/button";
import type { FindingVerificationStatus } from "@/lib/analysis-api";
import type { FindingFilters } from "@/components/analysis/analysis-views";

const VERIFICATION_OPTIONS: Array<[FindingVerificationStatus | null, string]> = [
  [null, "All"],
  ["confirmed", "Confirmed"],
  ["unverified", "Unverified"],
];

const SELECT_CLASS = "rounded border border-border bg-muted/40 px-2 py-1 text-xs text-foreground";

function FacetSelect({
  id,
  label,
  value,
  options,
  optionLabel,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  options: string[];
  optionLabel?: (value: string) => string;
  onChange: (value: string | null) => void;
}): React.ReactElement {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground" htmlFor={id}>
      {label}:
      <select
        id={id}
        data-testid={id}
        className={SELECT_CLASS}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {optionLabel ? optionLabel(o) : o}
          </option>
        ))}
      </select>
    </label>
  );
}

export function FindingsFilterBar({
  facets,
  filters,
  onChange,
  agentLabel,
}: {
  facets: { severities: string[]; categories: string[]; agents: string[] };
  filters: FindingFilters;
  onChange: (next: FindingFilters) => void;
  /** Display name for an agent key (persona name, when known). */
  agentLabel?: (agentKey: string) => string;
}): React.ReactElement {
  const active =
    filters.severity !== null ||
    filters.category !== null ||
    filters.agentKey !== null ||
    filters.verification !== null;
  return (
    <div className="mb-2 space-y-2" data-testid="findings-filters">
      <div
        className="flex flex-wrap items-center gap-3"
        role="group"
        aria-label="Filter findings by severity, category and agent"
      >
        <FacetSelect
          id="finding-filter-severity"
          label="Severity"
          value={filters.severity}
          options={facets.severities}
          onChange={(severity) => onChange({ ...filters, severity })}
        />
        <FacetSelect
          id="finding-filter-category"
          label="Category"
          value={filters.category}
          options={facets.categories}
          onChange={(category) => onChange({ ...filters, category })}
        />
        <FacetSelect
          id="finding-filter-agent"
          label="Agent"
          value={filters.agentKey}
          options={facets.agents}
          optionLabel={agentLabel}
          onChange={(agentKey) => onChange({ ...filters, agentKey })}
        />
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            data-testid="finding-filter-clear"
            onClick={() =>
              onChange({ severity: null, category: null, agentKey: null, verification: null })
            }
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      {/* Epic #727 (#740) — filter findings by verification status. */}
      <div
        className="flex flex-wrap items-center gap-1"
        data-testid="verification-filter"
        role="group"
        aria-label="Filter findings by verification status"
      >
        <span className="mr-1 text-xs text-muted-foreground">Verification:</span>
        {VERIFICATION_OPTIONS.map(([value, label]) => (
          <Button
            key={label}
            size="sm"
            variant={filters.verification === value ? "default" : "outline"}
            aria-pressed={filters.verification === value}
            data-testid={`verification-filter-${value ?? "all"}`}
            onClick={() => onChange({ ...filters, verification: value })}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
