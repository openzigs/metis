/**
 * Issue #32 — the Workbench Documents panel: a filter box, uploaded documents
 * first in their own group, then each repository as a folder tree that starts
 * collapsed, then documents from other connectors (database schemas,
 * Confluence, Jira), one collapsed group per source.
 *
 * Collapsed folders render no children, so a repository of thousands of files
 * costs one row until it is opened. While filtering, every folder on a match's
 * path is shown open (and the folder toggles are disabled), and at most {@link SEARCH_RENDER_LIMIT} matches render —
 * the count says how many more there are.
 *
 * #526 — the tree is flattened into rows and virtualised, so an OPEN folder of
 * thousands of files mounts only the rows in view. The entries are parsed by
 * the page, once per document-list change, and shared with the context chips.
 */
"use client";

import { useDeferredValue, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_PANEL_DOCUMENTS } from "@/lib/list-all-documents";
import {
  filterEntries,
  flattenGroups,
  groupEntries,
  type PanelEntry,
  type PanelRow,
} from "@/lib/workbench-document-tree";

export const SEARCH_RENDER_LIMIT = 300;

/** Pixels each level of the tree is indented by. */
const INDENT_PX = 12;

/** A row's height before it is measured; the virtualiser corrects it on mount. */
export function estimateRowSize(row: PanelRow): number {
  if (row.type === "heading") return 28;
  if (row.type === "file" && row.entry.secondary) return 48;
  return 32;
}

/** #526 — a tree item's accessible name: the group, folder or document it stands for. */
export function treeItemLabel(row: PanelRow): string {
  if (row.type === "heading") return row.label;
  if (row.type === "folder") return row.folder.name;
  return row.entry.name;
}

export interface DocumentPanelProps {
  /** Every loaded document, parsed once by the page (`toPanelEntries`). */
  entries: readonly PanelEntry[];
  /** The project's document count, when more exist than were loaded. */
  total?: number;
  attachedIds: ReadonlySet<string>;
  onAttach: (docId: string) => void;
  onDetach: (docId: string) => void;
}

export function DocumentPanel({
  entries,
  total,
  attachedIds,
  onAttach,
  onDetach,
}: DocumentPanelProps) {
  const [query, setQuery] = useState("");
  // Typing stays responsive: the filter re-runs at a lower priority.
  const deferredQuery = useDeferredValue(query);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const searching = deferredQuery.trim().length > 0;
  const matches = useMemo(() => filterEntries(entries, deferredQuery), [entries, deferredQuery]);
  const shown = useMemo(
    () => (searching ? matches.slice(0, SEARCH_RENDER_LIMIT) : matches),
    [matches, searching],
  );
  const groups = useMemo(() => groupEntries(shown), [shown]);
  const rows = useMemo(
    () => flattenGroups(groups, (key) => searching || expanded.has(key)),
    [groups, searching, expanded],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => estimateRowSize(rows[i]),
    getItemKey: (i) => rows[i].key,
    overscan: 8,
  });

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderRow(row: PanelRow) {
    if (row.type === "heading") {
      return (
        <h3
          className="px-2 pb-1 pt-2 text-xs font-semibold uppercase text-muted-foreground"
          data-testid={`workbench-${row.group}`}
        >
          {row.label}
        </h3>
      );
    }
    const indent = { paddingLeft: row.depth * INDENT_PX };
    if (row.type === "folder") {
      const { folder } = row;
      const open = searching || expanded.has(folder.key);
      return (
        <div style={indent}>
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-accent/50"
            aria-expanded={open}
            // While filtering every folder on a match's path is open; a toggle
            // would change nothing visible, so it is disabled until the filter clears.
            disabled={searching}
            onClick={() => toggle(folder.key)}
            data-testid="workbench-folder"
          >
            <span aria-hidden="true" className="w-3 shrink-0 text-muted-foreground">
              {open ? "▾" : "▸"}
            </span>
            <span className={`truncate ${row.depth === 0 ? "font-medium" : ""}`}>
              {folder.name}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {folder.fileCount}
            </span>
          </button>
        </div>
      );
    }
    const { entry } = row;
    const isAttached = attachedIds.has(entry.doc.id);
    return (
      <div
        style={indent}
        className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-accent/50"
        data-testid={`workbench-doc-${entry.doc.id}`}
      >
        <span className="flex min-w-0 flex-1 flex-col" title={entry.title}>
          <span className="truncate">{entry.name}</span>
          {entry.secondary ? (
            <span className="truncate text-xs text-muted-foreground">{entry.secondary}</span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant={isAttached ? "outline" : "default"}
          onClick={() => (isAttached ? onDetach(entry.doc.id) : onAttach(entry.doc.id))}
          data-testid={`workbench-doc-attach-${entry.doc.id}`}
          aria-label={`${isAttached ? "Detach" : "Attach"} ${entry.name}`}
        >
          {isAttached ? "Attached" : "Attach"}
        </Button>
      </div>
    );
  }

  const hidden = searching ? matches.length - shown.length : 0;
  // Only the load ceiling leaves documents out (#440: the list is read by
  // cursor, so a concurrent insert or delete cannot drop a row).
  const truncated = total !== undefined && total > MAX_PANEL_DOCUMENTS;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Input
        type="search"
        aria-label="Filter documents"
        placeholder="Filter by name or path"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="workbench-doc-filter"
      />
      {searching && matches.length === 0 ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          No documents match “{deferredQuery.trim()}”.
        </p>
      ) : null}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto text-sm"
        data-testid="workbench-doc-scroll"
      >
        {/* #526 — a flat, virtualised tree: the hierarchy and each level's full
            size reach assistive technology through aria-level / -setsize /
            -posinset, since only the rows in view are mounted. Each group's
            heading is a level-1 item named for the group. */}
        <ul
          role="tree"
          aria-label="Documents"
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            return (
              <li
                key={item.key}
                role="treeitem"
                aria-label={treeItemLabel(row)}
                aria-level={row.level}
                aria-setsize={row.setSize}
                aria-posinset={row.posInSet}
                // A group always shows its rows; a folder only when open.
                aria-expanded={
                  row.type === "heading"
                    ? true
                    : row.type === "folder"
                      ? searching || expanded.has(row.folder.key)
                      : undefined
                }
                data-index={item.index}
                data-group={row.group}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {renderRow(row)}
              </li>
            );
          })}
        </ul>
      </div>
      {hidden > 0 ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          Showing {shown.length} of {matches.length} matches — keep typing to narrow.
        </p>
      ) : null}
      {truncated ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          Showing the first {entries.length} of {total} documents.
        </p>
      ) : null}
    </div>
  );
}
