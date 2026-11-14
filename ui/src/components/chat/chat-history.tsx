"use client";

/**
 * Issue #2350 — the analyst's past conversations on `/chat`: each with its
 * title, what it searches and when it was last used. Opening one resumes it.
 * This replaces Activity → Sessions (`/sessions` now redirects here).
 *
 * The list is the server's (`GET /api/ai/sessions`): only the caller's own
 * chats, in projects they can still reach. Nothing here filters by user.
 */
import { useEffect } from "react";
import Link from "next/link";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ResumableSessionDto } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { SkeletonText } from "@/components/ui/skeleton";
import { sdkApi } from "@/lib/sdk-alignment-api";
import { workspaceListQuery } from "@/lib/active-workspace";
import { SCOPE_WORDS } from "@/components/scope/scope-picker";
import { timeAgo } from "@/lib/time-ago";

export const CHAT_HISTORY_KEY = ["chat", "history"] as const;
export const CHAT_HISTORY_PAGE = 20;

/** What a conversation searches, in words. */
export function historyScopeLabel(
  s: Pick<
    ResumableSessionDto,
    "projectId" | "projectName" | "scopeProjectIds" | "scopeWorkspaceId"
  >,
  workspaceName: (id: string) => string | null = () => null,
): string {
  if (s.projectId) return s.projectName || "A project";
  // #2424 — the scope picker's own words (#2351), not "Every project in" and
  // "All projects", which it retired.
  if (s.scopeWorkspaceId) {
    const name = workspaceName(s.scopeWorkspaceId);
    return name ? `${SCOPE_WORDS.workspace}: ${name}` : SCOPE_WORDS.workspace;
  }
  if (s.scopeProjectIds && s.scopeProjectIds.length > 1) {
    return `${s.scopeProjectIds.length} projects`;
  }
  return SCOPE_WORDS.nothing;
}

interface Props {
  /** The conversation on screen, marked as current. */
  activeSessionId: string | null;
  /** Bumped by the page after a turn, so a new or renamed chat shows at once. */
  refreshKey?: number;
}

export function ChatHistory({ activeSessionId, refreshKey = 0 }: Props) {
  // Paged by `offset` (PR #2428 review): the server clamps `limit` to 100, so a
  // growing `limit` stopped Show more at 100 chats. One row past each page says
  // whether there are more, without a count query.
  const list = useInfiniteQuery({
    queryKey: CHAT_HISTORY_KEY,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => sdkApi.listSessions(CHAT_HISTORY_PAGE + 1, pageParam),
    getNextPageParam: (last, _all, offset) =>
      last.length > CHAT_HISTORY_PAGE ? offset + CHAT_HISTORY_PAGE : undefined,
  });
  const workspaces = useQuery(workspaceListQuery);
  const { refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = list;
  useEffect(() => {
    if (refreshKey > 0) void refetch();
  }, [refreshKey, refetch]);

  const rows = list.data?.pages.flatMap((p) => p.slice(0, CHAT_HISTORY_PAGE)) ?? [];
  const workspaceName = (id: string) => workspaces.data?.find((w) => w.id === id)?.name ?? null;

  return (
    <nav aria-label="Your conversations" className="flex h-full flex-col gap-2">
      <h2 className="text-sm font-semibold">Your conversations</h2>
      {list.isLoading ? (
        <SkeletonText lines={3} />
      ) : list.isError ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Your conversations could not be loaded.</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="chat-history-empty">
          No conversations yet. Ask a question and it will be listed here.
        </p>
      ) : (
        <>
          <ul className="space-y-1 overflow-y-auto" data-testid="chat-history">
            {rows.map((s) => {
              const current = s.id === activeSessionId;
              return (
                <li key={s.id}>
                  <Link
                    href={`/chat?sessionId=${encodeURIComponent(s.id)}`}
                    aria-current={current ? "page" : undefined}
                    data-testid={`chat-history-${s.id}`}
                    className={`block rounded-md border p-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      current ? "border-primary bg-accent" : ""
                    }`}
                  >
                    <span className="block truncate font-medium">{s.title || "Untitled chat"}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {historyScopeLabel(s, workspaceName)}
                      <span aria-hidden="true"> · </span>
                      <time dateTime={s.updatedAt} title={new Date(s.updatedAt).toLocaleString()}>
                        {timeAgo(s.updatedAt)}
                      </time>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {hasNextPage ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
              data-testid="chat-history-more"
            >
              Show more
            </Button>
          ) : null}
        </>
      )}
    </nav>
  );
}
