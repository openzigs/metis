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
import {
  modelPreferencesApi,
  type ModelPreferencesData,
  type ModelPreferencesInput,
} from "@/lib/model-preferences-api";
import { formatModelPrice } from "@/lib/model-catalog-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";

/**
 * #135 — the model options come from the server's model catalog (the
 * `availableModels` of the preferences response, which the server builds from
 * the catalog's router scope). Only the tier wording lives here.
 *
 * #713 — the wording makes no cost claim: a tier says nothing about price
 * (Claude Fable 5 is routed `fast` yet is the dearest option), so "cheapest" /
 * "most expensive" are derived from the listed prices instead (`costRank`).
 */
const TIER_DESCRIPTIONS: Record<string, string> = {
  fast: "Best for simple tasks",
  balanced: "More capable — best for complex reasoning",
  complex: "Highest capability",
  // #713 — a provider that does not serve the Claude tiers offers its own model.
  configured: "The model this deployment's provider runs",
};

const AUTO_OPTION = {
  value: "auto",
  label: "Auto (recommended)",
  description: "Let METIS choose the best model per task",
};

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

  const availableModels = data?.availableModels ?? [];
  const modelOptions = [AUTO_OPTION, ...availableModels.map((m) => toOption(m, availableModels))];
  // #713 — absent from an older server: assume the tiers, as it did.
  const servesTierModels = data?.servesTierModels ?? true;

  const [defaultModel, setDefaultModel] = useState<string>("auto");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [threshold, setThreshold] = useState<number>(0);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // #713 — a model saved under another provider and absent from this one's list
  // (a Claude tier after a switch to DeepSeek, or DeepSeek's model after a switch
  // back): the server rejects an id the provider cannot run, so it shows, and
  // saves, as Auto — and the page says so, since the server keeps it until then.
  const staleSavedModel =
    data?.defaultModel && !availableModels.some((m) => m.id === data.defaultModel)
      ? data.defaultModel
      : null;

  useEffect(() => {
    if (!data) return;
    const stale =
      data.defaultModel != null && !data.availableModels.some((m) => m.id === data.defaultModel);
    setDefaultModel(stale ? "auto" : (data.defaultModel ?? "auto"));
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
      <PageHeader
        title="Model Preferences"
        description="Configure how METIS selects AI models for this project."
      />

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
          className="w-full rounded border border-border bg-muted px-3 py-2 text-sm text-foreground"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
        >
          {modelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label} — {opt.description}
            </option>
          ))}
        </select>
        {staleSavedModel && defaultModel === "auto" && (
          <p className="text-xs text-warning" data-testid="stale-default-model-notice">
            Your saved model {staleSavedModel} isn&apos;t available on this provider; saving will
            switch to Auto.
          </p>
        )}
      </Card>

      {/* Budget downgrade threshold */}
      <Card className="space-y-4 p-4">
        <div>
          <Label htmlFor="budget-threshold">Budget Downgrade Threshold</Label>
          <p className="text-xs text-muted-foreground" data-testid="budget-threshold-help">
            {servesTierModels
              ? "When monthly token usage exceeds this threshold, METIS automatically downgrades from Sonnet to Haiku to save costs. Set to 0 to disable."
              : "This deployment's provider runs a single model, so there is no cheaper model to downgrade to and this threshold has no effect."}
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
            disabled={!servesTierModels}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
          <span className="w-32 text-right text-sm text-foreground">
            {threshold === 0 ? "Disabled" : `${threshold.toLocaleString()} tokens`}
          </span>
        </div>
      </Card>

      {/* Advanced: task type overrides */}
      <Card className="space-y-4 p-4">
        <button
          type="button"
          className="flex w-full items-center justify-between text-sm font-medium text-foreground"
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
                  className="flex-1 rounded border border-border bg-muted px-2 py-1 text-xs text-foreground"
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
                  {(data?.availableModels ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
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
        {save.isSuccess && <span className="text-sm text-success">Saved successfully.</span>}
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

type AvailableModel = ModelPreferencesData["availableModels"][number];

/** Input plus output price per MTok, or null when the price is unknown. */
function blendedPrice(m: AvailableModel): number | null {
  return m.price ? m.price.inputPerMTok + m.price.outputPerMTok : null;
}

/**
 * #713 — "cheapest" or "most expensive" when the listed prices say so: the
 * model's price is strictly below (above) every other priced option. Nothing
 * when fewer than two options are priced.
 */
function costRank(m: AvailableModel, all: AvailableModel[]): string | null {
  const own = blendedPrice(m);
  if (own === null) return null;
  const others = all
    .filter((o) => o.id !== m.id)
    .map(blendedPrice)
    .filter((p): p is number => p !== null);
  if (others.length === 0) return null;
  if (others.every((p) => own < p)) return "cheapest";
  if (others.every((p) => own > p)) return "most expensive";
  return null;
}

/** One catalog model → a picker option: tier wording, cost rank, and price when known. */
function toOption(m: AvailableModel, all: AvailableModel[]) {
  const price = formatModelPrice({ price: m.price ?? null });
  const tier = TIER_DESCRIPTIONS[m.tier] ?? m.tier;
  const rank = costRank(m, all);
  const text = rank ? `${tier} — ${rank}` : tier;
  return { value: m.id, label: m.name, description: price ? `${text} (${price})` : text };
}
