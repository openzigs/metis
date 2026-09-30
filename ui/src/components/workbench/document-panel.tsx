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
 */
"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DocumentRow } from "@/lib/projects-api";
import type { RepoNameMap } from "@/hooks/use-repo-names";
import { MAX_PANEL_DOCUMENTS } from "@/lib/list-all-documents";
import {
  filterEntries,
  groupEntries,
  toPanelEntries,
  type FolderNode,
  type PanelEntry,
} from "@/lib/workbench-document-tree";

export const SEARCH_RENDER_LIMIT = 300;

export interface DocumentPanelProps {
  documents: readonly DocumentRow[];
  /** The project's document count, when more exist than were loaded. */
  total?: number;
  repoNames?: RepoNameMap;
  attachedIds: readonly string[];
  onAttach: (docId: string) => void;
  onDetach: (docId: string) => void;
}

export function DocumentPanel({
  documents,
  total,
  repoNames,
  attachedIds,
  onAttach,
  onDetach,
}: DocumentPanelProps) {
  const [query, setQuery] = useState("");
  // Typing stays responsive: the filter re-runs at a lower priority.
  const deferredQuery = useDeferredValue(query);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const entries = useMemo(() => toPanelEntries(documents, repoNames), [documents, repoNames]);
  const searching = deferredQuery.trim().length > 0;
  const matches = useMemo(() => filterEntries(entries, deferredQuery), [entries, deferredQuery]);
  const shown = useMemo(
    () => (searching ? matches.slice(0, SEARCH_RENDER_LIMIT) : matches),
    [matches, searching],
  );
  const groups = useMemo(() => groupEntries(shown), [shown]);

  const attached = useMemo(() => new Set(attachedIds), [attachedIds]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const isOpen = (key: string) => searching || expanded.has(key);

  function renderFile(entry: PanelEntry) {
    const isAttached = attached.has(entry.doc.id);
    return (
      <li
        key={entry.doc.id}
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
      </li>
    );
  }

  function renderFolder(folder: FolderNode, depth: number) {
    const open = isOpen(folder.key);
    return (
      <li key={folder.key}>
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
          <span className={`truncate ${depth === 0 ? "font-medium" : ""}`}>{folder.name}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{folder.fileCount}</span>
        </button>
        {open ? (
          <ul className="ml-3 border-l pl-1">
            {folder.folders.map((child) => renderFolder(child, depth + 1))}
            {folder.files.map(renderFile)}
          </ul>
        ) : null}
      </li>
    );
  }

  const hidden = searching ? matches.length - shown.length : 0;
  // Only the load ceiling leaves documents out; a row lost to offset drift
  // mid-read is not a reason to claim the list was cut short.
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
      <div className="min-h-0 flex-1 overflow-y-auto text-sm">
        {searching && matches.length === 0 ? (
          <p role="status" className="px-2 text-xs text-muted-foreground">
            No documents match “{deferredQuery.trim()}”.
          </p>
        ) : null}
        {groups.uploads.length > 0 ? (
          <section aria-label="Uploaded documents" data-testid="workbench-uploads">
            <h3 className="px-2 pb-1 text-xs font-semibold uppercase text-muted-foreground">
              Uploaded
            </h3>
            <ul className="space-y-1">{groups.uploads.map(renderFile)}</ul>
          </section>
        ) : null}
        {groups.repos.length > 0 ? (
          <section aria-label="Repository files" className="mt-2" data-testid="workbench-repos">
            <h3 className="px-2 pb-1 text-xs font-semibold uppercase text-muted-foreground">
              Repositories
            </h3>
            <ul>{groups.repos.map((repo) => renderFolder(repo, 0))}</ul>
          </section>
        ) : null}
        {groups.sources.length > 0 ? (
          <section aria-label="Other sources" className="mt-2" data-testid="workbench-sources">
            <h3 className="px-2 pb-1 text-xs font-semibold uppercase text-muted-foreground">
              Other sources
            </h3>
            <ul>{groups.sources.map((source) => renderFolder(source, 0))}</ul>
          </section>
        ) : null}
        {hidden > 0 ? (
          <p role="status" className="px-2 pt-2 text-xs text-muted-foreground">
            Showing {shown.length} of {matches.length} matches — keep typing to narrow.
          </p>
        ) : null}
        {truncated ? (
          <p role="status" className="px-2 pt-2 text-xs text-muted-foreground">
            Showing the first {documents.length} of {total} documents.
          </p>
        ) : null}
      </div>
    </div>
  );
}
