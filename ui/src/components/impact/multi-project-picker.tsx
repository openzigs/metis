/**
 * MultiProjectPicker — Epic #159 (#164).
 *
 * Lets the user select ONE OR MORE projects for an impact analysis: a single
 * project runs a single-project impact, two+ enables cross-project comparison.
 * Pure/controlled: parent owns the selected-id state.
 */
"use client";

import { Card } from "@/components/ui/card";

export interface PickerProject {
  id: string;
  name: string;
}

export interface MultiProjectPickerProps {
  projects: PickerProject[];
  selected: string[];
  onChange: (ids: string[]) => void;
  isLoading?: boolean;
}

export function MultiProjectPicker({
  projects,
  selected,
  onChange,
  isLoading = false,
}: MultiProjectPickerProps) {
  const selectedSet = new Set(selected);

  function toggle(id: string) {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  }

  return (
    <Card className="space-y-3 p-4" data-testid="multi-project-picker">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Projects</h2>
        <span className="text-xs text-muted-foreground" data-testid="multi-project-count">
          {selected.length} selected
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Pick one deep-ingested project to run a single-project impact, or two or more to compare the
        requirement change across projects.
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="multi-project-loading">
          Loading projects…
        </p>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="multi-project-empty">
          No accessible projects with ingested code.
        </p>
      ) : (
        <ul className="space-y-1" role="group" aria-label="Select projects">
          {projects.map((project) => {
            const checked = selectedSet.has(project.id);
            return (
              <li key={project.id}>
                <label
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                  data-testid={`project-option-${project.id}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(project.id)}
                    data-testid={`project-checkbox-${project.id}`}
                    aria-label={`Include ${project.name}`}
                  />
                  <span>{project.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
