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
