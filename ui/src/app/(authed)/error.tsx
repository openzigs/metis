"use client";

import { ErrorState } from "@/components/ui/error-state";

/**
 * S1 (#143) — error boundary for the authed segment. Next.js passes the thrown
 * error and a `reset()` to retry rendering. The shared {@link ErrorState}
 * sanitizes the message (no stack traces or secrets, S4 #145).
 */
export default function AuthedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <ErrorState error={error} onRetry={reset} />
    </div>
  );
}
