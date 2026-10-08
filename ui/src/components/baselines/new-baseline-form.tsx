"use client";

/**
 * #732 — "New baseline" on the Baselines page.
 *
 * `POST /api/projects/:projectId/baselines` (review.admin) had no caller, so a
 * project whose requirements were never approved through a review could not
 * get a baseline from the UI. This pins the CURRENT version of every
 * requirement in the project under a name; the server refuses an empty project.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { baselinesApi } from "@/lib/baselines-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function NewBaselineForm({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      baselinesApi.create(projectId, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: async () => {
      setOpen(false);
      setName("");
      setDescription("");
      setError(null);
      await qc.invalidateQueries({ queryKey: queryKeys.baselines.list(projectId) });
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Could not create the baseline");
    },
  });

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)} data-testid="new-baseline">
        New baseline
      </Button>
    );
  }

  return (
    <Card className="w-full max-w-lg space-y-3 p-4" data-testid="new-baseline-form">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h2 className="text-sm font-semibold">New baseline</h2>
        <p className="text-xs text-muted-foreground">
          Pins the current version of every requirement in this project.
        </p>
        <div className="space-y-1">
          <Label htmlFor="baseline-name">Name</Label>
          <Input
            id="baseline-name"
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="baseline-description">Description (optional)</Label>
          <Input
            id="baseline-description"
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Create baseline"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
