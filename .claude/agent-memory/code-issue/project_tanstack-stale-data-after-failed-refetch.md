---
name: tanstack-stale-data-after-failed-refetch
description: TanStack Query keeps the last good data when a refetch fails, so a guard on `.data` alone can persist a since-deleted entity.
metadata:
  type: project
---

PR #443 (#411) saved the switcher's active project only once it had "resolved". The project detail cache is shared with Overview. So a project cached earlier and since deleted still had `.data` on the first render, and it was persisted before its refetch returned 404.

**Why:** TanStack serves cached data while it refetches, and keeps that data when the refetch errors.

**How to apply:** persist or act on server state only after a confirmed fetch. Gate on `isFetchedAfterMount && isSuccess && !isFetching`, and stop showing the data once `isError` is set. To test it, pre-seed the cache with a stale entry whose refetch fails; `makeWrapper({ queryClient })` accepts a seeded client.

## A prop-seeded `useState` ignores every refetch (PR #1315, #997)

`CommentThread.tsx` before #997 seeded `useState` from a prop list, so every later React Query refetch was ignored and the thread never updated live. Before adding socket plumbing for "the list doesn't update", check for `useState(props.x)` first: invalidating the query does nothing while the component renders its own copy.
