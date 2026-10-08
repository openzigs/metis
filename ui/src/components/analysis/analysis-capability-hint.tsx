"use client";

/**
 * Issue #733 — pre-run capability hint on the start-analysis form.
 *
 * Before the user clicks "Run analysis", probe the project's capabilities and,
 * given the agents they've selected, warn which ones the run will have (e.g.
 * "This project has no connected repository — code gap analysis will be
 * document-grounded only"). `agentMode`-dependent reasons are omitted here since
 * the mode is only known once a run extracts requirements.
 *
 * Issue #938 — it also names the enabled custom and library agents the run will
 * invoke, and says they run prompt-only: none of their tools run (tools apply
 * only when a chat delegates to the agent), so their findings are ungrounded.
 */
import { useQuery } from "@tanstack/react-query";
import { deriveCapabilityReasons, type AnalysisPromptOnlyAgent } from "@metis/shared";
import { analysisApi, type AnalysisAgentKey } from "@/lib/analysis-api";
import { CAPABILITY_REASON_COPY, preRunCapabilityTitle } from "@/lib/analysis-capability-copy";

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

  const agents = preview.data.promptOnlyAgents ?? [];
  if (reasons.length === 0 && agents.length === 0) return null;

  return (
    <>
      {reasons.length > 0 && (
        <div
          data-testid="analysis-capability-hint"
          className="rounded border border-warning/40 bg-warning-muted p-2 text-xs text-warning"
        >
          <span className="font-medium text-warning">Before you start:</span>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {reasons.map((reason) => (
              <li key={reason} data-testid={`capability-hint-${reason}`}>
                {/* #364 — no run exists yet, so say what WILL happen, not what did. */}
                {preRunCapabilityTitle(CAPABILITY_REASON_COPY[reason])}{" "}
                <span className="text-warning">{CAPABILITY_REASON_COPY[reason].action}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {agents.length > 0 && <PromptOnlyAgentsNotice agents={agents} />}
    </>
  );
}

function PromptOnlyAgentsNotice({
  agents,
}: {
  agents: readonly AnalysisPromptOnlyAgent[];
}): React.ReactElement {
  return (
    <div
      data-testid="analysis-prompt-only-agents"
      className="rounded border border-border bg-muted p-2 text-xs text-muted-foreground"
    >
      <span className="font-medium text-foreground">
        {agents.length === 1 ? "1 enabled agent" : `${agents.length} enabled agents`} also run
        prompt-only:
      </span>{" "}
      they get the project&apos;s name and description, no documents or code, and none of their
      tools run (tools apply only when a chat delegates to the agent). Their findings are marked
      ungrounded.
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {agents.map((agent) => (
          <li key={agent.ref} data-testid={`prompt-only-agent-${agent.ref}`}>
            {agent.name} ({agent.kind})
            {agent.toolsNotRun.length > 0 &&
              ` — its tools (${agent.toolsNotRun.join(", ")}) will not run`}
          </li>
        ))}
      </ul>
    </div>
  );
}
