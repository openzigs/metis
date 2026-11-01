/**
 * Epic #1608 (#1626) — a product's coverage state as an icon AND words, so the
 * state is never carried by colour alone.
 */
import { CheckCircle2, CircleDashed, CircleDot, Lock, XCircle } from "lucide-react";
import type { PortfolioCoverage } from "@metis/shared";
import { COVERAGE_LABEL } from "@/lib/portfolio-coverage";

const ICON: Record<PortfolioCoverage, typeof CheckCircle2> = {
  covers: CheckCircle2,
  partial: CircleDot,
  "not-covered": XCircle,
  "not-checked": CircleDashed,
  restricted: Lock,
};

const TONE: Record<PortfolioCoverage, string> = {
  covers: "text-success",
  partial: "text-warning",
  "not-covered": "text-foreground",
  "not-checked": "text-muted-foreground",
  restricted: "text-muted-foreground",
};

export function CoverageState({
  coverage,
  reason,
}: {
  coverage: PortfolioCoverage;
  reason?: string | null;
}) {
  const Icon = ICON[coverage];
  return (
    <span className="inline-flex flex-col gap-0.5" data-testid="coverage-state">
      <span className={`inline-flex items-center gap-1.5 font-medium ${TONE[coverage]}`}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden />
        {COVERAGE_LABEL[coverage]}
      </span>
      {reason ? <span className="text-xs text-muted-foreground">Because {reason}.</span> : null}
    </span>
  );
}
