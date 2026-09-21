"use client";

/**
 * Alert rule editor (Epic #47 / Issue #54).
 * Lists existing budget alert rules, lets an admin add a rule (threshold % +
 * basis), toggle enable, and delete. Quick presets for 50/80/100%.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { finopsApi, type AlertRule } from "@/lib/finops-api";

interface Props {
  workspaceId: string;
}

export const PRESETS = [50, 80, 100] as const;

export function AlertRuleEditor({ workspaceId }: Props) {
  const qc = useQueryClient();
  const rulesKey = ["finops", workspaceId, "rules"];
  const [name, setName] = useState("");
  const [thresholdPct, setThresholdPct] = useState(80);
  const [basis, setBasis] = useState<"mtd" | "projected">("projected");

  const { data, isLoading, error } = useQuery({
    queryKey: rulesKey,
    queryFn: () => finopsApi.getRules(workspaceId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: rulesKey });

  const createMutation = useMutation({
    mutationFn: () =>
      finopsApi.createRule(workspaceId, {
        name: name.trim() || `${thresholdPct}% ${basis}`,
        thresholdPct,
        basis,
      }),
    onSuccess: () => {
      setName("");
      void invalidate();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (rule: AlertRule) =>
      finopsApi.updateRule(workspaceId, rule.id, { enabled: !rule.enabled }),
    onSuccess: () => void invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: (ruleId: string) => finopsApi.deleteRule(workspaceId, ruleId),
    onSuccess: () => void invalidate(),
  });

  const rules = data?.rules ?? [];

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <h3 className="text-sm font-semibold">Alert Rules</h3>

      {isLoading && <p className="text-sm text-muted-foreground">Loading rules…</p>}
      {error && <p className="text-sm text-red-500">Failed to load rules.</p>}

      {rules.length > 0 && (
        <ul className="space-y-1">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between rounded border px-2 py-1 text-sm"
            >
              <span>
                <span className="font-medium">{rule.name}</span>{" "}
                <span className="text-muted-foreground">
                  ({rule.thresholdPct}% {rule.basis})
                </span>
              </span>
              <span className="flex items-center gap-2">
                <button
                  onClick={() => toggleMutation.mutate(rule)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    rule.enabled ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
                  }`}
                  aria-label={`Toggle rule ${rule.name}`}
                >
                  {rule.enabled ? "Enabled" : "Disabled"}
                </button>
                <button
                  onClick={() => deleteMutation.mutate(rule.id)}
                  className="rounded px-2 py-0.5 text-xs text-red-500 hover:bg-red-50"
                  aria-label={`Delete rule ${rule.name}`}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Rule name (optional)"
          aria-label="Rule name"
          className="flex-1 rounded border bg-background px-2 py-1 text-sm"
        />
        <input
          type="number"
          min={1}
          max={1000}
          value={thresholdPct}
          onChange={(e) => setThresholdPct(Number(e.target.value))}
          aria-label="Threshold percent"
          className="w-20 rounded border bg-background px-2 py-1 text-sm"
        />
        <select
          value={basis}
          onChange={(e) => setBasis(e.target.value as "mtd" | "projected")}
          aria-label="Threshold basis"
          className="rounded border bg-background px-2 py-1 text-sm"
        >
          <option value="projected">Projected</option>
          <option value="mtd">Month to date</option>
        </select>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="rounded bg-primary px-3 py-1 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Add Rule
        </button>
      </div>

      <div className="flex gap-1">
        {PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => setThresholdPct(p)}
            className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/80"
          >
            {p}%
          </button>
        ))}
      </div>
      {createMutation.isError && <p className="text-xs text-red-500">Failed to create rule.</p>}
    </div>
  );
}
