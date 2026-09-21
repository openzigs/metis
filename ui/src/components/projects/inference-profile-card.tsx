"use client";

/**
 * Epic #594 / Issue #127 — Inference Profile card on project Settings.
 *
 * Surfaces the per-project Bedrock inference profile via
 * `GET|PUT /api/projects/:id/inference-profile`. Loads the current value,
 * lets the user edit the ARN / model id / cost center / environment, and
 * persists changes with a dirty-state Save + 2s Saved toast (matching the
 * other Settings cards).
 *
 * Provider guardrail: this only reads/writes the stored inference-profile
 * metadata. It does NOT alter provider selection or request shaping for
 * Bedrock or local-gemma — the controls are Bedrock-specific and harmless
 * when another provider is active.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { inferenceProfileApi, type InferenceProfileInput } from "@/lib/inference-profile-api";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
}

const queryKey = (projectId: string) => ["project", projectId, "inference-profile"] as const;

export function InferenceProfileCard({ projectId }: Props) {
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKey(projectId),
    queryFn: () => inferenceProfileApi.get(projectId),
    enabled: Boolean(projectId),
  });

  const [arn, setArn] = useState("");
  const [modelId, setModelId] = useState("");
  const [costCenter, setCostCenter] = useState("");
  const [environment, setEnvironment] = useState("");
  // #1284 — the hook owns the 2s dismissal timer AND cancels it on unmount.
  const {
    active: savedToast,
    show: showSavedToast,
    clear: clearSavedToast,
  } = useTransientFlag(2000);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const profile = data?.profile;
    setArn(profile?.arn ?? "");
    setModelId(profile?.modelId ?? "");
    setCostCenter(profile?.costCenter ?? "");
    setEnvironment(profile?.environment ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: (body: InferenceProfileInput) => inferenceProfileApi.update(projectId, body),
    onSuccess: () => {
      setFormError(null);
      showSavedToast();
      qc.invalidateQueries({ queryKey: queryKey(projectId) });
    },
    onError: (err: unknown) => {
      clearSavedToast();
      setFormError(err instanceof ApiError ? err.message : "Failed to save inference profile");
    },
  });

  function handleSave() {
    if (!arn.trim() || !modelId.trim()) {
      setFormError("ARN and model id are required.");
      return;
    }
    save.mutate({
      arn: arn.trim(),
      modelId: modelId.trim(),
      costCenter: costCenter.trim() || undefined,
      environment: environment.trim() || undefined,
    });
  }

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="inference-profile-card"
      aria-labelledby="inference-profile-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="inference-profile-heading" className="text-sm font-semibold">
            Bedrock inference profile
          </h3>
          <p className="text-xs text-muted-foreground">
            Optional cross-region inference profile used as the model identifier for Bedrock calls.
            Leave blank to use the project&apos;s default model. Ignored by non-Bedrock providers.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
            data-testid="inference-profile-saved-toast"
          >
            Saved
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="inference-profile-loading">
          Loading inference profile…
        </p>
      ) : error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="inference-profile-error">
          Failed to load inference profile.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="inference-profile-arn">Inference profile ARN</Label>
            <Input
              id="inference-profile-arn"
              data-testid="inference-profile-arn"
              placeholder="arn:aws:bedrock:us-east-1:123456789012:inference-profile/…"
              value={arn}
              onChange={(e) => setArn(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="inference-profile-model">Model id</Label>
            <Input
              id="inference-profile-model"
              data-testid="inference-profile-model"
              placeholder="us.anthropic.claude-sonnet-4-6"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1 space-y-1">
              <Label htmlFor="inference-profile-cost-center">Cost center</Label>
              <Input
                id="inference-profile-cost-center"
                data-testid="inference-profile-cost-center"
                value={costCenter}
                onChange={(e) => setCostCenter(e.target.value)}
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor="inference-profile-environment">Environment</Label>
              <Input
                id="inference-profile-environment"
                data-testid="inference-profile-environment"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
              />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={save.isPending}
            data-testid="inference-profile-save"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {formError ? (
            <p
              className="text-sm text-destructive"
              role="alert"
              data-testid="inference-profile-form-error"
            >
              {formError}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
