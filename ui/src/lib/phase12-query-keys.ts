/**
 * Phase 12 — query-keys for the new Phase 12 surfaces.
 *
 * Re-exported from `query-keys.ts` so existing call-sites need no changes.
 * Kept here so the new groups don't bloat the original file.
 */
import { queryKeys } from "@/lib/query-keys";

export const phase12QueryKeys = {
  loadedSkills: (sessionId: string) =>
    [...queryKeys.skills.all, "session", sessionId, "loaded"] as const,
  envVars: () => ["settings", "env"] as const,
  recentSessions: () => ["workbench", "recent", "sessions"] as const,
  recentAnalyses: (projectId: string | null) =>
    ["workbench", "recent", "analyses", projectId ?? "_global"] as const,
} as const;
