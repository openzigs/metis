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
import { type KeyboardEvent, useId, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
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
  /**
   * Id of the option the arrow keys highlight; null for none. #2218 — an id,
   * not an index: results that arrive after an arrow key (the 250 ms debounce)
   * would otherwise put a requirement the user never moved to under Enter.
   */
  const [activeId, setActiveId] = useState<string | null>(null);
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
  // #2209 — with `keepPreviousData` the results on screen may answer an earlier
  // term. Never say "no match" for the term typed until the server has answered
  // it; while it has not and there is nothing to show, say it is searching.
  const settled = !search.isPlaceholderData;
  const pending = search.isLoading || (!settled && results.length === 0);
  const listed = open && !search.isError && !pending && results.length > 0;
  // An option no longer in the results is no longer active.
  const activeIndex = listed ? results.findIndex((r) => r.id === activeId) : -1;
  const optionId = (id: string) => `${listId}-option-${id}`;

  function pickerStatus(): { text: string; shown: boolean } {
    if (!open || search.isError) return { text: "", shown: false };
    if (pending) return { text: "Searching…", shown: true };
    if (results.length === 0) {
      return {
        text: debounced
          ? `No requirement title contains "${debounced}".`
          : "This project has no requirements yet.",
        shown: true,
      };
    }
    if (search.isFetching) return { text: "Updating matches…", shown: false };
    const n = results.length;
    return { text: `${n} matching requirement${n === 1 ? "" : "s"}`, shown: false };
  }
  const status = pickerStatus();
  const activeOption = activeIndex >= 0 ? results[activeIndex] : undefined;

  function choose(r: DiscussionRequirementRef) {
    if (disabled) return;
    onChange(r);
    setTerm("");
    setActiveId(null);
    setOpen(false);
  }

  // #2209 — the listbox keyboard model: focus stays in the search box, the
  // arrows move the active option (`aria-activedescendant`), Enter picks it and
  // Escape closes the list. With no option active, Enter is left to the form.
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setActiveId(null);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (!listed) return;
      const n = results.length;
      const next =
        e.key === "ArrowDown" ? (activeIndex + 1) % n : activeIndex <= 0 ? n - 1 : activeIndex - 1;
      setActiveId(results[next].id);
      return;
    }
    if (e.key === "Enter" && activeOption) {
      e.preventDefault();
      choose(activeOption);
    }
  }

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
        aria-controls={listed ? listId : undefined}
        aria-expanded={listed}
        aria-activedescendant={activeOption ? optionId(activeOption.id) : undefined}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setTerm(e.target.value);
          setActiveId(null);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && search.isError ? (
        <p className="text-xs text-destructive" role="alert">
          Could not load the project&apos;s requirements.
        </p>
      ) : null}
      {listed ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching requirements"
          aria-busy={search.isFetching}
          className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-1"
        >
          {results.map((r, index) => {
            const date = runDate(r.createdAt);
            return (
              <li
                key={r.id}
                id={optionId(r.id)}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={disabled || undefined}
                onClick={() => choose(r)}
                onMouseMove={() => setActiveId(r.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                  index === activeIndex && "bg-accent",
                )}
              >
                <span className="min-w-0 truncate">{r.title}</span>
                {date ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{date}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {/* #2218 — the one live region, mounted with the picker: a region inserted
          together with its text is not announced, so the first count was never
          read out. Beside a list on screen it is announced, not shown (#2209). */}
      <p className={status.shown ? "text-xs text-muted-foreground" : "sr-only"} role="status">
        {status.text}
      </p>
    </div>
  );
}
