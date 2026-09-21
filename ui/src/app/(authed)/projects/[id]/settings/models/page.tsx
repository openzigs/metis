"use client";

/**
 * Per-project model preference settings (Epic #593 / Issue #602).
 *
 * Allows configuring:
 *   - Default model (auto / Haiku / Sonnet)
 *   - Task-type overrides (advanced)
 *   - Budget downgrade threshold
 */
import { useParams, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { modelPreferencesApi, type ModelPreferencesInput } from "@/lib/model-preferences-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

const HAIKU_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const SONNET_ID = "us.anthropic.claude-sonnet-5";
const FABLE_ID = "us.anthropic.claude-fable-5";
const OPUS_ID = "us.anthropic.claude-opus-4-8";

const MODEL_OPTIONS = [
  {
    value: "auto",
    label: "Auto (recommended)",
    description: "Let METIS choose the best model per task",
  },
  {
    value: HAIKU_ID,
    label: "Claude Haiku 4.5",
    description: "Faster and cheaper — best for simple tasks",
  },
  {
    value: SONNET_ID,
    label: "Claude Sonnet 5",
    description: "More capable — best for complex reasoning",
  },
  {
    value: FABLE_ID,
    label: "Claude Fable 5",
    description: "Lightweight alternate model",
  },
  {
    value: OPUS_ID,
    label: "Claude Opus 4.8",
    description: "Highest capability — most expensive",
  },
] as const;

const TASK_TYPES = [
  "document_analysis",
  "code_review",
  "requirement_synthesis",
  "general",
] as const;

export default function ProjectModelSettingsPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const router = useRouter();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.analyses.modelPreferences(projectId),
    queryFn: () => modelPreferencesApi.get(projectId),
    enabled: Boolean(projectId),
  });

  const [defaultModel, setDefaultModel] = useState<string>("auto");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [threshold, setThreshold] = useState<number>(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!data) return;
    setDefaultModel(data.defaultModel ?? "auto");
    setOverrides(data.taskTypeOverrides ?? {});
    setThreshold(data.budgetDowngradeThreshold ?? 0);
  }, [data]);

  const save = useMutation({
    mutationFn: (body: ModelPreferencesInput) => modelPreferencesApi.update(projectId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.analyses.modelPreferences(projectId) });
    },
  });

  function handleSave() {
    const body: ModelPreferencesInput = {
      defaultModel: defaultModel === "auto" ? null : defaultModel,
      taskTypeOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
      budgetDowngradeThreshold: threshold > 0 ? threshold : null,
    };
    save.mutate(body);
  }

  if (!projectId) return <div className="p-6">Invalid project id.</div>;
  if (isLoading) return <div className="p-6">Loading model preferences…</div>;
  if (error) {
    return (
      <div className="p-6 text-destructive" role="alert">
        Failed to load model preferences.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6" data-testid="model-settings-root">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Model Preferences</h1>
        <p className="text-sm text-muted-foreground">
          Configure how METIS selects AI models for this project.
        </p>
      </header>

      {/* Default model */}
      <Card className="space-y-4 p-4">
        <div>
          <Label htmlFor="default-model">Default Model</Label>
          <p className="text-xs text-muted-foreground">
            Choose which model to use by default. &quot;Auto&quot; lets METIS pick the best model
            based on task complexity.
          </p>
        </div>
        <select
          id="default-model"
          data-testid="default-model-select"
          className="w-full rounded border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm text-zinc-200"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} — {opt.description}
            </option>
          ))}
        </select>
      </Card>

      {/* Budget downgrade threshold */}
      <Card className="space-y-4 p-4">
        <div>
          <Label htmlFor="budget-threshold">Budget Downgrade Threshold</Label>
          <p className="text-xs text-muted-foreground">
            When monthly token usage exceeds this threshold, METIS automatically downgrades from
            Sonnet to Haiku to save costs. Set to 0 to disable.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <input
            id="budget-threshold"
            data-testid="budget-threshold-slider"
            type="range"
            min={0}
            max={1_000_000}
            step={10_000}
            className="flex-1"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <span className="w-32 text-right text-sm text-zinc-300">
            {threshold === 0 ? "Disabled" : `${threshold.toLocaleString()} tokens`}
          </span>
        </div>
      </Card>

      {/* Advanced: task type overrides */}
      <Card className="space-y-4 p-4">
        <button
          type="button"
          className="flex w-full items-center justify-between text-sm font-medium text-zinc-200"
          onClick={() => setShowAdvanced(!showAdvanced)}
          data-testid="advanced-toggle"
        >
          <span>Task Type Overrides (Advanced)</span>
          <span className="text-xs text-muted-foreground">{showAdvanced ? "▲" : "▼"}</span>
        </button>

        {showAdvanced && (
          <div className="space-y-3 pt-2">
            <p className="text-xs text-muted-foreground">
              Override the model used for specific task types. Leave as &quot;Auto&quot; to use the
              default model.
            </p>
            {TASK_TYPES.map((taskType) => (
              <div key={taskType} className="flex items-center gap-3">
                <Label className="w-48 text-xs">{taskType.replace(/_/g, " ")}</Label>
                <select
                  data-testid={`override-${taskType}`}
                  className="flex-1 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-xs text-zinc-200"
                  value={overrides[taskType] ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    setOverrides((prev) => {
                      const next = { ...prev };
                      if (v) {
                        next[taskType] = v;
                      } else {
                        delete next[taskType];
                      }
                      return next;
                    });
                  }}
                >
                  <option value="">Auto</option>
                  <option value={HAIKU_ID}>Haiku</option>
                  <option value={SONNET_ID}>Sonnet</option>
                  <option value={FABLE_ID}>Fable</option>
                  <option value={OPUS_ID}>Opus</option>
                </select>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={save.isPending} data-testid="save-model-prefs">
          {save.isPending ? "Saving…" : "Save Preferences"}
        </Button>
        {save.isSuccess && <span className="text-sm text-green-400">Saved successfully.</span>}
        {save.isError && (
          <span className="text-sm text-destructive">Failed to save. Please try again.</span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        <button
          type="button"
          className="underline"
          onClick={() => router.push(`/projects/${projectId}`)}
        >
          ← Back to project settings
        </button>
      </p>
    </div>
  );
}
