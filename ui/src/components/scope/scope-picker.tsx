"use client";

/**
 * Issue #2351 (epic #2328) — one scope picker for chat, impact analysis and the
 * portfolio check: the same three options, the same wording and the same
 * keyboard behaviour in all three.
 *
 * - **This project**: the project the analyst is working in (chat: the top
 *   bar's; impact and portfolio: the change request's, or the one arrived
 *   with). The portfolio check works on products, so there it is the product
 *   the project belongs to, and a project in no product says so.
 * - **Chosen products**: the ones ticked.
 * - **Whole workspace**: every product of the top bar's workspace that the
 *   analyst can read, with how many that is.
 *
 * "Product" is what the tool searches: in chat and impact analysis each
 * project is one (#2238 scopes chat to "products/projects"); in the portfolio
 * check it is a portfolio product. There is no "All" option: #2330 found
 * "All" meant "no retrieval" in chat and "everything I can access" in the
 * portfolio. Chat with nothing ticked still answers without searching, and
 * says "No product chosen".
 *
 * Moved from chat's `project-scope-selector.tsx` (#537, #1368, #2238): the
 * same button and popover, which a click outside closes. Escape closes it too
 * and returns the focus to the button; Tab walks the options in order. The
 * picker offers only what the caller passes in (what the analyst can read); the
 * server checks the scope again on every endpoint.
 */
import { useEffect, useRef, useState } from "react";

export type ScopeKind = "this" | "chosen" | "workspace";

export interface ScopeItem {
  id: string;
  name: string;
}

/** The wording all three consumers share. */
export const SCOPE_WORDS = {
  this: "This project",
  chosen: "Chosen products",
  workspace: "Whole workspace",
  nothing: "No product chosen",
  hint: "Tick one or more products.",
} as const;

/** "Payments (3 products)"; the count is left out while it is not known. */
export function workspaceText(name: string, count: number | null): string {
  if (count === null) return name;
  return `${name} (${count} product${count === 1 ? "" : "s"})`;
}

/** The button's label: the option chosen, and what it is. */
export function scopeLabel(opts: {
  kind: ScopeKind | null;
  chosenIds: readonly string[];
  nameOf: (id: string) => string | undefined;
  current?: ScopeItem | null;
  workspace?: { name: string; count: number | null } | null;
  loading?: boolean;
}): { lead: string | null; detail: string } {
  const { kind, chosenIds, nameOf, current, workspace, loading } = opts;
  if (kind === "this") return { lead: `${SCOPE_WORDS.this}:`, detail: current?.name ?? "…" };
  if (kind === "workspace") {
    return {
      lead: `${SCOPE_WORDS.workspace}:`,
      detail: workspace ? workspaceText(workspace.name, workspace.count) : "…",
    };
  }
  if (chosenIds.length === 0) return { lead: null, detail: SCOPE_WORDS.nothing };
  // #1368 — name the product instead of counting it.
  const first = nameOf(chosenIds[0]) ?? (loading ? "Loading…" : "1 product");
  const more = chosenIds.length - 1;
  if (more === 0) return { lead: null, detail: first };
  if (more === 1) return { lead: null, detail: `${first} + ${nameOf(chosenIds[1]) ?? "1 more"}` };
  return { lead: null, detail: `${first} + ${more} more` };
}

export interface ScopePickerProps {
  /** The option chosen; `null` when nothing is (chat answering without a search). */
  kind: ScopeKind | null;
  /** The products ticked, for "Chosen products". */
  chosenIds: readonly string[];
  /** What may be ticked: only what the analyst can read. */
  items: readonly ScopeItem[];
  itemsLoading?: boolean;
  /** "This project", when there is one; otherwise `currentNote` says why not. */
  current?: ScopeItem | null;
  currentNote?: string;
  /** "Whole workspace", when there is one; otherwise `workspaceNote` says why not. */
  workspace?: { id: string; name: string; count: number | null } | null;
  workspaceNote?: string;
  onPickThis: () => void;
  onPickWorkspace: () => void;
  onToggle: (item: ScopeItem) => void;
  /** At most this many may be ticked (the endpoint's own limit). */
  maxChosen?: number;
  disabled?: boolean;
  /** Test ids: `<base>-selector` (the button), `<base>-this`, `<base>-workspace`. */
  testIdBase: string;
  /** The button's accessible name. */
  ariaLabel?: string;
}

export function ScopePicker({
  kind,
  chosenIds,
  items,
  itemsLoading = false,
  current = null,
  currentNote,
  workspace = null,
  workspaceNote,
  onPickThis,
  onPickWorkspace,
  onToggle,
  maxChosen,
  disabled,
  testIdBase,
  ariaLabel = "Scope",
}: ScopePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const chosen = kind === "chosen" ? chosenIds : [];
  const nameOf = (id: string) => items.find((p) => p.id === id)?.name;
  const label = scopeLabel({
    kind,
    chosenIds: chosen,
    nameOf,
    current,
    workspace,
    loading: itemsLoading,
  });
  // A ticked product the list no longer holds (a search narrowed it) stays listed.
  const listed: ScopeItem[] = [
    ...chosen.filter((id) => !items.some((p) => p.id === id)).map((id) => ({ id, name: id })),
    ...items,
  ];
  const full = maxChosen !== undefined && chosen.length >= maxChosen;
  const option = (active: boolean) =>
    `w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 ${
      active ? "bg-accent font-medium" : ""
    }`;

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={`${testIdBase}-selector`}
        className="flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs font-medium disabled:opacity-50"
        onClick={() => setOpen(!open)}
        disabled={disabled}
      >
        <svg
          className="h-3.5 w-3.5 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        {label.lead ? <span className="text-muted-foreground">{label.lead} </span> : null}
        <span>{label.detail}</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border bg-popover p-2 shadow-md"
          role="dialog"
          aria-label="Choose what to search"
        >
          <button
            type="button"
            data-testid={`${testIdBase}-this`}
            className={option(kind === "this")}
            disabled={!current}
            onClick={() => {
              onPickThis();
              setOpen(false);
            }}
          >
            {SCOPE_WORDS.this}
            {current ? `: ${current.name}` : ""}
          </button>
          {!current && currentNote ? (
            <p className="px-2 pb-1 text-xs text-muted-foreground">{currentNote}</p>
          ) : null}
          <button
            type="button"
            data-testid={`${testIdBase}-workspace`}
            className={option(kind === "workspace")}
            disabled={!workspace}
            onClick={() => {
              onPickWorkspace();
              setOpen(false);
            }}
          >
            {SCOPE_WORDS.workspace}
            {workspace ? `: ${workspaceText(workspace.name, workspace.count)}` : ""}
          </button>
          {!workspace && workspaceNote ? (
            <p className="px-2 pb-1 text-xs text-muted-foreground">{workspaceNote}</p>
          ) : null}
          <hr className="my-1 border-border" />
          <fieldset>
            <legend className="px-2 py-1 text-xs font-medium text-muted-foreground">
              {SCOPE_WORDS.chosen}
            </legend>
            <div className="max-h-48 overflow-y-auto">
              {listed.map((p) => {
                const checked = chosen.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-input"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={() => onToggle(p)}
                    />
                    <span className="truncate">{p.name}</span>
                  </label>
                );
              })}
              {itemsLoading ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
              ) : listed.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No products found</p>
              ) : null}
            </div>
          </fieldset>
          <p className="mt-1 px-2 text-xs text-muted-foreground">
            {SCOPE_WORDS.hint}
            {maxChosen !== undefined ? ` Up to ${maxChosen}.` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
