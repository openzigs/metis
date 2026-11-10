/**
 * Phase 12 — client-side recent-items tracker for the Workbench Recent panel.
 *
 * We avoid adding a server-side "list my recent sessions" endpoint by
 * tracking the user's own recent activity in localStorage. The store caps
 * the list at 10 entries per kind and orders by most-recent-first.
 */
import { DEFAULT_SESSION_TITLE, titleFromQuestion } from "@metis/shared";

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

/**
 * #2187 — Recent as the server sees it. The tracker lives in the browser, keeps
 * entries forever and is shared by everyone who signs in on that browser, so
 * walkthrough run 10 found seven untitled "New Chat" sessions in Workbench
 * Recent that `/sessions` did not list (`c-10-7`). A session entry is kept only
 * while the server still lists it among the caller's resumable sessions — the
 * list `/sessions` shows — and is labelled with the title the server holds.
 * Analysis entries pass through unchanged.
 */
export function reconcileRecentSessions(
  entries: readonly RecentEntry[],
  resumable: ReadonlyArray<{ id: string; title: string }>,
): RecentEntry[] {
  const titles = new Map(resumable.map((s) => [s.id, s.title]));
  return entries.flatMap((e) => {
    if (e.kind !== "session") return [e];
    const title = titles.get(e.id);
    if (title === undefined) return [];
    return [{ ...e, label: title || e.label }];
  });
}

/**
 * #1139 — the session's title once a turn has been stored: the title Recent
 * lists it under. This is the server's own rename (#980), applied to the same
 * inputs, so the label is the title the server now holds: a session still
 * called {@link DEFAULT_SESSION_TITLE} is named after its FIRST question by the
 * shared {@link titleFromQuestion}; any other title, and any later turn, keeps
 * the title as it is. (PR #1234 review — a label rebuilt on every resume from
 * whatever question came first drifted away from the stored title.)
 */
export function sessionTitleAfterTurn(
  title: string,
  question: string,
  firstQuestion: boolean,
): string {
  if (!firstQuestion || title !== DEFAULT_SESSION_TITLE) return title;
  return titleFromQuestion(question) ?? title;
}
