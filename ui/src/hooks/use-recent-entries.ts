import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sdkApi } from "@/lib/sdk-alignment-api";
import { reconcileRecentSessions, recentTracker, type RecentEntry } from "@/lib/recent-tracker";

/** The Sessions page's own key, so the two lists read one cached answer. */
export const RESUMABLE_SESSIONS_KEY = ["resumable-sessions"];

/**
 * #2187 — the Recent list the Workbench panel and the dashboard widget show:
 * the browser's tracker, re-read every `refreshMs`, with each session entry
 * checked against the caller's resumable sessions (see
 * {@link reconcileRecentSessions}).
 *
 * Until the server answers, only analysis entries show, so a stale session is
 * never listed. If the server cannot be asked, the tracker's own list shows —
 * the panel as it was before this check, rather than an empty one.
 */
export function useRecentEntries(refreshMs: number): RecentEntry[] {
  const [entries, setEntries] = useState(() => recentTracker.list());
  useEffect(() => {
    const id = window.setInterval(() => setEntries(recentTracker.list()), refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs]);

  const resumable = useQuery({
    queryKey: RESUMABLE_SESSIONS_KEY,
    queryFn: () => sdkApi.listResumable(),
    refetchInterval: 60_000,
  });

  if (resumable.isError) return entries;
  if (!resumable.data) return entries.filter((e) => e.kind !== "session");
  return reconcileRecentSessions(entries, resumable.data);
}
