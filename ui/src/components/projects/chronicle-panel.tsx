"use client";

/**
 * Epic #157 — Chronicle (project memory) panel.
 *
 * Shows persisted per-project memory entries with an "enable" toggle and a
 * record/forget UI. Server gates writes by `project.update`.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { chronicleApi } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const QK = (id: string) => ["chronicle", id] as const;

export function ChroniclePanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: QK(projectId),
    queryFn: () => chronicleApi.list(projectId),
    enabled: Boolean(projectId),
  });

  const [keyDraft, setKeyDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");

  const record = useMutation({
    mutationFn: () =>
      chronicleApi.record(projectId, { key: keyDraft.trim(), value: valueDraft.trim() }),
    onSuccess: () => {
      setKeyDraft("");
      setValueDraft("");
      qc.invalidateQueries({ queryKey: QK(projectId) });
    },
  });

  const forget = useMutation({
    mutationFn: (entryId: string) => chronicleApi.forget(projectId, entryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK(projectId) }),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      chronicleApi.updateSettings(projectId, { chronicleEnabled: enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK(projectId) }),
  });

  const enabled = Boolean(list.data?.enabled);

  return (
    <Card className="space-y-4 p-4" data-testid="chronicle-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Project memory (Chronicle)</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggle.mutate(e.target.checked)}
            disabled={toggle.isPending}
            aria-label="Enable Chronicle for this project"
            data-testid="chronicle-enable"
            className="h-4 w-4"
          />
          <span className="text-muted-foreground">Enabled</span>
        </label>
      </div>

      {!enabled ? (
        <p className="text-sm text-muted-foreground">
          Chronicle is disabled. Enable it to let agents persist durable per-project memory across
          sessions.
        </p>
      ) : (
        <>
          <form
            className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_2fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (keyDraft.trim() && valueDraft.trim()) record.mutate();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="chronicle-key">Key</Label>
              <Input
                id="chronicle-key"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                placeholder="e.g. preferred_db"
                data-testid="chronicle-key-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="chronicle-value">Value</Label>
              <Input
                id="chronicle-value"
                value={valueDraft}
                onChange={(e) => setValueDraft(e.target.value)}
                placeholder="Postgres on RDS, us-east-1"
                data-testid="chronicle-value-input"
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" disabled={record.isPending} data-testid="chronicle-record">
                Remember
              </Button>
            </div>
          </form>
          {list.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading entries…</p>
          ) : list.data && list.data.items.length > 0 ? (
            <ul className="divide-y" data-testid="chronicle-list">
              {list.data.items.map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                  data-testid={`chronicle-row-${entry.id}`}
                >
                  <div>
                    <p className="font-medium">{entry.key}</p>
                    <p className="text-xs text-muted-foreground">{entry.value}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => forget.mutate(entry.id)}
                    aria-label={`Forget ${entry.key}`}
                  >
                    Forget
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No entries yet.</p>
          )}
        </>
      )}
    </Card>
  );
}
