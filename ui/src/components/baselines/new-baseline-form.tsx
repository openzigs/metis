"use client";

/**
 * #732 — "New baseline" on the Baselines page.
 *
 * `POST /api/projects/:projectId/baselines` (review.admin) had no caller, so a
 * project whose requirements were never approved through a review could not
 * get a baseline from the UI. This pins the CURRENT version of every APPROVED
 * requirement in the project under a name (#1137 — it used to pin every row,
 * including hundreds of unreviewed tracker imports), and says how many it will
 * pin and what it leaves out before it is created. The server refuses a
 * project with nothing approved.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { baselinesApi, type BaselineScopePreview } from "@/lib/baselines-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** #1137 — the sentence saying what New baseline pins and what it leaves out. */
export function describeBaselineScope(scope: BaselineScopePreview): string {
  const n = scope.pinCount;
  const pins =
    n === 0
      ? "No requirement in this project is approved yet, so there is nothing to pin."
      : `Pins the current version of the ${n} approved ${n === 1 ? "requirement" : "requirements"} in this project.`;
  const { total, imported } = scope.excluded;
  if (total === 0) return pins;
  const importedNote = imported > 0 ? `, ${imported} of them imported from a tracker` : "";
  return `${pins} ${total} not yet approved ${total === 1 ? "is" : "are"} left out${importedNote}.`;
}

export function NewBaselineForm({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const scope = useQuery({
    queryKey: queryKeys.baselines.scope(projectId),
    queryFn: () => baselinesApi.scope(projectId),
    enabled: open,
  });

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
      await qc.invalidateQueries({ queryKey: queryKeys.baselines.scope(projectId) });
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
        <p className="text-xs text-muted-foreground" data-testid="new-baseline-scope">
          {scope.data
            ? describeBaselineScope(scope.data)
            : scope.isError
              ? "Pins the current version of every approved requirement in this project."
              : "Counting the approved requirements…"}
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
          <Button
            type="submit"
            size="sm"
            disabled={!name.trim() || create.isPending || scope.data?.pinCount === 0}
          >
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
