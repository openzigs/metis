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
import { useQuery } from "@tanstack/react-query";
import { analysisApi } from "@/lib/analysis-api";
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
  const options = useQuery({
    queryKey: ["analyses", "imported-requirements", projectId],
    queryFn: () => analysisApi.importedRequirements(projectId),
  });
  const items = options.data?.items ?? [];
  if (items.length === 0) return null;

  const max = options.data?.maxSelectable ?? 0;
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? items.filter(
        (i) => i.title.toLowerCase().includes(needle) || (i.externalId ?? "").includes(needle),
      )
    : items;
  const atMax = selected.length >= max;

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
