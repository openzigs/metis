---
name: tanstack-stale-data-after-failed-refetch
description: TanStack Query keeps the last good data when a refetch fails, so a guard on `.data` alone can persist a since-deleted entity.
metadata:
  type: project
---

PR #443 (#411) saved the switcher's active project only once it had "resolved". The project detail cache is shared with Overview. So a project cached earlier and since deleted still had `.data` on the first render, and it was persisted before its refetch returned 404.

**Why:** TanStack serves cached data while it refetches, and keeps that data when the refetch errors.

**How to apply:** persist or act on server state only after a confirmed fetch. Gate on `isFetchedAfterMount && isSuccess && !isFetching`, and stop showing the data once `isError` is set. To test it, pre-seed the cache with a stale entry whose refetch fails; `makeWrapper({ queryClient })` accepts a seeded client.
