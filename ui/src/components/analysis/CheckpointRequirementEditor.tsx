"use client";

/**
 * Issue #1580 (`b-7-8`) — edit a requirement in the approval checkpoint.
 *
 * Approving promotes the reviewed title and description (#730), and the
 * checkpoint had no way to change them: "edit one, then approve" meant
 * approving first and editing the promoted row on the Requirements page. This
 * edits the reviewed requirement while its approval is still pending. The
 * server refuses a resolved approval (409), and the panel then refreshes.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { analysisApi, type StructuredRequirement } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** The server's limits (`editCheckpointRequirementSchema`). */
const MAX_TITLE = 255;
const MAX_DESCRIPTION = 4096;

export interface CheckpointRequirementEditorProps {
  projectId: string;
  analysisId: string;
  approvalId: string;
  requirement: Pick<StructuredRequirement, "title" | "description">;
  /** For accessible names: what the card calls this requirement. */
  itemName: string;
  onDone: () => void;
}

/**
 * The fields that differ from the stored requirement, trimmed as the server
 * trims them; null when nothing changed.
 */
export function checkpointEditPatch(
  stored: Pick<StructuredRequirement, "title" | "description">,
  title: string,
  description: string,
): { title?: string; description?: string } | null {
  const patch: { title?: string; description?: string } = {};
  if (title.trim() !== stored.title) patch.title = title.trim();
  if (description.trim() !== (stored.description ?? "")) patch.description = description.trim();
  return Object.keys(patch).length > 0 ? patch : null;
}

export function CheckpointRequirementEditor({
  projectId,
  analysisId,
  approvalId,
  requirement,
  itemName,
  onDone,
}: CheckpointRequirementEditorProps): React.ReactElement {
  const qc = useQueryClient();
  const [title, setTitle] = useState(requirement.title);
  const [description, setDescription] = useState(requirement.description ?? "");
  const patch = checkpointEditPatch(requirement, title, description);
  const titleBlank = title.trim().length === 0;

  const save = useMutation({
    mutationFn: (body: { title?: string; description?: string }) =>
      analysisApi.editCheckpointRequirement(projectId, analysisId, approvalId, body),
    onSuccess: async () => {
      // The checkpoint reads the reviewed list from the analysis metadata.
      await qc.invalidateQueries({ queryKey: queryKeys.analyses.detail(analysisId) });
      onDone();
    },
    onError: (err) => {
      // Someone approved or rejected it meanwhile: show where it went.
      if (err instanceof ApiError && err.code === "APPROVAL_ALREADY_REVIEWED") {
        void qc.invalidateQueries({ queryKey: ["approvals", analysisId] });
      }
    },
  });

  return (
    <form
      className="space-y-2 rounded border border-border p-2"
      data-testid="checkpoint-requirement-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (patch && !titleBlank) save.mutate(patch);
      }}
    >
      <label className="block space-y-1 text-xs font-medium text-foreground">
        <span>Title</span>
        <Input
          aria-label={`Title of ${itemName}`}
          value={title}
          maxLength={MAX_TITLE}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="block space-y-1 text-xs font-medium text-foreground">
        <span>Description</span>
        <Textarea
          aria-label={`Description of ${itemName}`}
          value={description}
          maxLength={MAX_DESCRIPTION}
          rows={4}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      {titleBlank && <p className="text-xs text-destructive">A requirement needs a title.</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!patch || titleBlank || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onDone}
          disabled={save.isPending}
        >
          Cancel
        </Button>
      </div>
      {save.isError && (
        <p role="alert" className="text-xs text-destructive">
          {save.error instanceof ApiError && save.error.code === "APPROVAL_ALREADY_REVIEWED"
            ? "This requirement was already reviewed, so it can no longer be edited here. Edit it on the Requirements page."
            : save.error instanceof ApiError
              ? save.error.message
              : "Could not save the edit. Try again."}
        </p>
      )}
    </form>
  );
}
