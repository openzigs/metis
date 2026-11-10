"use client";

/**
 * #2187 — pick the requirement a discussion is about.
 *
 * Run 10 found no way to attach a discussion to a requirement: the thread title
 * was the only link (`f-j1-4b-5`). The schema already carried
 * `DiscussionThread.requirementId`; this is the control an analyst uses to set
 * it, by searching the project's requirements on title rather than pasting an
 * id. It is used when a discussion is started and in a thread's Settings.
 */
import { useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { searchThreadRequirements, type DiscussionRequirementRef } from "@/lib/discussions-api";

export interface DiscussionRequirementPickerProps {
  projectId: string;
  /** The chosen requirement, or null for none. */
  value: DiscussionRequirementRef | null;
  onChange: (value: DiscussionRequirementRef | null) => void;
  /** Label of the search box. */
  label?: string;
  disabled?: boolean;
}

function runDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString();
}

export function DiscussionRequirementPicker({
  projectId,
  value,
  onChange,
  label = "About requirement (optional)",
  disabled = false,
}: DiscussionRequirementPickerProps) {
  const inputId = useId();
  const listId = `${inputId}-results`;
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const debounced = useDebouncedValue(term.trim(), 250);

  const search = useQuery({
    queryKey: ["discussion-requirements", projectId, debounced],
    queryFn: () => searchThreadRequirements(projectId, debounced),
    enabled: open && !!projectId && !value,
    // #2203 — keep the last results on screen while the next term is fetched,
    // rather than flipping to "Searching…" on every keystroke.
    placeholderData: keepPreviousData,
  });

  if (value) {
    return (
      <div className="space-y-1" data-testid="discussion-requirement-chosen">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
          <span className="min-w-0 flex-1 truncate" title={value.title}>
            {value.title}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onChange(null)}
            aria-label={`Remove requirement ${value.title}`}
          >
            Remove
          </Button>
        </div>
      </div>
    );
  }

  const results = search.data ?? [];
  return (
    <div className="space-y-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={inputId}
        value={term}
        placeholder="Search requirements by title…"
        autoComplete="off"
        disabled={disabled}
        // #2203 — a search box that opens a list of matches is a combobox.
        role="combobox"
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open ? (
        search.isLoading ? (
          <p className="text-xs text-muted-foreground" role="status">
            Searching…
          </p>
        ) : search.isError ? (
          <p className="text-xs text-destructive" role="alert">
            Could not load the project&apos;s requirements.
          </p>
        ) : results.length === 0 ? (
          <p className="text-xs text-muted-foreground" role="status">
            {debounced
              ? `No requirement title contains "${debounced}".`
              : "This project has no requirements yet."}
          </p>
        ) : (
          <ul
            id={listId}
            aria-label="Matching requirements"
            className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-1"
          >
            {results.map((r) => {
              const date = runDate(r.createdAt);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onChange(r);
                      setTerm("");
                      setOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0 truncate">{r.title}</span>
                    {date ? (
                      <span className="shrink-0 text-xs text-muted-foreground">{date}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )
      ) : null}
    </div>
  );
}
