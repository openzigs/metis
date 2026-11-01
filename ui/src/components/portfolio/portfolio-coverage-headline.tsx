/**
 * Epic #1608 (#1626) — the answer first, in one plain sentence, before any
 * table. The tone has an icon and words of its own, never colour alone.
 */
import { CheckCircle2, CircleDot, HelpCircle, XCircle } from "lucide-react";
import type { CoverageHeadline, HeadlineTone } from "@/lib/portfolio-coverage";

const ICON: Record<HeadlineTone, typeof CheckCircle2> = {
  covered: CheckCircle2,
  partial: CircleDot,
  gap: XCircle,
  unknown: HelpCircle,
};

const TONE: Record<HeadlineTone, string> = {
  covered: "border-success/40 bg-success-muted text-success",
  partial: "border-warning/40 bg-warning-muted text-warning",
  gap: "border-border bg-muted text-foreground",
  unknown: "border-border bg-muted text-muted-foreground",
};

export function PortfolioCoverageHeadline({ headline }: { headline: CoverageHeadline }) {
  const Icon = ICON[headline.tone];
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border p-4 ${TONE[headline.tone]}`}
      data-testid="portfolio-coverage-headline"
      data-tone={headline.tone}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
      <h2 className="text-lg font-semibold">{headline.text}</h2>
    </div>
  );
}
