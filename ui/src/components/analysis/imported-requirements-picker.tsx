"use client";

/**
 * Issue #1006 — pick imported requirements (GitHub / Jira / Azure DevOps /
 * Linear) for an analysis to start from.
 *
 * In #706 run 5 the start form had no way to choose imported items: pasting
 * them into the free-text box gave one requirement and no link back. Each item
 * picked here is analysed as its own requirement, and the run records which
 * imported item it was. Renders nothing when the project has imported nothing.
 */
import { useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { analysisApi } from "@/lib/analysis-api";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SOURCE_LABEL: Record<string, string> = {
  github: "GitHub",
  jira: "Jira",
  "azure-devops": "Azure DevOps",
  linear: "Linear",
};

interface Props {
  projectId: string;
  /** Selected imported requirement ids, in the order they were picked. */
  selected: string[];
  onChange: (next: string[]) => void;
}

export function ImportedRequirementsPicker({
  projectId,
  selected,
  onChange,
}: Props): React.ReactElement | null {
  const [filter, setFilter] = useState("");
  const filterId = useId();
  const term = filter.trim().replace(/^#+/, "").trim();
  const needle = term.toLowerCase();
  // The server lists at most its cap (newest first), so the filter is also sent
  // as `q`: a row older than the cap is reachable by searching for it.
  const q = useDebouncedValue(term, 300);
  const options = useQuery({
    queryKey: ["analyses", "imported-requirements", projectId, q],
    queryFn: () => analysisApi.importedRequirements(projectId, q),
    placeholderData: keepPreviousData,
  });
  const data = options.data;
  // Hidden only when the project has imported nothing — never because a search
  // matched nothing, which would take the search box away with it.
  if (!data || (data.items.length === 0 && !q && !term)) return null;

  const max = data.maxSelectable;
  // Narrow what is on screen at once, before the debounced server search lands.
  const visible = needle
    ? data.items.filter(
        (i) => i.title.toLowerCase().includes(needle) || (i.externalId ?? "").includes(needle),
      )
    : data.items;
  const atMax = selected.length >= max;
  // The server answer for what is typed now, not a previous search still on screen.
  const settled = q === term && !options.isPlaceholderData;

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  return (
    <div className="rounded border border-border p-3" data-testid="imported-requirements-picker">
      <Label className="text-sm font-medium">Analyze imported requirements (optional)</Label>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Each one you pick is analyzed as its own requirement, and the results link back to it. Pick
        up to {max}; {selected.length} selected.
      </p>
      <div className="mt-2">
        <Label htmlFor={filterId} className="sr-only">
          Filter imported requirements
        </Label>
        <Input
          id={filterId}
          value={filter}
          placeholder="Filter by title or issue number"
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {data.truncated && settled ? (
        <p className="mt-1 text-xs text-warning" data-testid="imported-requirements-truncated">
          Showing the newest {data.items.length} of {data.total}; refine the filter to find older
          ones.
        </p>
      ) : null}
      {visible.length === 0 && settled ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No imported requirements match &ldquo;{filter.trim()}&rdquo;.
        </p>
      ) : null}
      <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
        {visible.map((item) => {
          const checked = selected.includes(item.id);
          return (
            <li key={item.id}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && atMax}
                  onChange={() => toggle(item.id)}
                  className="mt-0.5"
                />
                <span>
                  {item.title}{" "}
                  <span className="text-xs text-muted-foreground">
                    {SOURCE_LABEL[item.externalSource] ?? item.externalSource}
                    {item.externalId ? ` #${item.externalId}` : ""}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
