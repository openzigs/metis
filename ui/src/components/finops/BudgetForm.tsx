"use client";

/**
 * Workspace monthly budget config form (Epic #47 / Issue #54).
 * Edits `monthlyBudgetCents` (entered in dollars) via the FinOps API.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { finopsApi, formatCents } from "@/lib/finops-api";
import { amountSuggestionMessage } from "@/lib/error-suggestion";

interface Props {
  workspaceId: string;
  currentBudgetCents: number | null;
}

/** Parse a dollar string to integer cents; returns null on empty input. */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

export function BudgetForm({ workspaceId, currentBudgetCents }: Props) {
  const qc = useQueryClient();
  const [value, setValue] = useState(
    currentBudgetCents != null ? (currentBudgetCents / 100).toString() : "",
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (cents: number | null) => finopsApi.setBudget(workspaceId, cents),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["finops", workspaceId, "budget"] });
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (value.trim() !== "") {
      const cents = dollarsToCents(value);
      if (cents === null) {
        // SC 3.3.3 — suggest the cleaned, non-negative value when derivable.
        setError(amountSuggestionMessage(value));
        return;
      }
      mutation.mutate(cents);
    } else {
      mutation.mutate(null);
    }
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border bg-card p-4 space-y-3">
      <h3 className="text-sm font-semibold">Monthly Budget</h3>
      <p className="text-xs text-muted-foreground">
        Current: {currentBudgetCents != null ? formatCents(currentBudgetCents) : "no budget set"}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">$</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0.00"
          aria-label="Monthly budget in dollars"
          className="w-32 rounded border bg-background px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-500">
          {error}
        </p>
      )}
      {mutation.isError && <p className="text-xs text-red-500">Failed to save budget.</p>}
      {mutation.isSuccess && <p className="text-xs text-green-600">Budget saved.</p>}
    </form>
  );
}
