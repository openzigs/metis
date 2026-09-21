"use client";

/**
 * Epic #164 — Safety mode card on project Settings.
 *
 * Reuses the Phase 12 dirty-state Save + 2s Saved-toast pattern. Saves via
 * `PATCH /api/projects/:id/safety`. Shows a hint about what each mode does.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { projectsApi, type Project } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const MODES = ["strict", "standard", "off"] as const;
type Mode = (typeof MODES)[number];

const HINTS: Record<Mode, string> = {
  strict: "Block prompt-injection + custom blocklist; redact SSN, credit card, phone, and email.",
  standard: "Block prompt-injection + custom blocklist; redact SSN and credit card. (Default.)",
  off: "Disables all safety hooks. Use only for trusted, isolated workspaces.",
};

interface Props {
  projectId: string;
  current: Project["safetyMode"] | undefined;
}

export function SafetySettingsCard({ projectId, current }: Props) {
  const qc = useQueryClient();
  const initial: Mode = (current as Mode) ?? "standard";
  const [saved, setSaved] = useState<Mode>(initial);
  const [draft, setDraft] = useState<Mode>(initial);
  // #1284 — the hook owns the 2s dismissal timer AND cancels it on unmount.
  const {
    active: savedToast,
    show: showSavedToast,
    clear: clearSavedToast,
  } = useTransientFlag(2000);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== saved;

  const save = useMutation({
    mutationFn: () => projectsApi.updateSafety(projectId, { safetyMode: draft }),
    onSuccess: () => {
      setSaved(draft);
      setError(null);
      showSavedToast();
      qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
    onError: (err: unknown) => {
      clearSavedToast();
      setError(err instanceof ApiError ? err.message : "Update failed");
    },
  });

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="safety-settings-card"
      aria-labelledby="safety-settings-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="safety-settings-heading" className="text-sm font-semibold">
            Safety
          </h3>
          <p className="text-xs text-muted-foreground">
            Controls the SafetyHook chain on inbound prompts and model output.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
            data-testid="safety-saved-toast"
          >
            Saved
          </span>
        ) : null}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="safety-mode-select">Safety mode</Label>
          <select
            id="safety-mode-select"
            data-testid="safety-mode-select"
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value as Mode)}
          >
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          data-testid="safety-save-button"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="safety-hint">
        {HINTS[draft]}
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
