"use client";

/**
 * Issue #1063 — where a requirement on the analysis results page came from.
 *
 * An analysis started from imported items rewrites their titles and adds
 * requirements of its own (#706 run 7: five imported items became seven
 * requirements, none titled as imported, none linked back). This line keeps the
 * imported item's OWN title next to the rewritten one, with a link to the
 * tracker item, and marks a requirement the analysis added.
 *
 * Three states, kept apart:
 *   - items  — "Imported as: <title>" and a link, one line per item;
 *   - `[]`   — an "Added by the analysis" badge;
 *   - null   — nothing. "Not recorded" is never shown as "added".
 *
 * The imported title is shown rather than swapped in as the requirement's
 * title: the rewritten title names what the analysis found needs deciding, and
 * a requirement that merges two imported items has no single imported title.
 *
 * An imported title and URL are tracker data. The title is rendered as text
 * (React escapes it); the URL becomes a link only when it parses as http(s).
 */
import type { AnalysisSourceRequirement } from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { isHttpUrl } from "@/lib/error-suggestion";

interface Props {
  sourceItems?: AnalysisSourceRequirement[] | null;
}

export const ADDED_BY_ANALYSIS_TOOLTIP =
  "None of the imported items asked for this. The analysis added it from what it found.";

/** `github #4074`, or just the source when the item has no number. */
function trackerRef(item: AnalysisSourceRequirement): string {
  return item.externalId ? `${item.externalSource} #${item.externalId}` : item.externalSource;
}

export function RequirementSourceItems({ sourceItems }: Props): React.ReactElement | null {
  if (!sourceItems) return null;
  if (sourceItems.length === 0) {
    return (
      <div className="mt-1">
        <Badge
          variant="outline"
          title={ADDED_BY_ANALYSIS_TOOLTIP}
          data-testid="requirement-added-by-analysis"
        >
          Added by the analysis
        </Badge>
      </div>
    );
  }
  return (
    <ul className="mt-1 space-y-0.5" data-testid="requirement-source-items">
      {sourceItems.map((item) => (
        <li
          key={item.candidateId}
          className="text-xs text-muted-foreground"
          data-testid={`requirement-source-item-${item.candidateId}`}
        >
          Imported as: <span className="text-foreground">{item.title}</span>{" "}
          {item.externalUrl && isHttpUrl(item.externalUrl) ? (
            <a
              href={item.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {trackerRef(item)}
            </a>
          ) : (
            <span>{trackerRef(item)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
