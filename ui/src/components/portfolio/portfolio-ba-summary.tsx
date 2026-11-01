/**
 * Epic #1608 (#1627) — the business-analyst summary (#1624), shown before the
 * tables. When the model could not write it, or the reader sees less than the
 * run did, the page says so rather than presenting the template as prose.
 */
import { PORTFOLIO_DEGRADED_REASON, type PortfolioAssessmentView } from "@metis/shared";

export function PortfolioBaSummary({ view }: { view: PortfolioAssessmentView }) {
  const paragraphs = view.summary
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return null;
  const report = view.report;
  return (
    <section
      aria-labelledby="portfolio-summary-heading"
      className="space-y-2 rounded-lg border border-border p-4"
      data-testid="portfolio-ba-summary"
    >
      <h2 id="portfolio-summary-heading" className="text-base font-semibold">
        Summary
      </h2>
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap text-sm">
          {p}
        </p>
      ))}
      {report?.degraded ? (
        <p className="text-xs text-muted-foreground" data-testid="portfolio-summary-degraded">
          Written from a template because{" "}
          {PORTFOLIO_DEGRADED_REASON[report.degradedReason ?? ""] ?? "the model could not write it"}
          . Business and stakeholder impact were not assessed.
        </p>
      ) : null}
      {report?.withheld ? (
        <p className="text-xs text-muted-foreground" data-testid="portfolio-summary-withheld">
          Part of this assessment is hidden from you, so the written summary and the impact
          paragraphs are not shown.
        </p>
      ) : null}
    </section>
  );
}
