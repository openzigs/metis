"use client";

/**
 * v1.2.0 — per-project AI model id override.
 *
 * Free-form text input for a Bedrock / Copilot / OpenAI model id. Empty
 * input clears the override, falling back to the global default
 * (loadAIConfig().model). PATCHes the project on save and surfaces server
 * validation errors inline.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  /** Current value from the project row; null/undefined ⇒ global default. */
  current: string | null | undefined;
}

const MAX_LENGTH = 200;

export function AiModelPicker({ projectId, current }: Props) {
  const qc = useQueryClient();
  const [value, setValue] = useState<string>(current ?? "");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const trimmed = value.trim();
      return projectsApi.update(projectId, {
        aiModel: trimmed.length === 0 ? null : trimmed,
      });
    },
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
        if (value.length > MAX_LENGTH) {
          setError(`Model id must be ≤ ${MAX_LENGTH} characters`);
          return;
        }
        setStatus(null);
        setError(null);
        save.mutate();
      }}
      data-testid="ai-model-picker"
    >
      <Label htmlFor="ai-model-input">AI model</Label>
      <div className="flex items-center gap-2">
        <Input
          id="ai-model-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="leave blank to use the global default"
          maxLength={MAX_LENGTH}
          data-testid="ai-model-input"
        />
        <Button type="submit" size="sm" disabled={save.isPending} data-testid="ai-model-save">
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        e.g. <code>us.anthropic.claude-sonnet-4-6</code> — leave blank to use the global default.
      </p>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
    </form>
  );
}
