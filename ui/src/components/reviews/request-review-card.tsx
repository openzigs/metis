"use client";

/**
 * #732 — "Request review" on the Requirements hub.
 *
 * `POST /api/projects/:projectId/reviews` had no caller, so no formal review
 * (and so no automatic baseline) could be started from the UI. This opens a
 * review of the given requirements with the chosen reviewers and submits it,
 * which pins each requirement's current version for them.
 *
 * Reviewers are searched among the users who can open this project
 * (`GET /api/users?projectId=`); the requester is left out, since the server
 * refuses a self-review.
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api-client";
import { reviewsApi } from "@/lib/reviews-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface UserHit {
  id: string;
  username: string;
  displayName: string;
}

interface Props {
  projectId: string;
  /** The requirements the review covers. */
  requirementIds: readonly string[];
  /** The signed-in user — never offered as a reviewer. */
  currentUserId: string;
  /** #989 — how many of `requirementIds` are already approved. */
  approvedCount?: number;
}

export function RequestReviewCard({
  projectId,
  requirementIds,
  currentUserId,
  approvedCount = 0,
}: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Requirements review");
  const [search, setSearch] = useState("");
  const [reviewers, setReviewers] = useState<UserHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  // A draft whose submit failed: a retry submits it instead of opening another.
  // Editing the title or reviewers drops it, so the retry carries the edit.
  const [draftId, setDraftId] = useState<string | null>(null);

  const term = search.trim();
  const hits = useQuery({
    queryKey: ["users", "review-picker", projectId, term],
    queryFn: () =>
      apiFetch<UserHit[]>(
        `/users?search=${encodeURIComponent(term)}&limit=8&projectId=${encodeURIComponent(projectId)}`,
      ),
    enabled: open && term !== "",
  });
  const candidates = (hits.data ?? []).filter(
    (u) => u.id !== currentUserId && !reviewers.some((r) => r.id === u.id),
  );

  const request = useMutation({
    mutationFn: async () => {
      const id =
        draftId ??
        (
          await reviewsApi.create(projectId, {
            title: title.trim(),
            reviewerIds: reviewers.map((r) => r.id),
            items: requirementIds.map((requirementId) => ({ requirementId })),
          })
        ).id;
      setDraftId(id);
      await reviewsApi.submit(id);
      return id;
    },
    onSuccess: async (reviewId) => {
      setCreatedId(reviewId);
      setDraftId(null);
      setOpen(false);
      setError(null);
      setReviewers([]);
      setSearch("");
      // #989 — the submit moves requirements to awaiting review, so the
      // hub's counts (read from the analysis) are stale too.
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.reviews.all }),
        qc.invalidateQueries({ queryKey: queryKeys.analyses.all }),
      ]);
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Could not request the review");
    },
  });

  const count = requirementIds.length;
  const noun = `requirement${count === 1 ? "" : "s"}`;

  if (!open) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setCreatedId(null);
            setOpen(true);
          }}
          data-testid="request-review"
        >
          Request review
        </Button>
        {createdId ? (
          <p role="status" className="text-sm" data-testid="request-review-done">
            Review requested.{" "}
            <Link href={`/reviews/${createdId}`} className="underline">
              Open the review
            </Link>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className="space-y-3 p-4" data-testid="request-review-form">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          request.mutate();
        }}
      >
        <h3 className="text-sm font-semibold">Request review</h3>
        <p className="text-xs text-muted-foreground">
          Asks the reviewers to approve or reject these {count} {noun} at their current versions.
          Approval creates a baseline.
        </p>
        <p className="text-xs text-muted-foreground" data-testid="request-review-status-note">
          {approvedCount > 0
            ? `${approvedCount} of them ${approvedCount === 1 ? "is" : "are"} already approved and stay${approvedCount === 1 ? "s" : ""} approved unless the review is rejected. `
            : ""}
          The rest show as awaiting review until it is decided. Withdrawing the review puts every
          status back.
        </p>
        <div className="space-y-1">
          <Label htmlFor="review-title">Title</Label>
          <Input
            id="review-title"
            value={title}
            maxLength={255}
            onChange={(e) => {
              setTitle(e.target.value);
              setDraftId(null);
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="review-reviewer-search">Reviewers</Label>
          <Input
            id="review-reviewer-search"
            placeholder="Search people who can open this project"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {candidates.length > 0 ? (
            <ul className="divide-y rounded-md border" aria-label="Matching people">
              {candidates.map((u) => (
                <li key={u.id} className="flex items-center justify-between px-2 py-1 text-sm">
                  <span>
                    {u.displayName} <span className="text-muted-foreground">@{u.username}</span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setReviewers((prev) => [...prev, u]);
                      setDraftId(null);
                    }}
                  >
                    Add {u.displayName}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {reviewers.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Selected reviewers">
              {reviewers.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs"
                >
                  {r.displayName}
                  <button
                    type="button"
                    className="underline"
                    aria-label={`Remove ${r.displayName}`}
                    onClick={() => {
                      setReviewers((prev) => prev.filter((x) => x.id !== r.id));
                      setDraftId(null);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={!title.trim() || reviewers.length === 0 || count === 0 || request.isPending}
          >
            {request.isPending ? "Requesting…" : `Request review of ${count} ${noun}`}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
