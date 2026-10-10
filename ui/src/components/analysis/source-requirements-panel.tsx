"use client";

/**
 * Issue #1006 — the imported requirements an analysis was started from, each
 * with the `NR-*` id it carried through the run and a link back to the
 * tracker item. Renders nothing on runs not started from imported requirements.
 */
import type { AnalysisSourceRequirement } from "@metis/shared";
import { isHttpUrl } from "@/lib/error-suggestion";

interface Props {
  sourceRequirements?: AnalysisSourceRequirement[] | null;
}

export function SourceRequirementsPanel({ sourceRequirements }: Props): React.ReactElement | null {
  if (!sourceRequirements || sourceRequirements.length === 0) return null;
  return (
    <section
      className="rounded border border-border p-3 text-sm"
      data-testid="source-requirements-panel"
    >
      <h4 className="mb-2 text-sm font-semibold">Imported requirements analyzed in this run</h4>
      <ul className="space-y-1">
        {sourceRequirements.map((s) => {
          const ref = s.externalId ? `${s.externalSource} #${s.externalId}` : s.externalSource;
          return (
            <li key={s.candidateId} data-testid={`source-requirement-${s.candidateId}`}>
              <span className="font-mono text-xs text-muted-foreground">{s.candidateId}</span>{" "}
              {s.title} {/* Only http(s): an imported URL is tracker data, never trusted markup. */}
              {s.externalUrl && isHttpUrl(s.externalUrl) ? (
                <a
                  href={s.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs underline"
                >
                  {ref}
                </a>
              ) : (
                <span className="text-xs text-muted-foreground">{ref}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
