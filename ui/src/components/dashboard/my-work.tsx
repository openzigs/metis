/**
 * #2348 — "My work" on Home: what needs the signed-in user. Their change
 * requests grouped by state (waiting on their answers, in review, rejected,
 * ready to hand off) and the reviews waiting on their decision, from ONE
 * request (`GET /api/me/work`). Empty groups are left out; with nothing at all
 * it offers the next step instead.
 */
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  hasPermission,
  type MyWorkChangeRequest,
  type MyWorkResponse,
  type MyWorkReview,
} from "@metis/shared";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { NewProjectDialog } from "@/components/projects/new-project-wizard";
import {
  changeRequestHref,
  groupChangeRequests,
  myWorkApi,
  myWorkQueryKey,
  timeInState,
} from "@/lib/my-work";

const REFRESH_MS = 30_000;

export function MyWork() {
  const q = useQuery({
    queryKey: myWorkQueryKey,
    queryFn: () => myWorkApi.get(),
    refetchInterval: REFRESH_MS,
  });
  return (
    <section aria-labelledby="my-work-heading" className="space-y-3" data-testid="my-work">
      <h2 id="my-work-heading" className="text-base font-semibold">
        My work
      </h2>
      {q.isLoading ? (
        <MyWorkSkeleton />
      ) : q.isError || !q.data ? (
        <div role="alert" className="rounded border border-dashed p-3 text-sm">
          <p>Your work could not be loaded.</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => void q.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <MyWorkContent data={q.data} />
      )}
    </section>
  );
}

function MyWorkSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading your work"
      className="grid grid-cols-1 gap-4 md:grid-cols-2"
      data-testid="my-work-loading"
    >
      {[0, 1].map((i) => (
        <Card key={i} className="space-y-2 p-4">
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </Card>
      ))}
    </div>
  );
}

function MyWorkContent({ data }: { data: MyWorkResponse }) {
  const { user } = useAuth();
  const canCreateProject = user ? hasPermission(user.role, "project.create") : false;
  // #2450 — starting a change request is an `analysis.run` write; a reader
  // would be refused by the server, so it is offered no link to start one.
  const canRunAnalysis = user?.permissions.includes("analysis.run") ?? false;
  const groups = groupChangeRequests(data.changeRequests);
  if (groups.length === 0 && data.reviews.length === 0) {
    return data.projectCount === 0 ? (
      canCreateProject ? (
        <EmptyState
          title="Nothing needs you yet"
          description="Create a project to start your first change request."
          // #273 — the first-run wizard opens in place.
          action={<NewProjectDialog />}
          data-testid="my-work-empty"
        />
      ) : (
        // A role without project.create would be refused by the server
        // (#2368): name the step that works instead.
        <EmptyState
          title="Nothing needs you yet"
          description="You are not in any project yet. Ask an admin or coordinator to add you to one."
          data-testid="my-work-empty"
        />
      )
    ) : (
      <EmptyState
        title="Nothing needs you right now"
        description="Change requests waiting on your answers or a review, and reviews assigned to you, appear here."
        action={
          canRunAnalysis ? (
            <Button asChild size="sm">
              <Link href="/projects" data-testid="my-work-new-change-request">
                New change request
              </Link>
            </Button>
          ) : undefined
        }
        data-testid="my-work-empty"
      />
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {groups.map((g) => (
        <Card key={g.state} className="p-4" data-testid={`my-work-group-${g.state}`}>
          <h3 className="mb-3 text-sm font-semibold">
            {g.label} <span className="font-normal text-muted-foreground">({g.items.length})</span>
          </h3>
          <ul className="space-y-2 text-sm">
            {g.items.map((item) => (
              <ChangeRequestRow key={item.id} item={item} />
            ))}
          </ul>
        </Card>
      ))}
      {data.reviews.length > 0 ? (
        <Card className="p-4" data-testid="my-work-reviews">
          <h3 className="mb-3 text-sm font-semibold">
            Reviews assigned to me{" "}
            <span className="font-normal text-muted-foreground">({data.reviews.length})</span>
          </h3>
          <ul className="space-y-2 text-sm">
            {data.reviews.map((r) => (
              <ReviewRow key={r.id} review={r} />
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function ChangeRequestRow({ item }: { item: MyWorkChangeRequest }) {
  return (
    <li data-testid={`my-work-cr-${item.id}`}>
      <Link
        href={changeRequestHref(item)}
        className="font-medium underline-offset-2 hover:underline"
      >
        {item.title}
      </Link>
      <p className="text-xs text-muted-foreground">
        {item.projectName} · {timeInState(item.since)}
        {item.openQuestions
          ? ` · ${item.openQuestions} question${item.openQuestions === 1 ? "" : "s"} waiting`
          : ""}
      </p>
    </li>
  );
}

function ReviewRow({ review }: { review: MyWorkReview }) {
  return (
    <li data-testid={`my-work-review-${review.id}`}>
      <Link
        href={`/reviews/${encodeURIComponent(review.id)}`}
        className="font-medium underline-offset-2 hover:underline"
      >
        {review.title}
      </Link>
      <p className="text-xs text-muted-foreground">
        {review.projectName} · requested by {review.requestedBy} · {timeInState(review.since)}
      </p>
    </li>
  );
}
