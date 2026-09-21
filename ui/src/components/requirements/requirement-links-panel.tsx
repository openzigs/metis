"use client";

/**
 * Requirement links panel — Epic #610 (#625).
 *
 * Renders a single requirement's typed cross-project links in both directions
 * (outgoing, where this requirement is the source, and incoming, where it is the
 * target) with direction-aware semantics ("depends on" vs "required by"), a
 * distinct project badge + deep-link for cross-project counterparts, and an
 * add-link dialog with workspace-scoped, debounced requirement search.
 *
 * The create / unlink flows call the #624 API and refresh the panel in place
 * (no reload). Cycle-guard / authz / duplicate errors from the server surface as
 * actionable inline messages. All controls are keyboard-accessible with explicit
 * labels, and the dialog is a Radix (shadcn) dialog so focus is trapped and
 * Escape closes it.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { REQUIREMENT_LINK_TYPES, type RequirementLinkType } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import {
  requirementLinksApi,
  type LinkedRequirementRef,
  type RequirementLinkView,
} from "@/lib/requirement-links-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface RequirementLinksPanelProps {
  projectId: string;
  requirementId: string;
  /** The requirement's workspace; null when the project has no workspace. */
  workspaceId?: string | null;
}

export function requirementLinksKey(requirementId: string) {
  return ["requirement-links", requirementId] as const;
}

/** Human labels for each link type, keyed by direction relative to this req. */
const OUTGOING_LABELS: Record<RequirementLinkType, string> = {
  relates_to: "relates to",
  duplicates: "duplicates",
  depends_on: "depends on",
  derived_from: "derived from",
};

const INCOMING_LABELS: Record<RequirementLinkType, string> = {
  relates_to: "relates to",
  duplicates: "duplicated by",
  depends_on: "required by",
  derived_from: "source of",
};

/** Title-case placeholder label for a link type in the picker. */
const TYPE_OPTION_LABELS: Record<RequirementLinkType, string> = {
  relates_to: "Relates to",
  duplicates: "Duplicates",
  depends_on: "Depends on",
  derived_from: "Derived from",
};

export function linkSemantics(
  type: RequirementLinkType,
  direction: "outgoing" | "incoming",
): string {
  return direction === "outgoing" ? OUTGOING_LABELS[type] : INCOMING_LABELS[type];
}

/** One rendered link row (either direction). */
function LinkRow({
  link,
  direction,
  currentProjectId,
  onUnlink,
  unlinking,
}: {
  link: RequirementLinkView;
  direction: "outgoing" | "incoming";
  currentProjectId: string;
  onUnlink: (linkId: string) => void;
  unlinking: boolean;
}): React.ReactElement {
  const counterpart = link.requirement;
  const crossProject = counterpart.projectId !== currentProjectId;
  const arrow = direction === "outgoing" ? "→" : "←";
  return (
    <li
      data-testid="requirement-link-row"
      className="flex items-center justify-between gap-2 rounded bg-zinc-900/40 px-2 py-1.5"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-zinc-500">
            {arrow}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            {linkSemantics(link.type, direction)}
          </span>
          <span className="truncate text-xs text-zinc-200">{counterpart.title}</span>
          {crossProject ? (
            <a
              href={`/projects/${counterpart.projectId}/analysis`}
              data-testid="cross-project-badge"
              aria-label={`Open project ${counterpart.projectName}`}
              className="rounded"
            >
              <Badge variant="outline">{counterpart.projectName}</Badge>
            </a>
          ) : null}
        </div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onUnlink(link.id)}
        disabled={unlinking}
        aria-label={`Unlink ${counterpart.title}`}
      >
        Unlink
      </Button>
    </li>
  );
}

/** Add-link dialog body: type picker + debounced workspace search + create. */
function AddLinkDialog({
  open,
  onOpenChange,
  projectId,
  requirementId,
  workspaceId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  requirementId: string;
  workspaceId?: string | null;
  onCreated: () => void;
}): React.ReactElement {
  const [type, setType] = useState<RequirementLinkType>("relates_to");
  const [rawQuery, setRawQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Debounce the search term so we do not fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(rawQuery.trim()), 300);
    return () => clearTimeout(handle);
  }, [rawQuery]);

  const search = useQuery({
    queryKey: ["requirement-search", workspaceId, debounced, projectId],
    queryFn: () =>
      requirementLinksApi.search(workspaceId as string, {
        q: debounced || undefined,
        pageSize: 20,
      }),
    enabled: Boolean(open && workspaceId && debounced.length > 0),
  });

  const createMutation = useMutation({
    mutationFn: (target: LinkedRequirementRef) =>
      requirementLinksApi.create(requirementId, { targetRequirementId: target.id, type }),
    onSuccess: () => {
      setErrorMessage(null);
      toast.success("Link added");
      onCreated();
      onOpenChange(false);
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to add link";
      setErrorMessage(message);
      toast.error(message);
    },
  });

  // Exclude the current requirement from results (a requirement cannot link to
  // itself); the workspace search already scopes to accessible projects.
  const results = (search.data?.items ?? []).filter((r) => r.id !== requirementId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-label="Add requirement link">
        <DialogHeader>
          <DialogTitle>Link a requirement</DialogTitle>
          <DialogDescription>
            Search across your workspace and link a requirement with a typed relationship.
          </DialogDescription>
        </DialogHeader>

        {!workspaceId ? (
          <p className="text-xs text-amber-400" role="status">
            This project is not part of a workspace, so requirement linking is unavailable.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <Label htmlFor="rl-type">Link type</Label>
              {/* Native select: a Radix Select portal nested inside the Radix
                  Dialog's focus scope recurses in jsdom, and a small fixed enum
                  needs no combobox. Styled to match the surrounding controls. */}
              <select
                id="rl-type"
                aria-label="Link type"
                value={type}
                onChange={(e) => setType(e.target.value as RequirementLinkType)}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {REQUIREMENT_LINK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_OPTION_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <Label htmlFor="rl-search">Search requirements</Label>
              <Input
                id="rl-search"
                aria-label="Search requirements"
                value={rawQuery}
                onChange={(e) => setRawQuery(e.target.value)}
                placeholder="Type to search…"
                autoComplete="off"
              />
            </div>

            {errorMessage ? (
              <p className="text-xs text-red-400" role="alert">
                {errorMessage}
              </p>
            ) : null}

            {search.isLoading ? (
              <p className="text-xs text-zinc-500" role="status">
                Searching…
              </p>
            ) : search.isError ? (
              <p className="text-xs text-red-400" role="alert">
                Failed to search requirements.
              </p>
            ) : debounced.length === 0 ? (
              <p className="text-xs text-zinc-500">Start typing to find a requirement.</p>
            ) : results.length === 0 ? (
              <p className="text-xs text-zinc-500">No matching requirements found.</p>
            ) : (
              <ul className="max-h-64 space-y-1.5 overflow-y-auto" aria-label="Search results">
                {results.map((r) => {
                  const crossProject = r.projectId !== projectId;
                  return (
                    <li
                      key={r.id}
                      data-testid="requirement-search-result"
                      className="flex items-center justify-between gap-2 rounded bg-zinc-900/40 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-xs text-zinc-200">{r.title}</span>
                          {crossProject ? <Badge variant="outline">{r.projectName}</Badge> : null}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => createMutation.mutate(r)}
                        disabled={createMutation.isPending}
                        aria-label={`Link to ${r.title}`}
                      >
                        Link
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function RequirementLinksPanel({
  projectId,
  requirementId,
  workspaceId,
}: RequirementLinksPanelProps): React.ReactElement {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const links = useQuery({
    queryKey: requirementLinksKey(requirementId),
    queryFn: () => requirementLinksApi.list(requirementId),
    enabled: Boolean(requirementId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: requirementLinksKey(requirementId) });

  const removeMutation = useMutation({
    mutationFn: (linkId: string) => requirementLinksApi.remove(linkId),
    onSuccess: () => {
      void invalidate();
      toast.success("Link removed");
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove link");
    },
  });

  const outgoing = links.data?.outgoing ?? [];
  const incoming = links.data?.incoming ?? [];
  const total = useMemo(() => outgoing.length + incoming.length, [outgoing, incoming]);

  return (
    <section
      aria-label="Linked requirements"
      data-testid="requirement-links-panel"
      className="mt-3 rounded border border-zinc-800 bg-zinc-950/40 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Linked requirements
        </h4>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          Add link
        </Button>
      </div>

      {links.isLoading ? (
        <p className="mt-2 text-xs text-zinc-500" role="status">
          Loading links…
        </p>
      ) : links.isError ? (
        <p className="mt-2 text-xs text-red-400" role="alert">
          Failed to load requirement links.
        </p>
      ) : total === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">No linked requirements yet.</p>
      ) : (
        <ul className="mt-2 space-y-1.5" aria-label="Requirement links">
          {outgoing.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              direction="outgoing"
              currentProjectId={projectId}
              onUnlink={removeMutation.mutate}
              unlinking={removeMutation.isPending}
            />
          ))}
          {incoming.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              direction="incoming"
              currentProjectId={projectId}
              onUnlink={removeMutation.mutate}
              unlinking={removeMutation.isPending}
            />
          ))}
        </ul>
      )}

      <AddLinkDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={projectId}
        requirementId={requirementId}
        workspaceId={workspaceId}
        onCreated={invalidate}
      />
    </section>
  );
}
