"use client";

/**
 * #732 — "New baseline" on the Baselines page.
 *
 * `POST /api/projects/:projectId/baselines` (review.admin) had no caller, so a
 * project whose requirements were never approved through a review could not
 * get a baseline from the UI. This pins the CURRENT version of the project's
 * requirements under a name, except items imported from a tracker that nobody
 * has approved (#1137 — it pinned hundreds of those), and says how many it will
 * pin, of which status, and what it leaves out before it is created.
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
  const notApproved = n - scope.approved;
  const pins =
    n === 0
      ? "There is nothing to pin yet."
      : `Pins the current version of ${n} ${n === 1 ? "requirement" : "requirements"} in this project: ${scope.approved} approved, ${notApproved} not yet approved.`;
  const x = scope.excludedImported;
  if (x === 0) return pins;
  const left = `${pins} ${x} ${x === 1 ? "item" : "items"} imported from a tracker and not approved ${x === 1 ? "is" : "are"} left out.`;
  // Nothing else to pin: say how to get the imported items in.
  return n === 0
    ? `${left} To include them, approve the ones you want on the Requirements page, or request a review there.`
    : left;
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
              ? "Pins the current version of the project's requirements, except unapproved imported items."
              : "Counting the requirements…"}
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
