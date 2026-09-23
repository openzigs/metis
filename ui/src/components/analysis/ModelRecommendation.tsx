"use client";

/**
 * Model Recommendation Indicator (Epic #593 / Issue #600; fixed in #1095).
 *
 * Shows the recommended model, reasoning depth, rationale, and estimated cost
 * for the run the user is CONFIGURING — the selected agents and the requirement
 * text are sent to the server, which sizes the run from this project's own
 * completed runs. When there is no history the panel says so and shows no
 * number: the previous build displayed a constant "~16 tokens · ~$0.0000" that
 * was off by ~11,500× on a real run.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type ReasoningDepth = "simple" | "moderate" | "complex";
type LatencySLA = "interactive" | "standard" | "background";
type ModelOverride = "auto" | "force-haiku" | "force-sonnet" | "force-fable" | "force-opus";

interface TaskProfile {
  /** Null when the project has no completed run to estimate from (#1095). */
  tokenEstimate: number | null;
  reasoningDepth: ReasoningDepth;
  latencySLA: LatencySLA;
  taskType: string;
}

interface ModelSelection {
  modelId: string;
  modelName: string;
  rationale: string;
  /** Null whenever `tokenEstimate` is null — cost is never invented (#1095). */
  estimatedCost: number | null;
  wasDowngraded: boolean;
}

interface RunEstimate {
  tokens: number | null;
  basis: "prior-runs" | "no-history";
  sampleSize: number;
  perAgentTokens: number | null;
}

interface ModelRecommendationData {
  profile: TaskProfile;
  selection: ModelSelection;
  estimate: RunEstimate;
}

const DEPTH_COLORS: Record<ReasoningDepth, string> = {
  simple: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  moderate: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  complex: "bg-purple-500/15 text-purple-300 border-purple-500/30",
};

const DEPTH_LABELS: Record<ReasoningDepth, string> = {
  simple: "Simple",
  moderate: "Moderate",
  complex: "Complex",
};

function fetchRecommendation(
  projectId: string,
  override: ModelOverride,
  agentKeys: string[],
  requirementText: string,
): Promise<ModelRecommendationData> {
  // POST, not GET: the requirement text can be thousands of characters and must
  // be classified in full rather than trimmed to fit a query string (#1095).
  return apiFetch<ModelRecommendationData>(`/projects/${projectId}/analyses/model-recommendation`, {
    method: "POST",
    body: { override, agentKeys, requirementText },
  });
}

/** Delay a fast-changing value so typing does not fire a request per keystroke. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Human-readable provenance for the estimate, so the number is never bare. */
function estimateCaption(estimate: RunEstimate): string {
  if (estimate.basis === "no-history" || estimate.tokens == null) {
    return "No token estimate yet — this project has no completed analysis to size from.";
  }
  const runs =
    estimate.sampleSize === 1 ? "1 previous run" : `${estimate.sampleSize} previous runs`;
  return `Estimated from ${runs} on this project (median ${estimate.perAgentTokens?.toLocaleString()} tokens per agent).`;
}

export function ModelRecommendation({
  projectId,
  override,
  onOverrideChange,
  agentKeys,
  requirementText,
}: {
  projectId: string;
  override: ModelOverride;
  onOverrideChange: (v: ModelOverride) => void;
  /** Specialist agents selected for the run being configured. */
  agentKeys: string[];
  /** Text pasted into "Evaluate new requirements" — drives the profile (#1095). */
  requirementText: string;
}): React.ReactElement {
  // Debounced so typing in the requirements textarea does not fire a request per
  // keystroke; the estimate still tracks what the user actually typed.
  const debouncedText = useDebouncedValue(requirementText, 500);
  const agentsKey = [...agentKeys].sort().join(",");

  const { data, isLoading } = useQuery({
    queryKey: [
      ...queryKeys.analyses.forProject(projectId),
      "model-recommendation",
      override,
      agentsKey,
      debouncedText,
    ],
    queryFn: () => fetchRecommendation(projectId, override, agentKeys, debouncedText),
    enabled: Boolean(projectId),
    staleTime: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="rounded border border-zinc-700 bg-zinc-900/40 p-3 text-xs text-zinc-400">
        Loading model recommendation…
      </div>
    );
  }

  const { profile, selection } = data;

  return (
    <div
      className="rounded border border-zinc-700 bg-zinc-900/40 p-3 space-y-2"
      data-testid="model-recommendation"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-zinc-200">Model Selection</span>
        <Select value={override} onValueChange={(v) => onOverrideChange(v as ModelOverride)}>
          <SelectTrigger
            className="h-7 w-auto gap-1 border-zinc-600 bg-zinc-800 px-2 py-1 text-xs text-zinc-200"
            aria-label="Model override"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto</SelectItem>
            <SelectItem value="force-haiku">Force Haiku</SelectItem>
            <SelectItem value="force-sonnet">Force Sonnet</SelectItem>
            <SelectItem value="force-fable">Force Fable</SelectItem>
            <SelectItem value="force-opus">Force Opus</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-zinc-100">{selection.modelName}</span>
        {selection.wasDowngraded && (
          <span className="rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-300">
            Budget downgraded
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className={`rounded border px-1.5 py-0.5 ${DEPTH_COLORS[profile.reasoningDepth]}`}>
          {DEPTH_LABELS[profile.reasoningDepth]} reasoning
        </span>
        {profile.tokenEstimate != null ? (
          <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-zinc-400">
            ~{profile.tokenEstimate.toLocaleString()} tokens
          </span>
        ) : (
          <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-zinc-500">
            Token estimate unavailable
          </span>
        )}
        {selection.estimatedCost != null ? (
          <span className="rounded border border-zinc-600 px-1.5 py-0.5 text-zinc-400">
            ~${selection.estimatedCost.toFixed(4)}
          </span>
        ) : null}
      </div>

      <p className="text-xs text-zinc-500">{estimateCaption(data.estimate)}</p>
      <p className="text-xs text-zinc-400">{selection.rationale}</p>
    </div>
  );
}
