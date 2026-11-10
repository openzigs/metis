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
 * never listed. If the server cannot be asked, only analyses show too: the
 * tracker is shared by everyone who signs in on this browser, so its sessions
 * are never listed unchecked (#2199 review). A session touched after the
 * server's last answer still shows, so one the user just started is not hidden
 * until the next refetch.
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

  if (!resumable.data) return entries.filter((e) => e.kind !== "session");
  return reconcileRecentSessions(entries, resumable.data, resumable.dataUpdatedAt);
}
