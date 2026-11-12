/**
 * #2272 — what a portfolio check checked, requirement by requirement, and what
 * it did not check.
 *
 * A check of a document (or of a requirement with several criteria) checks
 * each requirement on its own: each is listed with the products found
 * implementing it. Nothing is cut silently: every requirement past the cap,
 * text past its length, section the model could not read, or repository the
 * budget ran out before is listed under "Not checked", with why, as the
 * Markdown export lists it.
 */
import {
  portfolioNotCheckedText,
  portfolioRequirementCoverage,
  type PortfolioAssessmentView,
} from "@metis/shared";

export function PortfolioRequirementsChecked({ view }: { view: PortfolioAssessmentView }) {
  const checked = portfolioRequirementCoverage(view.products);
  const notChecked = view.notChecked ?? [];
  const name = (productId: string) => view.productNames[productId] ?? "A product you cannot read";
  return (
    <>
      {checked.length > 1 ? (
        <section
          aria-labelledby="portfolio-requirements-heading"
          className="space-y-2"
          data-testid="portfolio-requirements-checked"
        >
          <h2 id="portfolio-requirements-heading" className="text-base font-semibold">
            Requirements checked ({checked.length})
          </h2>
          <ol className="list-decimal space-y-1 pl-6 text-sm">
            {checked.map((r, i) => (
              <li key={i} data-testid="portfolio-requirement-row">
                <span className="whitespace-pre-wrap">{r.requirement}</span>{" "}
                <span className="text-muted-foreground">
                  —{" "}
                  {r.coveredBy.length > 0
                    ? `implemented by ${r.coveredBy.map(name).join(", ")}`
                    : "no product found implementing it"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {notChecked.length > 0 ? (
        <section
          aria-labelledby="portfolio-not-checked-heading"
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="portfolio-not-checked"
        >
          <h2 id="portfolio-not-checked-heading" className="text-base font-semibold">
            Not checked ({notChecked.length})
          </h2>
          <ul className="space-y-1 text-sm">
            {notChecked.map((n, i) => (
              <li key={i} data-testid="portfolio-not-checked-row" data-reason={n.reason}>
                <span className="whitespace-pre-wrap">{n.text}</span>{" "}
                <span className="text-muted-foreground">{portfolioNotCheckedText(n)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
