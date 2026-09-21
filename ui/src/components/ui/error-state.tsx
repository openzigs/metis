"use client";

/**
 * S4 (#145) — Shared, secure error component. Renders a human-readable,
 * redacted message (never stack traces or secrets), a retry action, and an
 * escape link. Used by `error.tsx` route boundaries and inline error surfaces.
 */
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { sanitizeErrorMessage } from "@/lib/sanitize-error";
import { Button } from "@/components/ui/button";

export interface ErrorStateProps {
  /** The thrown error. Its message is sanitized before display. */
  error?: unknown;
  /** Heading shown above the message. */
  title?: string;
  /** Explicit, already-safe message. Overrides the sanitized error message. */
  description?: string;
  /** Retry handler — wired to `reset()` in route boundaries. */
  onRetry?: () => void;
  retryLabel?: string;
  /** Escape link target. Pass `null` to hide the escape link. */
  homeHref?: string | null;
  homeLabel?: string;
  className?: string;
}

export function ErrorState({
  error,
  title = "Something went wrong",
  description,
  onRetry,
  retryLabel = "Try again",
  homeHref = "/dashboard",
  homeLabel = "Back to dashboard",
  className,
}: ErrorStateProps) {
  const message = description ?? sanitizeErrorMessage(error);

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="error-state"
      className={cn(
        "mx-auto flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-card p-6 text-center",
        className,
      )}
    >
      <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden />
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{message}</p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {onRetry ? (
          <Button onClick={onRetry} data-testid="error-state-retry">
            {retryLabel}
          </Button>
        ) : null}
        {homeHref ? (
          <Button variant="outline" asChild>
            <Link href={homeHref} data-testid="error-state-home">
              {homeLabel}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
