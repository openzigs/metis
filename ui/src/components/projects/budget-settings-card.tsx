"use client";

/**
 * Epic #164 — Per-project monthly token budget card.
 *
 * Admin-only on the server (`admin.write`); the UI still renders to non-admins
 * and surfaces the 403 inline if they try to save. Reuses the Phase 12 dirty
 * Save + 2s Saved-toast pattern. Empty input clears the cap (sends `null`).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { useTransientFlag } from "@/hooks/use-transient-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  current: number | null | undefined;
  /** Drives the disabled state on the input + Save button when false. */
  canEdit?: boolean;
}

function toFieldValue(v: number | null | undefined): string {
  if (v == null) return "";
  return String(v);
}

export function BudgetSettingsCard({ projectId, current, canEdit = true }: Props) {
  const qc = useQueryClient();
  const initial = toFieldValue(current);
  const [saved, setSaved] = useState<string>(initial);
  const [draft, setDraft] = useState<string>(initial);
  // #1284 — the hook owns the 2s dismissal timer AND cancels it on unmount.
  const {
    active: savedToast,
    show: showSavedToast,
    clear: clearSavedToast,
  } = useTransientFlag(2000);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.trim() !== saved.trim();

  function parse(): number | null | { error: string } {
    const s = draft.trim();
    if (s === "") return null;
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { error: "Budget must be a positive integer or empty for no cap" };
    }
    return n;
  }

  const save = useMutation({
    mutationFn: () => {
      const parsed = parse();
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        throw new Error(parsed.error);
      }
      return projectsApi.updateBudget(projectId, {
        monthlyTokenBudget: parsed as number | null,
      });
    },
    onSuccess: () => {
      setSaved(draft);
      setError(null);
      showSavedToast();
      qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
    onError: (err: unknown) => {
      clearSavedToast();
      if (err instanceof ApiError) {
        setError(err.status === 403 ? "Admin role required to edit budget" : err.message);
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
      data-testid="budget-settings-card"
      aria-labelledby="budget-settings-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="budget-settings-heading" className="text-sm font-semibold">
            Monthly token budget
          </h3>
          <p className="text-xs text-muted-foreground">
            Hard cap across the calendar month (UTC). Provider calls are rejected with HTTP 402 once
            the running sum of tokens exceeds the cap. Empty = no cap.
          </p>
        </div>
        {savedToast ? (
          <span
            role="status"
            aria-live="polite"
            className="rounded bg-emerald-100 px-2 py-1 text-xs text-emerald-900"
            data-testid="budget-saved-toast"
          >
            Saved
          </span>
        ) : null}
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label htmlFor="budget-input">Tokens / month</Label>
          <Input
            id="budget-input"
            data-testid="budget-input"
            type="number"
            min={1}
            inputMode="numeric"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="No cap"
            disabled={!canEdit || save.isPending}
          />
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => save.mutate()}
          disabled={!canEdit || !dirty || save.isPending}
          data-testid="budget-save-button"
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      {!canEdit ? (
        <p className="text-xs text-muted-foreground" data-testid="budget-readonly-note">
          Read-only — admin role required to edit.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="budget-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
