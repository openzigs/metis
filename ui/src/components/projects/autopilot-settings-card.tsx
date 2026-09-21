"use client";

/**
 * Epic #164 — Autopilot opt-in card on project Settings.
 *
 * Toggles `autopilotEnabled` and an optional cost ceiling (cents). Shows a
 * prominent warning when enabled because autopilot bypasses human approval
 * gates on scheduled-analysis runs. Reuses the Phase 12 dirty Save +
 * 2s Saved-toast pattern.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  enabled: boolean | undefined;
  costCeilingCents: number | null | undefined;
}

function centsToDollarsField(c: number | null | undefined): string {
  if (c == null) return "";
  return (c / 100).toFixed(2);
}

export function AutopilotSettingsCard({ projectId, enabled, costCeilingCents }: Props) {
  const qc = useQueryClient();
  const initialEnabled = Boolean(enabled);
  const initialCeiling = centsToDollarsField(costCeilingCents);
  const [savedEnabled, setSavedEnabled] = useState(initialEnabled);
  const [savedCeiling, setSavedCeiling] = useState(initialCeiling);
  const [draftEnabled, setDraftEnabled] = useState(initialEnabled);
  const [draftCeiling, setDraftCeiling] = useState(initialCeiling);
  const [error, setError] = useState<string | null>(null);
  const dirty = draftEnabled !== savedEnabled || draftCeiling.trim() !== savedCeiling.trim();

  function parseCeiling(): number | null | { error: string } {
    const s = draftCeiling.trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: "Cost ceiling must be a positive number (USD) or empty" };
    }
    const cents = Math.round(n * 100);
    if (!Number.isInteger(cents) || cents <= 0) {
      return { error: "Cost ceiling must round to a positive integer cent value" };
    }
    return cents;
  }

  const save = useMutation({
    mutationFn: () => {
      const parsed = parseCeiling();
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        throw new Error(parsed.error);
      }
      return projectsApi.updateAutopilot(projectId, {
        enabled: draftEnabled,
        costCeilingCents: parsed as number | null,
      });
    },
    onSuccess: () => {
      setSavedEnabled(draftEnabled);
      setSavedCeiling(draftCeiling);
      setError(null);
      toast.success("Autopilot settings saved");
      qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Update failed");
      }
    },
  });

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="autopilot-settings-card"
      aria-labelledby="autopilot-settings-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="autopilot-settings-heading" className="text-sm font-semibold">
            Autopilot
          </h3>
          <p className="text-xs text-muted-foreground">
            Allows scheduled analysis runs to execute without human approval. Subject to the safety
            hooks and the per-project token budget.
          </p>
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draftEnabled}
          onChange={(e) => setDraftEnabled(e.target.checked)}
          data-testid="autopilot-toggle"
        />
        <span>Enable autopilot for scheduled analyses</span>
      </label>
      {draftEnabled ? (
        <p
          className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
          role="alert"
          data-testid="autopilot-warning"
        >
          ⚠ Autopilot bypasses manual approval. Scheduled runs trigger model calls automatically and
          are bounded only by the safety hooks and the configured cost ceiling.
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="autopilot-ceiling">Cost ceiling (USD)</Label>
          <Input
            id="autopilot-ceiling"
            data-testid="autopilot-ceiling-input"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={draftCeiling}
            onChange={(e) => setDraftCeiling(e.target.value)}
            placeholder="No ceiling"
          />
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          data-testid="autopilot-save-button"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="autopilot-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
