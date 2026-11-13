"use client";

/**
 * Issue #2347 (epic #2328) — the Requirements tab as the real list: the
 * project's requirements across every change request, each with its change
 * request (by title), its status and the state of its formal review.
 *
 * Filtered by change request and status, and searched by title, on the server
 * (`GET /api/projects/:projectId/requirements`), a page at a time, so it stays
 * usable at several hundred. From a row an analyst can approve a requirement,
 * edit it, or tick rows and request a review, without opening the analysis
 * page. Each calls the same guarded endpoint as the analysis page
 * (`PUT /api/requirements/:id`, `POST /api/projects/:projectId/reviews`); the
 * buttons here are a convenience, not the control. Editing an approved
 * requirement shows the #2219 warning first (`RequirementApprovalWarning`).
 *
 * Every title renders as React text, never markup.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { analysisApi } from "@/lib/analysis-api";
import { requirementUpdateApi } from "@/lib/collaboration-api";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/lib/auth-context";
import { defaultRolesHolding } from "@/lib/permission-hints";
import { useAppMutation } from "@/lib/use-app-mutation";
import {
  requirementsListApi,
  type RequirementListRow,
  type RequirementListStatus,
} from "@/lib/requirements-list-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HoverHint } from "@/components/spec-kit/hover-hint";
import { RequestReviewCard } from "@/components/reviews/request-review-card";
import { RequirementApprovalWarning } from "@/components/requirements/RequirementApprovalWarning";
import { APPROVAL_LADDER_RUNGS, ApprovalLadderNote } from "./approval-ladder";

export const REQUIREMENTS_PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

export const STATUS_LABELS: Record<RequirementListStatus, string> = {
  draft: "Awaiting review",
  approved: "Approved",
  rejected: "Rejected",
  deferred: "Deferred",
};

/** A formal review's status in words, as the analyst reads it on a row. */
export const ROW_REVIEW_LABELS: Record<string, string> = {
  draft: "Review requested (not sent)",
  in_review: "In review",
  approved: "Review approved",
  rejected: "Review rejected",
};

/** The query key of one page of the list; under `analyses` so a review or approval refreshes it. */
export function requirementsListKey(projectId: string, filters: Record<string, unknown>) {
  return [...queryKeys.analyses.all, "requirements-list", projectId, filters] as const;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

function analysisHref(projectId: string, analysisId: string): string {
  return `/projects/${projectId}/analysis?analysisId=${encodeURIComponent(analysisId)}`;
}

/**
 * A change request's name: its title, else the date it started, the same way
 * the server names it on a row (`project-requirements-list.ts`), so the filter
 * and the rows name one change request alike.
 */
export function changeRequestName(run: { title?: string | null; startedAt: string }): string {
  const title = run.title?.trim();
  if (title) return title;
  const started = new Date(run.startedAt);
  return Number.isNaN(started.getTime())
    ? "Untitled change request"
    : `Analysis of ${started.toISOString().slice(0, 10)}`;
}

function isConflict(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 409;
}

/**
 * #2436 — the author of a requirement approving it in a project that does not
 * allow self-approval: the server's own sentence says why and who can change it.
 */
function selfApprovalRefusal(err: unknown): string | null {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === "SELF_APPROVAL_FORBIDDEN" && typeof e.message === "string" ? e.message : null;
}

/** #2436 — why Approve is disabled for a role without `requirement.approve`. */
export const APPROVE_HINT = `Approving needs the requirement.approve permission (${defaultRolesHolding("requirement.approve")} by default). You can still request a review.`;
/**
 * #2452 — why Approve is disabled on a row the viewer wrote or edited, in a
 * project that does not allow self-approval: said before the click, as the
 * permission is, rather than as a refusal toast after it.
 */
export const SELF_APPROVAL_HINT =
  "You wrote or edited this requirement, so someone else must approve it. You can still request a review. A coordinator or admin can allow self-approval in Project settings → Approval gate.";
/** Why Edit is disabled for a role without `project.update`. */
export const EDIT_HINT = "Editing needs a coordinator or admin role.";

/** What a 409 on a row's write means, and what to do next. */
export const EDIT_CONFLICT_MESSAGE =
  "Someone changed this requirement since the list was read. The list has been read again. Your text is still here to copy: close this and edit the requirement once more.";
export const APPROVE_CONFLICT_MESSAGE =
  "Someone changed this requirement since the list was read. The list has been read again: check it, then approve it once more.";

/** Edit a requirement's title and description from the list (#2219 warning first). */
function EditRequirementDialog({
  row,
  onClose,
  invalidate,
}: {
  row: RequirementListRow | null;
  onClose: () => void;
  invalidate: readonly unknown[][];
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  // A failed save keeps the dialog, and what was typed, open (#2347 review).
  const [failure, setFailure] = useState<{ message: string; conflict: boolean } | null>(null);
  useEffect(() => {
    if (!row) return;
    setTitle(row.title);
    setBody(row.body);
    setFailure(null);
  }, [row]);
  const save = useAppMutation({
    mutationFn: (input: { id: string; version: number; title: string; body: string }) =>
      requirementUpdateApi.update(input.id, {
        title: input.title,
        body: input.body,
        version: input.version,
      }),
    successMessage: "Requirement saved",
    errorMessage: (err) =>
      isConflict(err) ? EDIT_CONFLICT_MESSAGE : "Saving the requirement failed. Try again.",
    invalidateKeys: invalidate,
    onSuccess: () => onClose(),
    onError: (err) => {
      const conflict = isConflict(err);
      setFailure({
        conflict,
        message: conflict
          ? EDIT_CONFLICT_MESSAGE
          : "Saving the requirement failed. Your text is kept; try again.",
      });
      // The 409 says the list has been read again, so read it again.
      if (conflict) {
        for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
      }
    },
  });
  return (
    <Dialog open={row !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit requirement</DialogTitle>
          <DialogDescription>
            Each save is recorded as a new version. Acceptance criteria, type and priority are
            edited on the change request&apos;s page.
          </DialogDescription>
        </DialogHeader>
        {row ? (
          <RequirementApprovalWarning
            requirementId={row.id}
            version={row.version}
            reviewStatus={row.reviewStatus}
          />
        ) : null}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!row) return;
            save.mutate({
              id: row.id,
              version: row.version,
              title: title.trim(),
              body: body.trim(),
            });
          }}
        >
          <div>
            <Label htmlFor="req-list-edit-title">Title</Label>
            <Input
              id="req-list-edit-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={255}
            />
          </div>
          <div>
            <Label htmlFor="req-list-edit-body">Description</Label>
            <textarea
              id="req-list-edit-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full rounded border border-border bg-muted/40 p-2 text-sm"
            />
          </div>
          {failure ? (
            <p role="alert" className="text-sm text-destructive" data-testid="req-list-edit-error">
              {failure.message}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              // After a 409 the version read is stale: a second save would only
              // be refused again, so it waits for the requirement to be reopened.
              disabled={!title.trim() || save.isPending || Boolean(failure?.conflict)}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RequirementsList({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  // #1566 — Edit is a `project.update` write server-side. #2436 — Approve is a
  // `requirement.approve` one: a role may hold either without the other.
  const canEdit = user?.permissions.includes("project.update") ?? false;
  const canApprove = user?.permissions.includes("requirement.approve") ?? false;
  // #732 — the server gates review creation on `review.create`.
  const canRequestReview = user?.permissions.includes("review.create") ?? false;
  // #1566 — a `developer` may request reviews but not approve or edit.
  // #2452 — and a row the viewer wrote, in a project without self-approval,
  // says why before the click (the server marks it `selfApprovalForbidden`).
  const approveHintFor = (row: RequirementListRow): string | undefined =>
    !canApprove ? APPROVE_HINT : row.selfApprovalForbidden ? SELF_APPROVAL_HINT : undefined;
  const editHint = canEdit ? undefined : EDIT_HINT;

  const [analysisId, setAnalysisId] = useState("");
  const [status, setStatus] = useState<RequirementListStatus | "">("");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlyMap<string, RequirementListRow>>(new Map());
  const [editing, setEditing] = useState<RequirementListRow | null>(null);

  // A filter change starts again from the first page.
  useEffect(() => setPage(1), [analysisId, status, q]);

  const runs = useQuery({
    queryKey: queryKeys.analyses.forProject(projectId),
    queryFn: () => analysisApi.listForProject(projectId),
    enabled: Boolean(projectId),
  });
  const filters = { analysisId, status, q, page };
  const listKey = requirementsListKey(projectId, filters);
  const list = useQuery({
    queryKey: listKey,
    queryFn: () =>
      requirementsListApi.list(projectId, {
        ...(analysisId ? { analysisId } : {}),
        ...(status ? { status } : {}),
        ...(q ? { q } : {}),
        page,
        pageSize: REQUIREMENTS_PAGE_SIZE,
      }),
    enabled: Boolean(projectId),
    placeholderData: (previous) => previous,
  });
  const invalidate = [[...queryKeys.analyses.all]] as unknown[][];
  const qc = useQueryClient();

  const approve = useAppMutation({
    mutationFn: (row: RequirementListRow) =>
      requirementUpdateApi.update(row.id, { reviewStatus: "approved", version: row.version }),
    successMessage: "Requirement approved",
    errorMessage: (err) =>
      isConflict(err)
        ? APPROVE_CONFLICT_MESSAGE
        : (selfApprovalRefusal(err) ?? "Approving the requirement failed. Try again."),
    invalidateKeys: invalidate,
    onError: (err) => {
      // The 409 says the list has been read again, so read it again.
      if (isConflict(err)) {
        for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
      }
    },
  });

  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  // #2347 review — past the search cap the server counts only the rows it kept.
  const totalIsLowerBound = list.data?.totalIsLowerBound ?? false;
  const pages = Math.max(1, Math.ceil(total / REQUIREMENTS_PAGE_SIZE));
  // When the total shrinks under the page (its last row approved away under a
  // status filter, say), go to the last page that exists.
  const settled = list.data !== undefined && !list.isPlaceholderData;
  useEffect(() => {
    if (settled && page > pages) setPage(pages);
  }, [settled, page, pages]);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const toggle = (row: RequirementListRow, on: boolean) => {
    const next = new Map(selected);
    if (on) next.set(row.id, row);
    else next.delete(row.id);
    setSelected(next);
    setRequestedId(null);
  };
  const chosen = [...selected.values()];

  return (
    <div className="space-y-4" data-testid="requirements-list">
      <Card className="space-y-2 p-4" data-testid="approval-ladder">
        <h2 className="text-base font-semibold">Three ways a requirement gets approved</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {APPROVAL_LADDER_RUNGS.map((r) => (
            <li key={r.name}>
              <span className="font-medium">{r.name}</span>: {r.text}
            </li>
          ))}
        </ol>
        <ApprovalLadderNote projectId={projectId} />
      </Card>

      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <Label htmlFor="requirements-filter-cr">Change request</Label>
            <select
              id="requirements-filter-cr"
              data-testid="requirements-filter-cr"
              value={analysisId}
              onChange={(e) => setAnalysisId(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All change requests</option>
              {(runs.data?.items ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {changeRequestName(a)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="requirements-filter-status">Status</Label>
            <select
              id="requirements-filter-status"
              data-testid="requirements-filter-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as RequirementListStatus | "")}
              className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Any status</option>
              {(Object.keys(STATUS_LABELS) as RequirementListStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="requirements-search">Search titles</Label>
            <Input
              id="requirements-search"
              data-testid="requirements-search"
              value={search}
              maxLength={200}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title"
              className="mt-1"
            />
          </div>
        </div>

        {list.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading requirements…
          </p>
        ) : list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load this project&apos;s requirements.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="requirements-list-empty">
            {analysisId || status || q
              ? "No requirement matches these filters."
              : "No requirements yet. They come out of a change request."}
          </p>
        ) : (
          <ul className="divide-y" aria-label="Requirements">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-start gap-3 py-2 text-sm"
                data-testid={`requirements-row-${row.id}`}
              >
                {canRequestReview ? (
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Choose ${row.title} for a review`}
                    checked={selected.has(row.id)}
                    onChange={(e) => toggle(row, e.target.checked)}
                  />
                ) : null}
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="break-words font-medium">{row.title}</p>
                  <p className="text-xs text-muted-foreground">
                    <Link
                      href={analysisHref(projectId, row.changeRequest.id)}
                      className="underline-offset-2 hover:underline"
                    >
                      {row.changeRequest.title}
                    </Link>
                    {" · "}
                    <span data-testid={`requirements-status-${row.id}`}>
                      {STATUS_LABELS[row.reviewStatus]}
                    </span>
                    {row.review ? (
                      <>
                        {" · "}
                        <Link
                          href={`/reviews/${encodeURIComponent(row.review.id)}`}
                          className="underline-offset-2 hover:underline"
                          data-testid={`requirements-review-${row.id}`}
                        >
                          {ROW_REVIEW_LABELS[row.review.status] ?? row.review.status}
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex gap-1">
                  {row.reviewStatus === "approved" ? null : (
                    <HoverHint hint={approveHintFor(row)}>
                      <Button
                        size="sm"
                        variant="outline"
                        // Only the row being approved waits, not every row.
                        disabled={
                          approveHintFor(row) !== undefined ||
                          (approve.isPending && approve.variables?.id === row.id)
                        }
                        onClick={() => approve.mutate(row)}
                        data-testid={`requirements-approve-${row.id}`}
                      >
                        Approve
                      </Button>
                    </HoverHint>
                  )}
                  <HoverHint hint={editHint}>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canEdit}
                      onClick={() => setEditing(row)}
                      data-testid={`requirements-edit-${row.id}`}
                    >
                      Edit
                    </Button>
                  </HoverHint>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground" data-testid="requirements-list-count">
            {totalIsLowerBound
              ? `${total.toLocaleString("en-US")}+ requirements (the search shows the ${total.toLocaleString("en-US")} most recently updated matches)`
              : `${total} requirement${total === 1 ? "" : "s"}`}
            {pages > 1 ? ` · page ${page} of ${pages}` : ""}
          </span>
          {pages > 1 ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </div>

        {canRequestReview && user ? (
          chosen.length > 0 ? (
            // Not re-keyed on the selection: ticking one more row keeps the
            // reviewers picked and the title typed (the card reconciles its scope).
            <RequestReviewCard
              projectId={projectId}
              requirementIds={chosen.map((r) => r.id)}
              requirements={chosen.map((r) => ({
                id: r.id,
                title: r.title,
                reviewStatus: r.reviewStatus,
              }))}
              currentUserId={user.id}
              canBaseline={user.permissions.includes("review.admin")}
              canApprove={canApprove}
              // #2347 review — named for its scope: the summary below has its own
              // card for the whole change request.
              triggerLabel={`Request review of ${chosen.length} selected`}
              heading={`Review ${chosen.length} selected requirement${chosen.length === 1 ? "" : "s"}`}
              testId="requirements-list-request-review"
              // A requested review clears the ticks, so the same rows are not
              // offered for a second, duplicate review.
              onRequested={(reviewId) => {
                setSelected(new Map());
                setRequestedId(reviewId);
              }}
            />
          ) : requestedId ? (
            <p role="status" className="text-sm" data-testid="requirements-list-review-done">
              Review requested.{" "}
              <Link href={`/reviews/${encodeURIComponent(requestedId)}`} className="underline">
                Open the review
              </Link>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="requirements-review-hint">
              Tick requirements to request a formal review of them.
            </p>
          )
        ) : null}
      </Card>

      <EditRequirementDialog
        row={editing}
        onClose={() => setEditing(null)}
        invalidate={invalidate}
      />
    </div>
  );
}
