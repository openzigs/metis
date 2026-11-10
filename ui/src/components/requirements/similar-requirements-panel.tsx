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
 * #1840 — "Start from these citations" on a similar requirement (for a viewer
 * with edit rights only): it lists which of the item's saved code links would
 * be copied and which are skipped (needing a re-check, or borrowed themselves)
 * before the analyst confirms, then borrows exactly the listed links (#1839).
 * #1964 — and which this requirement already links (read from its chain, by
 * the borrow's own duplicate rule), so the preview never promises a copy the
 * borrow would skip.
 * They show in the requirement's code links as "Borrowed from REQ-xx, not yet
 * checked by analysis" (`traceability-view.tsx`).
 *
 * The analyst decides; METIS never merges or deletes. The label is always
 * written out — never conveyed by colour alone.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { type Query, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BORROWABLE_FRESHNESS,
  borrowDuplicateCheck,
  SIMILAR_CODE_LINKS_PER_ITEM,
  SIMILAR_REQUIREMENT_SOURCE,
  type BorrowCitationsResult,
  type HeldCodeLink,
  type RequirementTraceabilityChain,
  type SimilarRequirementCodeLink,
  type SimilarRequirementItem,
  type SimilarRequirementLabel,
} from "@metis/shared";
import { ApiError, apiErrorMessage } from "@/lib/api-client";
import { requirementLinksApi } from "@/lib/requirement-links-api";
import { similarRequirementsApi } from "@/lib/similar-requirements-api";
import { traceabilityApi } from "@/lib/traceability-api";
import { requirementLinksKey } from "@/components/requirements/requirement-links-panel";
import { traceabilityKey } from "@/components/traceability/traceability-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverHint } from "@/components/spec-kit/hover-hint";

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
  return [...similarRequirementsPrefix(projectId), requirementId] as const;
}

/** #1903 — the prefix of every similar-requirements list of a project. */
export function similarRequirementsPrefix(projectId: string) {
  return ["similar-requirements", projectId] as const;
}

/**
 * #1902 — the links the requirement holds of its own: a link it borrowed from
 * a similar requirement (#1839) is a hypothesis no analysis has checked.
 */
function ownCodeLinks(links: SimilarRequirementItem["codeLinks"]) {
  return links.filter((l) => l.source !== SIMILAR_REQUIREMENT_SOURCE);
}

/** #1914 — the files it links of its own: two links into one file are one file. */
function ownLinkedFiles(links: SimilarRequirementItem["codeLinks"]): number {
  return new Set(ownCodeLinks(links).map((l) => l.filePath)).size;
}

/**
 * " (it already links to 3 files)" for a duplicate warning, or "" when it links
 * none of its own. #1931 — past the cap the server returns only the first links,
 * so the count is a lower bound and says so.
 */
export function alreadyLinksText(item: SimilarRequirementItem): string {
  const files = ownLinkedFiles(item.codeLinks);
  if (files === 0) return "";
  const count = item.codeLinksTruncated ? `at least ${files}` : `${files}`;
  return ` (it already links to ${count} file${files === 1 ? "" : "s"})`;
}

/**
 * #1914 — a cached similar list that lists `requirementId`: the lists a borrow
 * into it changes. The others are not refetched, since each refetch reads the
 * project's requirements and may call the verifier model. #1945 — a list with
 * no answer (its fetch failed, or never ran) shows no links, so it is not one:
 * a failed list is retried the usual way, not by every borrow.
 */
function listsRequirement(requirementId: string) {
  return (query: Query): boolean => {
    const data = query.state.data as { items?: SimilarRequirementItem[] } | undefined;
    return data?.items?.some((i) => i.requirementId === requirementId) ?? false;
  };
}

/** #1931 — a list whose first fetch is still in flight: it has no answer to show yet. */
function firstFetchInFlight(query: Query): boolean {
  return query.state.data === undefined && query.state.fetchStatus !== "idle";
}

/**
 * #1990 — how many fetches of `query` have settled, with an answer or an error.
 * Unchanged while a fetch is in flight, and after one is cancelled, which puts
 * back the state it started from.
 */
function settledCount(query: Query): number {
  return query.state.dataUpdateCount + query.state.errorUpdateCount;
}

/**
 * "3 code links: 2 fresh, 1 stale" — `moved` links were re-pointed and count as
 * fresh. A borrowed link is counted apart (#1902), never as fresh or stale.
 * #1931 — `truncated`: it holds more than the links given, which the server
 * caps at `SIMILAR_CODE_LINKS_PER_ITEM`; the breakdown is of those given.
 */
export function codeLinkSummary(
  links: SimilarRequirementItem["codeLinks"],
  truncated = false,
): string {
  if (links.length === 0) return "No code links";
  const own = ownCodeLinks(links);
  const fresh = own.filter((l) => l.freshness === "fresh" || l.freshness === "moved").length;
  const stale = own.filter((l) => l.freshness === "stale").length;
  const unchecked = own.length - fresh - stale;
  const borrowed = links.length - own.length;
  const parts = [`${fresh} fresh`, `${stale} stale`];
  if (unchecked > 0) parts.push(`${unchecked} not yet checked`);
  if (borrowed > 0) parts.push(`${borrowed} borrowed`);
  if (truncated) {
    return `More than ${SIMILAR_CODE_LINKS_PER_ITEM} code links, of the ${links.length} most confident: ${parts.join(", ")}`;
  }
  return `${links.length} code link${links.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

function requirementHref(projectId: string, item: SimilarRequirementItem): string {
  const q = new URLSearchParams({ analysisId: item.analysisId, requirementId: item.requirementId });
  return `/projects/${projectId}/analysis?${q.toString()}`;
}

function nameOf(item: SimilarRequirementItem): string {
  return item.key ? `${item.key} ${item.title}` : item.title;
}

export interface BorrowPlan {
  /** Links the borrow copies. */
  copy: SimilarRequirementCodeLink[];
  /** #1964 — links to code this requirement already links: the borrow skips them. */
  alreadyLinked: SimilarRequirementCodeLink[];
  /** Links skipped until they are re-checked: stale, or never checked. */
  needsRecheck: SimilarRequirementCodeLink[];
  /** Links the similar requirement itself borrowed: a hypothesis is not lent on. */
  borrowed: SimilarRequirementCodeLink[];
}

/**
 * #1840 — what borrowing `links` into a requirement holding `held` does, by the
 * server's rules and in its order (`borrow-citations.ts`). #1964 — `held` is
 * the code the requirement already links, under any source. #1969 — `grounded`
 * is the chain's `groundedFiles`: `held` lists each code once, and can hide a
 * grounding row the server's rule still reads.
 */
export function borrowPlan(
  links: readonly SimilarRequirementCodeLink[],
  held: readonly HeldCodeLink[] = [],
  grounded: readonly string[] = [],
): BorrowPlan {
  const plan: BorrowPlan = { copy: [], alreadyLinked: [], needsRecheck: [], borrowed: [] };
  const isDuplicate = borrowDuplicateCheck(held, grounded);
  for (const link of links) {
    if (link.source === SIMILAR_REQUIREMENT_SOURCE) plan.borrowed.push(link);
    else if (!BORROWABLE_FRESHNESS.has(link.freshness)) plan.needsRecheck.push(link);
    else if (isDuplicate(link)) plan.alreadyLinked.push(link);
    else plan.copy.push(link);
  }
  return plan;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** #1840 — the toast after a borrow: what was copied and why anything was not. */
export function borrowResultText(result: BorrowCitationsResult, from: string): string {
  const skipped = [
    result.skippedDuplicate > 0 ? `${result.skippedDuplicate} already linked` : null,
    result.skippedStale > 0
      ? plural(result.skippedStale, "needs a re-check", "need a re-check")
      : null,
    result.skippedBorrowed > 0
      ? plural(result.skippedBorrowed, "borrowed itself", "borrowed themselves")
      : null,
    result.notFound > 0 ? `${result.notFound} no longer found` : null,
  ].filter((part): part is string => part !== null);
  const head =
    result.copied > 0
      ? `Copied ${plural(result.copied, "code link")} from ${from}.`
      : `No code links copied from ${from}.`;
  return skipped.length > 0 ? `${head} Skipped: ${skipped.join(", ")}.` : head;
}

/**
 * The preview's opening line. #1964 — `heldKnown`: the requirement's own links
 * were read, so the code it already links is listed apart; otherwise the borrow
 * still skips it, and the line says so.
 */
function previewText(plan: BorrowPlan, name: string, heldKnown: boolean): string {
  if (plan.copy.length > 0) {
    const copy = `Copy ${plural(plan.copy.length, "code link")} from ${name} to this requirement. They are labelled as borrowed and not yet checked by analysis.`;
    return heldKnown ? copy : `${copy} Code this requirement already links is not copied again.`;
  }
  return plan.alreadyLinked.length > 0
    ? `Nothing to copy from ${name}: this requirement already links every one of its code links known to match the current code.`
    : `Nothing to copy from ${name}: none of its code links is known to match the current code.`;
}

function linkLocation(link: SimilarRequirementCodeLink): string {
  if (link.startLine == null) return link.filePath;
  return link.endLine != null && link.endLine !== link.startLine
    ? `${link.filePath}:${link.startLine}-${link.endLine}`
    : `${link.filePath}:${link.startLine}`;
}

function LinkList({
  heading,
  links,
  testId,
}: {
  heading: string;
  links: SimilarRequirementCodeLink[];
  testId: string;
}): React.ReactElement | null {
  if (links.length === 0) return null;
  return (
    <div data-testid={testId}>
      <p className="font-medium">{heading}</p>
      <ul className="list-disc pl-5">
        {links.map((link) => (
          <li key={link.mappingId}>
            <code className="font-mono">{linkLocation(link)}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BorrowAction({
  projectId,
  requirementId,
  item,
}: {
  projectId: string;
  requirementId: string;
  item: SimilarRequirementItem;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  // #1964 — the code this requirement already links: its chain, the query the
  // code links list reads and a borrow refreshes. Read once a preview is asked for.
  const chain = useQuery<RequirementTraceabilityChain>({
    queryKey: traceabilityKey(projectId, requirementId),
    queryFn: () => traceabilityApi.chain(projectId, requirementId),
    enabled: confirming,
  });
  // A chain that cannot be read leaves duplicates to the borrow, which skips them.
  const heldKnown = chain.data !== undefined;
  const plan = borrowPlan(item.codeLinks, chain.data?.directCode, chain.data?.groundedFiles);
  const name = nameOf(item);
  const borrow = useMutation({
    mutationFn: () =>
      similarRequirementsApi.borrowCitations(projectId, requirementId, {
        fromRequirementId: item.requirementId,
        mappingIds: plan.copy.map((link) => link.mappingId),
      }),
    onSuccess: async (result) => {
      setConfirming(false);
      toast.success(borrowResultText(result, item.key ?? item.title));
      const lists = similarRequirementsPrefix(projectId);
      // #1931 — a list still on its first fetch may have read the links before
      // the borrow committed. #1945 — only a fetch already in flight as the
      // borrow answers: one a card starts after it (while the code links below
      // refresh) reads the committed links. Taken before any await. #1990 — and
      // only while that fetch is unsettled: one that answers during the refresh
      // is refetched only if it lists this requirement, and one that fails is
      // retried the usual way.
      const racing = new Map(
        queryClient
          .getQueryCache()
          .findAll({ queryKey: lists, predicate: firstFetchInFlight })
          .map((query) => [query.queryHash, settledCount(query)]),
      );
      const raced = (query: Query) => racing.get(query.queryHash) === settledCount(query);
      await queryClient.invalidateQueries({ queryKey: traceabilityKey(projectId, requirementId) });
      // Invalidating a raced list alone joins its fetch (React Query restarts a
      // fetch in flight only once the query has data), so cancel it first: the
      // refetch below then starts afresh.
      await queryClient.cancelQueries({ queryKey: lists, predicate: raced });
      // #1903 — other cards list this requirement, with the code links it now
      // holds. #1914 — only those, and the raced lists: no other list changed.
      const lister = listsRequirement(requirementId);
      await queryClient.invalidateQueries({
        queryKey: lists,
        predicate: (query) => raced(query) || lister(query),
      });
    },
    onError: (err) =>
      toast.error(apiErrorMessage(err as ApiError, "Could not copy the code links")),
  });
  if (!confirming) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        onClick={() => setConfirming(true)}
        aria-label={`Start from the citations of ${name}`}
      >
        Start from these citations
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-label={`Copy the code links of ${name}`}
      className="basis-full space-y-2 rounded border border-border bg-background p-2"
      data-testid="borrow-citations-confirm"
    >
      {chain.isPending ? (
        <p role="status">Checking the code this requirement already links…</p>
      ) : (
        <>
          <p>{previewText(plan, name, heldKnown)}</p>
          <LinkList
            heading={`Will be copied (${plan.copy.length})`}
            links={plan.copy}
            testId="borrow-will-copy"
          />
          <LinkList
            heading={`Already linked (${plan.alreadyLinked.length})`}
            links={plan.alreadyLinked}
            testId="borrow-already-linked"
          />
          <LinkList
            heading={`Skipped, stale or not yet checked: needs a re-check first (${plan.needsRecheck.length})`}
            links={plan.needsRecheck}
            testId="borrow-skipped-stale"
          />
          <LinkList
            heading={`Skipped, borrowed by ${name} itself (${plan.borrowed.length})`}
            links={plan.borrowed}
            testId="borrow-skipped-borrowed"
          />
        </>
      )}
      <div className="flex gap-2">
        {chain.isPending ? null : (
          <Button
            size="sm"
            disabled={plan.copy.length === 0 || borrow.isPending}
            onClick={() => borrow.mutate()}
          >
            {plan.copy.length > 0 ? `Copy ${plural(plan.copy.length, "link")}` : "Nothing to copy"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={borrow.isPending}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function SimilarItem({
  projectId,
  item,
  borrowInto,
}: {
  projectId: string;
  item: SimilarRequirementItem;
  /** #1840 — the requirement links may be borrowed into; absent, no action is offered. */
  borrowInto?: string;
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
      <span className="text-muted-foreground">
        {codeLinkSummary(item.codeLinks, item.codeLinksTruncated)}
      </span>
      {borrowInto && item.codeLinks.length > 0 ? (
        <BorrowAction projectId={projectId} requirementId={borrowInto} item={item} />
      ) : null}
    </li>
  );
}

function SimilarList({
  projectId,
  items,
  borrowInto,
}: {
  projectId: string;
  items: SimilarRequirementItem[];
  borrowInto?: string;
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
        <SimilarItem
          key={item.requirementId}
          projectId={projectId}
          item={item}
          borrowInto={borrowInto}
        />
      ))}
    </ul>
  );
}

function DuplicateWarning({
  projectId,
  requirementId,
  item,
  writeHint,
}: {
  projectId: string;
  requirementId: string;
  item: SimilarRequirementItem;
  writeHint?: string;
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
  return (
    <div
      role="alert"
      className="space-y-2 rounded border border-warning/40 bg-warning-muted p-2 text-xs"
      data-testid="duplicate-warning"
    >
      <p>
        <strong>Possible duplicate:</strong> {nameOf(item)} looks like the same requirement
        {/* #1902 — the code it links of its own, not what it borrowed; #1914 — in files. */}
        {alreadyLinksText(item)}.
      </p>
      <div className="flex gap-2">
        <HoverHint hint={writeHint}>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || Boolean(writeHint)}
            onClick={() => mark.mutate()}
            aria-label={`Mark as duplicate of ${nameOf(item)}`}
          >
            Mark as duplicate
          </Button>
        </HoverHint>
        <HoverHint hint={writeHint}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || Boolean(writeHint)}
            onClick={() => dismiss.mutate()}
            aria-label={`Not a duplicate of ${nameOf(item)}`}
          >
            Not a duplicate
          </Button>
        </HoverHint>
      </div>
    </div>
  );
}

export function SimilarRequirementsPanel({
  projectId,
  requirementId,
  canEdit = false,
  writeHint,
}: {
  projectId: string;
  requirementId: string;
  /** #1840 — the viewer may edit the requirement (`project.update`): offers "Start from these citations". */
  canEdit?: boolean;
  /**
   * #1591 — why the viewer cannot answer the duplicate warning: "Mark as
   * duplicate" adds a requirement link and "Not a duplicate" is remembered for
   * the pair, both `project.update` writes server-side. Set: both are disabled
   * and carry this hint. Omitted: they are enabled.
   */
  writeHint?: string;
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
          writeHint={writeHint}
        />
      ))}
      {query.isPending ? (
        <p className="text-xs text-muted-foreground">Looking for similar requirements…</p>
      ) : query.isError ? (
        <p className="text-xs text-muted-foreground" role="status">
          Similar requirements could not be loaded.
        </p>
      ) : (
        <SimilarList
          projectId={projectId}
          items={items}
          borrowInto={canEdit ? requirementId : undefined}
        />
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
          {alreadyLinksText(duplicate)}.
        </p>
      ) : null}
      <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Similar requirements
      </h5>
      <SimilarList projectId={projectId} items={items} />
    </section>
  );
}
