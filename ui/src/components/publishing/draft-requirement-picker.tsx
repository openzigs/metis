"use client";

/**
 * #863 — the selection step before an import run becomes drafts.
 *
 * Generating from a 266-issue import used to create 267 drafts in one click.
 * Above the threshold the server now refuses to draft an import wholesale
 * (`DRAFT_SELECTION_REQUIRED`), and this list is where the user names the
 * requirements to draft instead.
 */
import type { DraftCandidate } from "@metis/shared";
import { Button } from "@/components/ui/button";

export interface DraftRequirementPickerProps {
  requirements: DraftCandidate[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}

export function DraftRequirementPicker({
  requirements,
  selected,
  onChange,
}: DraftRequirementPickerProps) {
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  return (
    <div
      className="mt-3 rounded-md border border-border p-3"
      data-testid="draft-requirement-picker"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          This import holds {requirements.length} requirements. Choose the ones to draft —{" "}
          <span data-testid="draft-requirement-picker-count">{selected.size} selected</span>.
        </p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange(new Set(requirements.map((r) => r.id)))}
          >
            Select all
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected.size === 0}
            onClick={() => onChange(new Set())}
          >
            Clear
          </Button>
        </div>
      </div>
      <ul className="mt-2 max-h-64 divide-y divide-border overflow-y-auto">
        {requirements.map((r) => (
          <li key={r.id} className="flex items-center gap-2 py-1">
            <input
              type="checkbox"
              aria-label={`Draft requirement: ${r.title}`}
              checked={selected.has(r.id)}
              onChange={(e) => toggle(r.id, e.target.checked)}
            />
            <span className="text-sm">{r.title}</span>
            <span className="text-xs text-muted-foreground">
              {r.type} · {r.priority}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
