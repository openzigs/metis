/**
 * The project active in the top bar (`ProjectSwitcher`), readable by any page.
 *
 * #1139 — Chat and the Workbench used to pick their own starting project (the
 * last chat scope, or simply the first project in the list), so both could
 * open on a different project from the one the top bar showed. They now start
 * from the same answer the switcher gives, computed by the same function.
 */

import { projectsApi } from "@/lib/projects-api";

export const ACTIVE_PROJECT_STORAGE_KEY = "metis.activeProjectId";

/**
 * The switcher's project list. Shared (same key, same request) so a page that
 * needs the active project reads the very list the top bar resolved it from.
 */
export const projectSwitcherQuery = {
  queryKey: ["projects", "switcher"] as const,
  queryFn: () => projectsApi.list({ limit: 50 }),
  staleTime: 30_000,
};

export function readStoredActiveProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredActiveProjectId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(ACTIVE_PROJECT_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    /* Safari private mode */
  }
}

/**
 * The active project off a project page: the stored one while it is still in
 * the user's list, else the first project listed, else none. This is the
 * switcher's own rule (a `/projects/<id>` URL overrides it there).
 */
export function resolveActiveProjectId(
  storedId: string | null,
  projects: readonly { id: string }[],
): string | null {
  if (storedId && projects.some((p) => p.id === storedId)) return storedId;
  return projects[0]?.id ?? null;
}
