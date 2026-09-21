/**
 * Phase 12 — client-side recent-items tracker for the Workbench Recent panel.
 *
 * We avoid adding a server-side "list my recent sessions" endpoint by
 * tracking the user's own recent activity in localStorage. The store caps
 * the list at 10 entries per kind and orders by most-recent-first.
 */

export type RecentKind = "session" | "analysis";

export interface RecentEntry {
  kind: RecentKind;
  id: string;
  label: string;
  href: string;
  /** ISO timestamp the entry was last touched. */
  touchedAt: string;
  /** Optional project context. */
  projectId?: string;
}

const STORAGE_KEY = "metis.workbench.recent";
const MAX_PER_KIND = 10;

/**
 * Defense-in-depth: only allow same-origin relative paths starting with a
 * single `/`. This rejects javascript:, data:, vbscript:, and protocol-relative
 * (`//evil.com`) or backslash-trick (`/\\evil.com`) URLs that would otherwise
 * render as live `<a href>` links on the workbench Recent panel and exfiltrate
 * the user's session if clicked.
 */
function isSafeRelativeHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0) return false;
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//")) return false;
  if (href.startsWith("/\\")) return false;
  return true;
}

function readAll(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is RecentEntry => {
      if (typeof e !== "object" || e === null) return false;
      const r = e as Partial<RecentEntry>;
      return (
        (r.kind === "session" || r.kind === "analysis") &&
        typeof r.id === "string" &&
        typeof r.label === "string" &&
        isSafeRelativeHref(r.href) &&
        typeof r.touchedAt === "string"
      );
    });
  } catch {
    return [];
  }
}

function writeAll(entries: RecentEntry[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* swallow */
  }
}

export const recentTracker = {
  list(kind?: RecentKind): RecentEntry[] {
    const all = readAll();
    const filtered = kind ? all.filter((e) => e.kind === kind) : all;
    return filtered.sort((a, b) => b.touchedAt.localeCompare(a.touchedAt));
  },
  touch(entry: Omit<RecentEntry, "touchedAt"> & { touchedAt?: string }): void {
    if (!isSafeRelativeHref(entry.href)) return;
    const all = readAll();
    const without = all.filter((e) => !(e.kind === entry.kind && e.id === entry.id));
    without.unshift({ ...entry, touchedAt: entry.touchedAt ?? new Date().toISOString() });
    // Cap per-kind so a chatty user never spams the list.
    const sessions = without.filter((e) => e.kind === "session").slice(0, MAX_PER_KIND);
    const analyses = without.filter((e) => e.kind === "analysis").slice(0, MAX_PER_KIND);
    writeAll([...sessions, ...analyses]);
  },
  clear(): void {
    writeAll([]);
  },
};

export const _MAX_PER_KIND = MAX_PER_KIND;
