"use client";

/**
 * Epic #405 / Issue #415 — global connection-status indicator.
 *
 * A slim, unobtrusive banner that appears ONLY while the realtime socket is not
 * healthy ("Reconnecting…" / "Offline — live updates paused") and disappears the
 * moment the connection is restored. It is mounted app-wide in the AppShell.
 *
 * Anti-flap: a brief, normal reconnect should not flash the banner. We debounce
 * the *appearance* of a non-connected state by SHOW_DELAY_MS, and once shown we
 * keep it visible for at least MIN_VISIBLE_MS so it never strobes. A return to
 * `connected` clears the banner (respecting the min-visible window).
 *
 * `auth:error` is surfaced as a toast (sonner is already mounted in providers)
 * so a forbidden subscribe is no longer silently dropped.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSocketStatus, type SocketStatus } from "@/lib/socket-client";
import { cn } from "@/lib/utils";

/** Wait this long before showing the banner — absorbs brief reconnects. */
const SHOW_DELAY_MS = 1500;
/** Once visible, keep the banner up at least this long so it cannot strobe. */
const MIN_VISIBLE_MS = 1500;

function label(status: Exclude<SocketStatus, "connected">): string {
  return status === "reconnecting" ? "Reconnecting…" : "Offline — live updates paused";
}

export function ConnectionStatus() {
  const { status, error } = useSocketStatus();
  const [visible, setVisible] = useState(false);
  // The status to render while visible. Frozen during the min-visible window so
  // a fast connected→reconnecting→connected blip doesn't swap the text mid-fade.
  const [shownStatus, setShownStatus] =
    useState<Exclude<SocketStatus, "connected">>("reconnecting");
  const shownAtRef = useRef<number>(0);

  // ---- Surface auth:error as a toast (dedupe repeats) -----------------------
  const lastErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastErrorRef.current) {
      lastErrorRef.current = error;
      toast.error(error);
    }
    if (!error) lastErrorRef.current = null;
  }, [error]);

  // ---- Debounced show / min-visible hide ------------------------------------
  useEffect(() => {
    const unhealthy = status !== "connected";

    if (unhealthy) {
      // Already visible → just update the rendered label (keep the same window).
      if (visible) {
        setShownStatus(status);
        return;
      }
      // Debounce the first appearance so brief reconnects never flash.
      const showTimer = setTimeout(() => {
        setShownStatus(status);
        shownAtRef.current = Date.now();
        setVisible(true);
      }, SHOW_DELAY_MS);
      return () => clearTimeout(showTimer);
    }

    // Healthy now. If never shown, nothing to do (the pending show-timer above
    // is cleared by this effect's own cleanup on the previous run).
    if (!visible) return;

    const elapsed = Date.now() - shownAtRef.current;
    const remaining = MIN_VISIBLE_MS - elapsed;
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    const hideTimer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(hideTimer);
  }, [status, visible]);

  if (!visible) return null;

  const reconnecting = shownStatus === "reconnecting";

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-status"
      className={cn(
        "fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 px-3 py-1.5 text-center text-xs font-medium shadow-sm",
        reconnecting ? "bg-amber-500/95 text-amber-950" : "bg-rose-600/95 text-rose-50",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          reconnecting ? "animate-pulse bg-amber-900" : "bg-rose-200",
        )}
      />
      {label(shownStatus)}
    </div>
  );
}
