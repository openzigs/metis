"use client";

/**
 * Issue #1838 (epic #1828) — similar requirements and the duplicate warning.
 *
 *   - `SimilarRequirementsPanel` — on a requirement's card: up to 5 similar
 *     requirements of the project with their label, status and how many of
 *     their saved code links are fresh or stale. A likely duplicate raises a
 *     warning with "Mark as duplicate" (the existing `duplicates` link) and
 *     "Not a duplicate" (remembered server-side for the pair, so a reload does
 *     not raise it again).
 *   - `DraftSimilarRequirements` — while an analyst writes a new requirement:
 *     the same list for the draft text, fetched 500 ms after typing stops, with
 *     the request in flight cancelled as soon as the text changes.
 *
 * The analyst decides; METIS never merges or deletes. The label is always
 * written out — never conveyed by colour alone.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SimilarRequirementItem, SimilarRequirementLabel } from "@metis/shared";
import { ApiError, apiErrorMessage } from "@/lib/api-client";
import { requirementLinksApi } from "@/lib/requirement-links-api";
import { similarRequirementsApi } from "@/lib/similar-requirements-api";
import { requirementLinksKey } from "@/components/requirements/requirement-links-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/** Debounce before a draft is looked up. */
export const DRAFT_DEBOUNCE_MS = 500;
/** Shorter drafts say too little to compare. */
export const DRAFT_MIN_LENGTH = 12;

export const EMPTY_TEXT = "No similar requirements in this project";

const LABEL_TEXT: Record<SimilarRequirementLabel, string> = {
  duplicate: "Likely duplicate",
  overlap: "Overlaps",
  related: "Related",
};

export function similarRequirementsKey(projectId: string, requirementId: string) {
  return ["similar-requirements", projectId, requirementId] as const;
}

/** "3 code links: 2 fresh, 1 stale" — `moved` links were re-pointed and count as fresh. */
export function codeLinkSummary(links: SimilarRequirementItem["codeLinks"]): string {
  if (links.length === 0) return "No code links";
  const fresh = links.filter((l) => l.freshness === "fresh" || l.freshness === "moved").length;
  const stale = links.filter((l) => l.freshness === "stale").length;
  const unchecked = links.length - fresh - stale;
  const parts = [`${fresh} fresh`, `${stale} stale`];
  if (unchecked > 0) parts.push(`${unchecked} not yet checked`);
  return `${links.length} code link${links.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

function requirementHref(projectId: string, item: SimilarRequirementItem): string {
  const q = new URLSearchParams({ analysisId: item.analysisId, requirementId: item.requirementId });
  return `/projects/${projectId}/analysis?${q.toString()}`;
}

function nameOf(item: SimilarRequirementItem): string {
  return item.key ? `${item.key} ${item.title}` : item.title;
}

function SimilarItem({
  projectId,
  item,
}: {
  projectId: string;
  item: SimilarRequirementItem;
}): React.ReactElement {
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded bg-muted/40 px-2 py-1.5 text-xs"
      data-testid="similar-requirement"
    >
      <Badge variant={item.label === "duplicate" ? "warning" : "outline"}>
        {LABEL_TEXT[item.label]}
      </Badge>
      <Link href={requirementHref(projectId, item)} className="min-w-0 truncate underline">
        {nameOf(item)}
      </Link>
      <span className="text-muted-foreground">{item.status}</span>
      <span className="text-muted-foreground">{codeLinkSummary(item.codeLinks)}</span>
    </li>
  );
}

function SimilarList({
  projectId,
  items,
}: {
  projectId: string;
  items: SimilarRequirementItem[];
}): React.ReactElement {
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="similar-requirements-empty">
        {EMPTY_TEXT}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((item) => (
        <SimilarItem key={item.requirementId} projectId={projectId} item={item} />
      ))}
    </ul>
  );
}

function DuplicateWarning({
  projectId,
  requirementId,
  item,
}: {
  projectId: string;
  requirementId: string;
  item: SimilarRequirementItem;
}): React.ReactElement {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({
      queryKey: similarRequirementsKey(projectId, requirementId),
    });
    await queryClient.invalidateQueries({ queryKey: requirementLinksKey(requirementId) });
  };
  const mark = useMutation({
    mutationFn: () =>
      requirementLinksApi.create(requirementId, {
        targetRequirementId: item.requirementId,
        type: "duplicates",
      }),
    onSuccess: refresh,
    onError: (err) =>
      toast.error(apiErrorMessage(err as ApiError, "Could not mark it as a duplicate")),
  });
  const dismiss = useMutation({
    mutationFn: () =>
      similarRequirementsApi.notDuplicate(projectId, requirementId, item.requirementId),
    onSuccess: refresh,
    onError: (err) => toast.error(apiErrorMessage(err as ApiError, "Could not save your answer")),
  });
  const busy = mark.isPending || dismiss.isPending;
  const links = item.codeLinks.length;
  return (
    <div
      role="alert"
      className="space-y-2 rounded border border-warning/40 bg-warning-muted p-2 text-xs"
      data-testid="duplicate-warning"
    >
      <p>
        <strong>Possible duplicate:</strong> {nameOf(item)} looks like the same requirement
        {links > 0 ? ` (it already links to ${links} file${links === 1 ? "" : "s"})` : ""}.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => mark.mutate()}
          aria-label={`Mark as duplicate of ${nameOf(item)}`}
        >
          Mark as duplicate
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => dismiss.mutate()}
          aria-label={`Not a duplicate of ${nameOf(item)}`}
        >
          Not a duplicate
        </Button>
      </div>
    </div>
  );
}

export function SimilarRequirementsPanel({
  projectId,
  requirementId,
}: {
  projectId: string;
  requirementId: string;
}): React.ReactElement {
  const query = useQuery({
    queryKey: similarRequirementsKey(projectId, requirementId),
    queryFn: ({ signal }) =>
      similarRequirementsApi.forRequirement(projectId, requirementId, signal),
    staleTime: 5 * 60_000,
  });
  const items = query.data?.items ?? [];
  const warnings = items.filter(
    (i) => i.label === "duplicate" && !i.notDuplicate && !i.linkedAsDuplicate,
  );
  return (
    <section
      className="mt-3 space-y-2 border-t border-border pt-3"
      aria-label="Similar requirements"
      data-testid="similar-requirements"
    >
      <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Similar requirements
      </h5>
      {warnings.map((item) => (
        <DuplicateWarning
          key={item.requirementId}
          projectId={projectId}
          requirementId={requirementId}
          item={item}
        />
      ))}
      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Looking for similar requirements…</p>
      ) : query.isError ? (
        <p className="text-xs text-muted-foreground" role="status">
          Similar requirements could not be loaded.
        </p>
      ) : (
        <SimilarList projectId={projectId} items={items} />
      )}
    </section>
  );
}

export function DraftSimilarRequirements({
  projectId,
  text,
}: {
  projectId: string;
  text: string;
}): React.ReactElement | null {
  const [items, setItems] = useState<SimilarRequirementItem[] | null>(null);
  const draft = text.trim();

  useEffect(() => {
    if (draft.length < DRAFT_MIN_LENGTH) {
      setItems(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      similarRequirementsApi
        .forDraft(projectId, draft, controller.signal)
        .then((res) => {
          // A late answer to text the analyst has since changed is not shown.
          if (!controller.signal.aborted) setItems(res?.items ?? []);
        })
        .catch(() => {
          // Aborted by a newer keystroke, or failed: the list simply stays as it was.
        });
    }, DRAFT_DEBOUNCE_MS);
    // A change to the text cancels the wait AND the request already in flight.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, draft]);

  if (items === null) return null;
  const duplicate = items.find((i) => i.label === "duplicate");
  return (
    <section
      className="mt-2 space-y-2"
      aria-label="Similar requirements"
      data-testid="draft-similar-requirements"
    >
      {duplicate ? (
        <p role="alert" className="rounded border border-warning/40 bg-warning-muted p-2 text-xs">
          <strong>Before you add this:</strong> {nameOf(duplicate)} looks like a duplicate
          {duplicate.codeLinks.length > 0
            ? ` (it already links to ${duplicate.codeLinks.length} file${duplicate.codeLinks.length === 1 ? "" : "s"})`
            : ""}
          .
        </p>
      ) : null}
      <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Similar requirements
      </h5>
      <SimilarList projectId={projectId} items={items} />
    </section>
  );
}
