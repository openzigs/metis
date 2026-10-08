"use client";

/**
 * #863 — archive a settled publish batch from the UI.
 *
 * The API has offered archive (`POST /batches/:id/archive`) since Phase 9, but
 * nothing in the UI reached it, so a finished or failed batch could only be
 * cleared with a hand-written request. Archiving hides the batch from the list;
 * closing the issues it created on GitHub is a separate, opt-in choice, off by
 * default because it is visible to everyone watching the target repository.
 */
import { useState } from "react";
import type { ArchivePublishBatchInput, PublishBatch } from "@metis/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ArchiveBatchDialogProps {
  batch: Pick<PublishBatch, "id" | "dryRun" | "publishedCount" | "targetOwner" | "targetRepo">;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  /** The server's message when the archive was refused. */
  error?: string | null;
  onConfirm: (input: ArchivePublishBatchInput) => void;
}

export function ArchiveBatchDialog({
  batch,
  onOpenChange,
  pending,
  error,
  onConfirm,
}: ArchiveBatchDialogProps) {
  const [reason, setReason] = useState("");
  const [closeIssues, setCloseIssues] = useState(false);
  // A dry run created nothing on GitHub, so there is nothing to close.
  const canClose = !batch.dryRun && batch.publishedCount > 0;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive this batch?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The batch is hidden from this list. Its record is kept for the audit trail.
        </p>
        <div className="mt-3 space-y-1">
          <Label htmlFor="archive-reason">Reason</Label>
          <Textarea
            id="archive-reason"
            value={reason}
            maxLength={2000}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {canClose && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={closeIssues}
              onChange={(e) => setCloseIssues(e.target.checked)}
            />
            Also close the {batch.publishedCount} issue{batch.publishedCount === 1 ? "" : "s"} it
            created in {batch.targetOwner}/{batch.targetRepo}
          </label>
        )}
        {error ? (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Keep batch
          </Button>
          <Button
            variant="destructive"
            disabled={pending || reason.trim().length === 0}
            onClick={() =>
              onConfirm({ reason: reason.trim(), closeIssues: canClose && closeIssues })
            }
          >
            {pending ? "Archiving…" : "Archive batch"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
