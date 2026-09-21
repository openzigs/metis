"use client";

/**
 * Canonical terminal-toast utility — Issue #425 (Epic #406, terminal layer).
 *
 * Epic #406 added per-surface progress + terminal toasts (PR-review #421, scan
 * #422, embeddings/Spec Kit/overview #423, import/sync #424). Each surface only
 * toasts when its OWN detail page is mounted, so doc-gen / analysis /
 * test-coverage still fail SILENTLY for a user merely watching a LIST view. #425
 * closes that gap with a single global `job:lifecycle` consumer (see
 * {@link useGlobalJobToasts}) — but that introduces a NEW hazard: a job whose
 * terminal event is observed by BOTH its detail surface AND the global layer
 * would toast twice.
 *
 * The per-hook `useRef` guard in `use-job-toast.ts` cannot prevent a cross-
 * component double-toast (each hook instance has its own ref). This module fixes
 * that with a process-wide, **module-level** dedup keyed by `jobId`: the FIRST
 * caller to report a job's terminal transition fires exactly one sonner toast;
 * every later caller for the same `jobId` is a no-op. This guarantees the #425
 * invariant — **exactly one terminal toast per op** — no matter which surface or
 * the global layer observes the event first.
 *
 * Error text never leaks: `failed` uses the event's `error`, which the server
 * already renders as a generic, user-safe string (`GENERIC_FAILURE_MESSAGE`,
 * #254 / OWASP — the bus never carries raw error/stack). `completed` uses the
 * event's human `message`, which preserves the Spec Kit grounded-completion line
 * ("Generated spec.md (v3) … grounded on 8 retrieved chunks.") verbatim.
 */
import { toast } from "sonner";
import type { JobLifecycleEvent } from "@metis/shared";

/** Generic, user-safe fallbacks used when the event omits a message/error. */
export const GENERIC_SUCCESS_TOAST = "Done.";
export const GENERIC_FAILURE_TOAST = "The operation failed. Please try again.";

/**
 * Module-level dedup guard. A `jobId` is added the instant its terminal toast is
 * fired (or explicitly claimed), so any later observer of the same terminal
 * event — a sibling surface, the global layer, a socket re-delivery on reconnect
 * — skips it. Shared across every component/hook in the bundle, which the
 * per-instance `useRef` guard cannot achieve.
 */
const toastedJobIds = new Set<string>();

/** A lifecycle phase that ends the job (drives the terminal toast). */
export function isTerminalJobStatus(status: JobLifecycleEvent["status"]): boolean {
  return status === "completed" || status === "failed";
}

/**
 * Pick the terminal toast kind + text for a job event.
 *
 * `completed` → the server's human `message` (the grounded-completion line for
 * Spec Kit, the symbol count for overview, the reindexed-chunk summary for
 * embeddings), falling back to a generic success label when absent.
 * `failed` → the event's `error`, already a generic, user-safe string (#254),
 * falling back to a generic failure label. Exported for unit testing.
 */
export function terminalToastText(event: JobLifecycleEvent): {
  kind: "success" | "error";
  text: string;
} {
  if (event.status === "failed") {
    return { kind: "error", text: event.error || GENERIC_FAILURE_TOAST };
  }
  return { kind: "success", text: event.message || GENERIC_SUCCESS_TOAST };
}

/**
 * Fire the canonical terminal toast for a job EXACTLY ONCE, deduped by `jobId`
 * across the whole app. Safe to call from any surface hook AND the global layer:
 * whichever observes the terminal event first wins, the rest are no-ops.
 *
 * Non-terminal events (`started`/`progress`) and malformed events (no `jobId`)
 * are ignored. Returns `true` when this call actually fired a toast, `false`
 * when it was deduped/ignored — handy for tests and for callers that want to run
 * a side effect only on the canonical transition.
 */
export function fireTerminalToast(event: JobLifecycleEvent | null | undefined): boolean {
  if (!event || typeof event.jobId !== "string" || !event.jobId) return false;
  if (!isTerminalJobStatus(event.status)) return false;
  if (toastedJobIds.has(event.jobId)) return false;
  toastedJobIds.add(event.jobId);
  const { kind, text } = terminalToastText(event);
  if (kind === "success") toast.success(text);
  else toast.error(text);
  return true;
}

/**
 * Reserve a `jobId` so the global layer will NOT toast it, WITHOUT firing a
 * toast here. Used by surfaces that must build their own toast text from an
 * awaited HTTP response rather than the bus event — e.g. the overview regenerate
 * and Spec Kit command callbacks, whose pages are not in the job's socket room
 * when the terminal event fires, so the awaited response is the only reliable
 * source of the (grounded) success line. Marking the job claimed here keeps the
 * one-toast-per-op invariant if that page ever DOES sit in the project room.
 *
 * Returns `true` if this call claimed the job (caller should toast), `false` if
 * it was already claimed/fired (caller should stay silent).
 */
export function claimTerminalToast(jobId: string | null | undefined): boolean {
  if (!jobId) return false;
  if (toastedJobIds.has(jobId)) return false;
  toastedJobIds.add(jobId);
  return true;
}

/** Test-only reset so specs start from an empty dedup set. */
export function __resetTerminalToastsForTests(): void {
  toastedJobIds.clear();
}
