/**
 * Phase 12 — global ⌘K command palette.
 *
 * Surfaces fuzzy search across the user's projects + the static navigation
 * registry. Server-side filtering ensures only entities the user can read
 * appear (we just call the existing `/api/projects` endpoint, which is
 * already permission-scoped).
 */
"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/components/tables/responsive-table";
import { projectsApi } from "@/lib/projects-api";
import { NAV_ITEMS } from "@/lib/navigation";

/**
 * Below this width the palette presents as a bottom sheet instead of the
 * centered desktop dialog (Epic #55 / #61). Mirrors the Tailwind `md`
 * breakpoint used by ResponsiveTable (#60) so the whole mobile pass is
 * consistent.
 */
const MOBILE_QUERY = "(max-width: 767.98px)";

/**
 * Positioning overrides that turn the centered DialogContent into a
 * bottom-anchored sheet. `cn` (twMerge) resolves the conflicting utilities so
 * these win over the base `left/top/translate/max-w/rounded` classes.
 */
const SHEET_CLASSES =
  "left-0 right-0 top-auto bottom-0 w-full max-w-full translate-x-0 translate-y-0 " +
  "rounded-b-none rounded-t-2xl max-h-[85dvh] " +
  "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom";

export interface CommandItem {
  id: string;
  label: string;
  hint: string;
  href: string;
}

/**
 * Tiny fuzzy match — returns a score (lower is better) or `null` when the
 * input does not appear in `target` as a non-strict subsequence. Pulled
 * out for unit tests.
 */
export function fuzzyScore(target: string, query: string): number | null {
  if (query.length === 0) return 0;
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      // Reward consecutive matches; penalise gaps.
      if (lastMatchIdx >= 0 && ti === lastMatchIdx + 1) score -= 1;
      score += ti - (lastMatchIdx + 1);
      lastMatchIdx = ti;
      qi++;
    }
    ti++;
  }
  if (qi < q.length) return null;
  return score;
}

export function rankCommands(items: CommandItem[], query: string): CommandItem[] {
  if (query.trim().length === 0) return items.slice(0, 25);
  const scored: Array<{ item: CommandItem; score: number }> = [];
  for (const item of items) {
    const score = fuzzyScore(`${item.label} ${item.hint}`, query.trim());
    if (score !== null) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 25).map((s) => s.item);
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const router = useRouter();
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const listId = useId();

  // ⌘K / Ctrl+K to toggle.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const projects = useQuery({
    queryKey: ["palette", "projects"],
    queryFn: () => projectsApi.list({ limit: 50 }),
    enabled: open,
  });

  const items = useMemo<CommandItem[]>(() => {
    const navItems: CommandItem[] = NAV_ITEMS.map((n) => ({
      id: `nav:${n.href}`,
      label: n.label,
      hint: "Page",
      href: n.href,
    }));
    const projectItems: CommandItem[] = (projects.data?.items ?? []).map((p) => ({
      id: `project:${p.id}`,
      label: p.name,
      hint: "Project",
      href: `/projects/${p.id}`,
    }));
    return [...navItems, ...projectItems];
  }, [projects.data]);

  const ranked = useMemo(() => rankCommands(items, query), [items, query]);

  // Reset the highlight to the top only when the user edits the query — NOT when
  // async results (projects) stream in, which would otherwise yank a user's
  // arrow-key selection back to the first row.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Derive an in-range index so a shrinking result set never leaves the
  // highlight (and aria-activedescendant) pointing past the end of the list.
  const activeClampedIndex = ranked.length === 0 ? -1 : Math.min(activeIndex, ranked.length - 1);

  function handleSelect(item: CommandItem) {
    setOpen(false);
    setQuery("");
    router.push(item.href);
  }

  // Roving highlight over the listbox via aria-activedescendant: focus stays on
  // the combobox input, arrows move the active option, Enter selects it.
  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (ranked.length === 0) {
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (Math.min(i, ranked.length - 1) + 1) % ranked.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (Math.min(i, ranked.length - 1) - 1 + ranked.length) % ranked.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = ranked[activeClampedIndex];
      if (item) handleSelect(item);
    }
  }

  const optionId = (item: CommandItem) => `${listId}-option-${item.id}`;
  const activeItem = ranked[activeClampedIndex];
  const statusText =
    ranked.length === 0 ? "No results" : `${ranked.length} result${ranked.length === 1 ? "" : "s"}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        aria-modal="true"
        className={cn("max-w-lg", isMobile && SHEET_CLASSES)}
        data-testid="command-palette"
        data-variant={isMobile ? "sheet" : "dialog"}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Input
          role="combobox"
          aria-label="Search commands"
          aria-controls={listId}
          aria-expanded={ranked.length > 0}
          aria-autocomplete="list"
          aria-activedescendant={activeItem ? optionId(activeItem) : undefined}
          placeholder="Search projects, pages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
          autoFocus
          data-testid="command-palette-input"
        />
        <ul
          id={listId}
          role="listbox"
          aria-label="Command results"
          className="mt-2 max-h-80 space-y-1 overflow-y-auto"
          data-testid="command-palette-list"
        >
          {ranked.length === 0 ? (
            <li role="presentation" className="px-2 py-3 text-sm text-muted-foreground">
              No matches.
            </li>
          ) : (
            ranked.map((item, index) => (
              <li
                key={item.id}
                id={optionId(item)}
                role="option"
                aria-selected={index === activeClampedIndex}
                data-href={item.href}
                onClick={() => handleSelect(item)}
                onMouseMove={() => setActiveIndex(index)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                  index === activeClampedIndex && "bg-accent",
                )}
                data-testid={`command-item-${item.id}`}
              >
                <span>{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.hint}</span>
              </li>
            ))
          )}
        </ul>
        <p aria-live="polite" className="sr-only" data-testid="command-palette-status">
          {statusText}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Tip: press <kbd className="rounded border px-1">⌘K</kbd> to toggle.
        </p>
      </DialogContent>
    </Dialog>
  );
}
