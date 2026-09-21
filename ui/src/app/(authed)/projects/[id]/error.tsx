"use client";

import { ErrorState } from "@/components/ui/error-state";

/** S1 (#143) — segment-level error boundary for a single project. */
export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <ErrorState
        error={error}
        title="Couldn't load this project"
        onRetry={reset}
        homeHref="/projects"
        homeLabel="Back to projects"
      />
    </div>
  );
}
