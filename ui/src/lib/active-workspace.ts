/**
 * The workspace active in the top bar (`WorkspaceSwitcher`), readable by any
 * component and kept in step across them.
 *
 * #1584 — the project switcher listed every project the user could open, not
 * the active workspace's, because nothing told it which workspace was active:
 * the id sat in localStorage and was read once per render, so a switch reached
 * no other component. Writes here notify every `useActiveWorkspaceId` reader,
 * in this tab and (through the `storage` event) in the user's other tabs.
 */
import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

export const ACTIVE_WORKSPACE_STORAGE_KEY = "metis.activeWorkspaceId";

/** Fired on `window` after this tab changes the active workspace. */
const CHANGE_EVENT = "metis:active-workspace";

export function readStoredActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredActiveWorkspaceId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id === readStoredActiveWorkspaceId()) return;
    if (id) window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    /* Safari private mode */
    return;
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ACTIVE_WORKSPACE_STORAGE_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The stored active workspace id, re-rendering the caller whenever it changes. */
export function useActiveWorkspaceId(): string | null {
  return useSyncExternalStore(subscribe, readStoredActiveWorkspaceId, () => null);
}

/** A workspace the caller belongs to, as `GET /api/workspaces` lists it. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
}

/**
 * The caller's workspaces: the top bar's list, shared (same key, same request)
 * so a page that validates the stored id reads the list the switcher resolved
 * its own from.
 *
 * #1584 — a failed read is an error, not an empty list: swallowing it cached
 * "no workspaces" for a minute after one transient 500 (run 10, wave F), and
 * the query's own retry never ran. A list that cannot be read renders as none.
 */
export const workspaceListQuery = {
  queryKey: ["workspaces", "switcher"] as const,
  queryFn: () => apiFetch<WorkspaceSummary[]>("/workspaces"),
  staleTime: 60_000,
};

/**
 * The active workspace off a project page: the stored one while the caller is
 * still a member of it, else their first workspace, else none. This is the
 * switcher's own rule (a project page's workspace overrides it there).
 */
export function resolveActiveWorkspaceId(
  storedId: string | null,
  workspaces: readonly { id: string }[],
): string | null {
  if (storedId && workspaces.some((w) => w.id === storedId)) return storedId;
  return workspaces[0]?.id ?? null;
}

/**
 * Whether the caller's workspaces have been read: `loading` until they are,
 * `error` when they could not be, else `ready`.
 */
export type ActiveWorkspaceStatus = "loading" | "error" | "ready";

/**
 * #2197 — the stored active workspace, validated against the caller's own
 * workspaces. The raw stored id can name a workspace the caller is not in (a
 * second user on a shared browser, a membership since removed), and sent as a
 * filter it lists none of that workspace's projects. Until the list is read
 * the status is `loading` and there is no id; a list that cannot be read
 * validates nothing, so there is no id then either (the server scopes the
 * caller anyway).
 *
 * #2208 — "no id" is therefore not "no workspace" unless the status is
 * `ready`: a create form must not send it as one (it would put the project in
 * no workspace). `retry` re-reads the list after an error, settling when the
 * read does.
 *
 * #2218 — a failed REFETCH is not an unread list: TanStack keeps the last
 * list read with `status: "error"`, and that list still validates the id. Only
 * a list never read is `error`.
 */
export function useValidatedActiveWorkspaceId(): {
  workspaceId: string | null;
  status: ActiveWorkspaceStatus;
  retry: () => Promise<unknown>;
} {
  const storedId = useActiveWorkspaceId();
  const list = useQuery(workspaceListQuery);
  const retry = () => list.refetch();
  if (list.isPending) return { workspaceId: null, status: "loading", retry };
  if (list.data === undefined) return { workspaceId: null, status: "error", retry };
  return { workspaceId: resolveActiveWorkspaceId(storedId, list.data), status: "ready", retry };
}
