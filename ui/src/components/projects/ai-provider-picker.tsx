"use client";

/**
 * Issue #134 — per-project AI provider override.
 *
 * Renders a select with the supported provider keys + a "global default"
 * option. PATCHes the project on save and surfaces server validation errors
 * inline. Disabled while the mutation is in-flight.
 *
 * #149 — a project whose stored override is no longer a supported provider
 * (e.g. the removed `copilot-native`) shows that value as a disabled option
 * with a notice, rather than silently displaying "Global default" for a row
 * that still says otherwise. The server refuses new chat sessions for it until
 * another provider (or the global default) is saved.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AI_PROVIDER_KEYS } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  /** Current value from the project row; null/undefined ⇒ global default. */
  current: string | null | undefined;
}

const GLOBAL_DEFAULT = "__global__";

export function AiProviderPicker({ projectId, current }: Props) {
  const qc = useQueryClient();
  const [value, setValue] = useState<string>(current ?? GLOBAL_DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const unsupported =
    current && !(AI_PROVIDER_KEYS as readonly string[]).includes(current) ? current : null;

  const save = useMutation({
    mutationFn: () =>
      projectsApi.update(projectId, {
        aiProviderId: value === GLOBAL_DEFAULT ? null : value,
      }),
    onSuccess: () => {
      setError(null);
      setStatus("Saved");
      qc.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    },
    onError: (err: unknown) => {
      setStatus(null);
      setError(err instanceof ApiError ? err.message : "Update failed");
    },
  });

  return (
    <form
      className="space-y-2 rounded-md border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setStatus(null);
        setError(null);
        save.mutate();
      }}
      data-testid="ai-provider-picker"
    >
      <Label htmlFor="ai-provider-select">AI provider</Label>
      <div className="flex items-center gap-2">
        <select
          id="ai-provider-select"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="ai-provider-select"
        >
          <option value={GLOBAL_DEFAULT}>Global default</option>
          {unsupported ? (
            <option value={unsupported} disabled>
              {unsupported} (no longer supported)
            </option>
          ) : null}
          {AI_PROVIDER_KEYS.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={save.isPending} data-testid="ai-provider-save">
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Overrides the global default for AI sessions started inside this project.
      </p>
      {unsupported ? (
        <p className="text-sm text-destructive" role="status" data-testid="ai-provider-unsupported">
          This project is set to “{unsupported}”, which METIS no longer supports. New chat sessions
          in this project are refused until you choose another provider or the global default and
          save.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
    </form>
  );
}
