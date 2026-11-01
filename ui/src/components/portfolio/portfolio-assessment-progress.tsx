/**
 * Epic #1608 (#1626) — progress while a portfolio check runs. The percentage
 * and step come from the job's lifecycle events (`job:{id}`); before the first
 * one arrives (or after a reload, until the next one) it reads from the
 * assessment's own status.
 */
import { Loader2 } from "lucide-react";
import type { JobLifecycleEvent, PortfolioAssessmentStatus } from "@metis/shared";
import { Progress } from "@/components/ui/progress";

export function PortfolioAssessmentProgress({
  status,
  job,
}: {
  status: PortfolioAssessmentStatus;
  job: JobLifecycleEvent | null;
}) {
  const percent =
    job?.status === "progress" && typeof job.progress === "number" ? job.progress : null;
  const step =
    job?.message ?? (status === "pending" ? "Waiting to start" : "Checking each product in scope");
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-2 rounded-lg border border-border p-4"
      data-testid="portfolio-assessment-progress"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        Checking your portfolio…
      </p>
      <p className="text-sm text-muted-foreground">{step}</p>
      {percent !== null ? (
        <Progress value={percent} aria-label={`${percent}% of products checked`} />
      ) : null}
    </div>
  );
}
