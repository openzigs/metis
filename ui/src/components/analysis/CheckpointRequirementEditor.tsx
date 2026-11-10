"use client";

/**
 * Issue #1580 (`b-7-8`) — edit a requirement in the approval checkpoint.
 *
 * Approving promotes the reviewed title and description (#730), and the
 * checkpoint had no way to change them: "edit one, then approve" meant
 * approving first and editing the promoted row on the Requirements page. This
 * edits the reviewed requirement while its approval is still pending. The
 * server refuses a resolved approval (409), and the panel then refreshes.
 *
 * #2147 — the typed text is a {@link CheckpointDraft} the panel holds, not
 * state of this component: a refresh that finds the approval resolved moves
 * its card to the Resolved list, which mounts a new card, and the text and the
 * message saying where to edit instead went with the old one.
 */
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

/** #2147 — an open edit: what the reviewer has typed so far. */
export interface CheckpointDraft {
  title: string;
  description: string;
}

/** #2147 — a new draft, holding the reviewed text. */
export function checkpointDraftOf(
  requirement: Pick<StructuredRequirement, "title" | "description">,
): CheckpointDraft {
  return { title: requirement.title, description: requirement.description ?? "" };
}

export interface CheckpointRequirementEditorProps {
  projectId: string;
  analysisId: string;
  approvalId: string;
  requirement: Pick<StructuredRequirement, "title" | "description">;
  /** For accessible names: what the card calls this requirement. */
  itemName: string;
  draft: CheckpointDraft;
  onDraftChange: (update: (draft: CheckpointDraft) => CheckpointDraft) => void;
  /**
   * #2147 — the approval is no longer pending (reviewed meanwhile): the text
   * stays on screen to copy, with where to edit it now, and cannot be saved.
   */
  resolved: boolean;
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
  draft,
  onDraftChange,
  resolved,
  onDone,
}: CheckpointRequirementEditorProps): React.ReactElement {
  const qc = useQueryClient();
  const { title, description } = draft;
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
      // Someone approved or rejected it meanwhile: show where it went. The
      // refresh moves the card to Resolved, where `resolved` keeps the text.
      if (err instanceof ApiError && err.code === "APPROVAL_ALREADY_REVIEWED") {
        void qc.invalidateQueries({ queryKey: ["approvals", analysisId] });
      }
    },
  });
  const refused =
    resolved || (save.error instanceof ApiError && save.error.code === "APPROVAL_ALREADY_REVIEWED");

  return (
    <form
      className="space-y-2 rounded border border-border p-2"
      data-testid="checkpoint-requirement-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (patch && !titleBlank && !refused) save.mutate(patch);
      }}
    >
      <label className="block space-y-1 text-xs font-medium text-foreground">
        <span>Title</span>
        <Input
          aria-label={`Title of ${itemName}`}
          value={title}
          maxLength={MAX_TITLE}
          readOnly={refused}
          onChange={(e) => {
            const next = e.target.value;
            onDraftChange((d) => ({ ...d, title: next }));
          }}
        />
      </label>
      <label className="block space-y-1 text-xs font-medium text-foreground">
        <span>Description</span>
        <Textarea
          aria-label={`Description of ${itemName}`}
          value={description}
          maxLength={MAX_DESCRIPTION}
          rows={4}
          readOnly={refused}
          onChange={(e) => {
            const next = e.target.value;
            onDraftChange((d) => ({ ...d, description: next }));
          }}
        />
      </label>
      {titleBlank && !refused && (
        <p className="text-xs text-destructive">A requirement needs a title.</p>
      )}
      <div className="flex items-center gap-2">
        {!refused && (
          <Button type="submit" size="sm" disabled={!patch || titleBlank || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onDone}
          disabled={save.isPending}
        >
          {refused ? "Close" : "Cancel"}
        </Button>
      </div>
      {refused ? (
        <p role="alert" className="text-xs text-destructive">
          This requirement was already reviewed, so it can no longer be edited here. Edit it on the
          Requirements page.
        </p>
      ) : (
        save.isError && (
          <p role="alert" className="text-xs text-destructive">
            {save.error instanceof ApiError
              ? save.error.message
              : "Could not save the edit. Try again."}
          </p>
        )
      )}
    </form>
  );
}
