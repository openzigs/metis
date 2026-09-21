/**
 * Phase 12 — Workbench layout persistence (issue #84 AC: "Layout persists per user").
 *
 * Uses localStorage so the layout follows the *browser session* of the
 * authenticated user. We never include the user ID in the key — the
 * authenticated request boundary already gates access to the page.
 */

const STORAGE_KEY = "metis.workbench.layout";

export interface WorkbenchLayout {
  /** Width of the left (tree) panel as a percentage of the viewport. */
  leftPct: number;
  /** Width of the right (recent/tasks) panel as a percentage of the viewport. */
  rightPct: number;
  /** Current chat-context attachments (tree node ids). */
  contextIds: string[];
  /** Selected agent key for the workbench chat session (null = default). */
  agentKey: string | null;
}

export const DEFAULT_LAYOUT: WorkbenchLayout = {
  leftPct: 22,
  rightPct: 26,
  contextIds: [],
  agentKey: null,
};

const MIN_PCT = 12;
const MAX_PCT = 50;

function clamp(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return MIN_PCT;
  if (n < MIN_PCT) return MIN_PCT;
  if (n > MAX_PCT) return MAX_PCT;
  return n;
}

export function loadLayout(): WorkbenchLayout {
  if (typeof window === "undefined") return { ...DEFAULT_LAYOUT };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_LAYOUT };
    const obj = parsed as Partial<WorkbenchLayout>;
    return {
      leftPct: clamp(typeof obj.leftPct === "number" ? obj.leftPct : DEFAULT_LAYOUT.leftPct),
      rightPct: clamp(typeof obj.rightPct === "number" ? obj.rightPct : DEFAULT_LAYOUT.rightPct),
      contextIds: Array.isArray(obj.contextIds)
        ? obj.contextIds.filter((s): s is string => typeof s === "string").slice(0, 50)
        : [],
      agentKey: typeof obj.agentKey === "string" ? obj.agentKey : null,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: WorkbenchLayout): void {
  if (typeof window === "undefined") return;
  const sanitised: WorkbenchLayout = {
    leftPct: clamp(layout.leftPct),
    rightPct: clamp(layout.rightPct),
    contextIds: layout.contextIds.slice(0, 50),
    agentKey: layout.agentKey,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitised));
  } catch {
    /* swallow */
  }
}

export function resetLayout(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

export const _CLAMP_BOUNDS = { MIN_PCT, MAX_PCT } as const;
