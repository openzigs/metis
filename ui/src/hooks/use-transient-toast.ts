"use client";

/**
 * Transient "saved"/"copied" toast state with a cancellable dismissal timer —
 * Issue #1284.
 *
 * Nine call sites across eight files did this inline:
 *
 * ```ts
 * setSavedToast(true);
 * window.setTimeout(() => setSavedToast(false), 2000);
 * ```
 *
 * with no cleanup. The timer outlives the component: in the browser the
 * callback lands as a `setState` on an unmounted tree, and in jsdom it can fire
 * after the test environment has been torn down, producing a
 * `ReferenceError: window is not defined` that surfaces OUTSIDE the test tally
 * (the `ui` job went red on a run where 337/337 files passed).
 *
 * This hook owns the timer so the cleanup exists in exactly one place. Note
 * what it deliberately does NOT do: there is no "is still mounted" flag. A
 * mounted flag suppresses the symptom while leaving the timer armed and the
 * closure alive; the fix is to CANCEL the timer, so nothing is scheduled past
 * unmount at all.
 *
 * It also fixes a second-order bug the inline version and the
 * `useEffect(..., [savedToast])` idiom elsewhere in the tree both have: showing
 * the toast again while it is already visible re-arms the dismissal from the
 * latest show, rather than letting the first save's timer dismiss the second
 * save's toast early.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface TransientToast<T> {
  /** The current toast value, or `null` when nothing is showing. */
  toast: T | null;
  /** Show `value` and (re-)arm the dismissal timer. */
  showToast: (value: T) => void;
  /** Hide immediately and cancel any pending dismissal. */
  clearToast: () => void;
}

/**
 * Hold a value for `durationMs`, then clear it — cancelling the pending timer
 * on unmount.
 */
export function useTransientToast<T>(durationMs: number): TransientToast<T> {
  const [toast, setToast] = useState<T | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // The crux of #1284: unmounting cancels the dismissal timer.
  useEffect(() => {
    return () => cancelPending();
  }, [cancelPending]);

  const showToast = useCallback(
    (value: T) => {
      cancelPending();
      setToast(value);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setToast(null);
      }, durationMs);
    },
    [cancelPending, durationMs],
  );

  const clearToast = useCallback(() => {
    cancelPending();
    setToast(null);
  }, [cancelPending]);

  return { toast, showToast, clearToast };
}

export interface TransientFlag {
  /** `true` while the toast is showing. */
  active: boolean;
  /** Show the toast and (re-)arm the dismissal timer. */
  show: () => void;
  /** Hide immediately and cancel any pending dismissal. */
  clear: () => void;
}

/**
 * Boolean flavour of {@link useTransientToast} for the seven "Saved" / "Copied"
 * banners that carry no payload. Implemented on top of the generic hook so
 * there is exactly ONE timer and ONE cleanup in this module.
 */
export function useTransientFlag(durationMs: number): TransientFlag {
  const { toast, showToast, clearToast } = useTransientToast<true>(durationMs);
  const show = useCallback(() => showToast(true), [showToast]);
  return { active: toast === true, show, clear: clearToast };
}
