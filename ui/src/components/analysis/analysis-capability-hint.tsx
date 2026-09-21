"use client";

/**
 * Issue #733 — pre-run capability hint on the start-analysis form.
 *
 * Before the user clicks "Run analysis", probe the project's capabilities and,
 * given the agents they've selected, warn which ones the run will have (e.g.
 * "This project has no connected repository — code gap analysis will be
 * document-grounded only"). `agentMode`-dependent reasons are omitted here since
 * the mode is only known once a run extracts requirements.
 */
import { useQuery } from "@tanstack/react-query";
import { deriveCapabilityReasons } from "@metis/shared";
import { analysisApi, type AnalysisAgentKey } from "@/lib/analysis-api";
import { CAPABILITY_REASON_COPY } from "@/lib/analysis-capability-copy";

interface Props {
  projectId: string;
  /** Agents selected in the form — gates code/database reasons. */
  selectedAgents: AnalysisAgentKey[];
}

export function AnalysisCapabilityHint({
  projectId,
  selectedAgents,
}: Props): React.ReactElement | null {
  const preview = useQuery({
    queryKey: ["analysis", "capability-preview", projectId],
    queryFn: () => analysisApi.capabilityPreview(projectId),
  });

  if (!preview.data) return null;

  const reasons = deriveCapabilityReasons({
    codeAnalysisRequested: selectedAgents.includes("code"),
    databaseAnalysisRequested: selectedAgents.includes("database"),
    codeGraphPresent: preview.data.codeGraphPresent,
    repoSourceIngested: preview.data.repoSourceIngested,
    fusedCodeRetrievalEnabled: preview.data.fusedCodeRetrievalEnabled,
    schemaContextEnabled: preview.data.schemaContextEnabled,
    // agentMode intentionally omitted pre-run.
  });

  if (reasons.length === 0) return null;

  return (
    <div
      data-testid="analysis-capability-hint"
      className="rounded border border-amber-700/40 bg-amber-950/10 p-2 text-xs text-amber-200/80"
    >
      <span className="font-medium text-amber-300">Before you start:</span>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {reasons.map((reason) => (
          <li key={reason} data-testid={`capability-hint-${reason}`}>
            {CAPABILITY_REASON_COPY[reason].title}{" "}
            <span className="text-amber-200/60">{CAPABILITY_REASON_COPY[reason].action}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
