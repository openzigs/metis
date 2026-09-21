"use client";

/**
 * Epic #770 / Issue #774 — Restore confirmation dialog.
 *
 * Requires the operator to type the exact phrase `Restore version N` before the
 * confirm button is enabled, guarding against accidental rollbacks.
 */
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import { historyApi, type RestoreResult } from "@/lib/history-api";

export interface RestoreVersionDialogProps {
  requirementId: string;
  /** The version to restore; `null` keeps the dialog closed. */
  version: number | null;
  onClose: () => void;
  onRestored: (result: RestoreResult) => void;
}

export function RestoreVersionDialog({
  requirementId,
  version,
  onClose,
  onRestored,
}: RestoreVersionDialogProps): React.ReactElement {
  const [confirmText, setConfirmText] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const open = version !== null;
  const requiredPhrase = version !== null ? `Restore version ${version}` : "";
  const canConfirm = open && confirmText.trim() === requiredPhrase && !isSubmitting;

  // Reset transient state whenever the target version changes.
  React.useEffect(() => {
    setConfirmText("");
    setReason("");
    setError(null);
    setIsSubmitting(false);
  }, [version]);

  async function handleConfirm(): Promise<void> {
    if (version === null || !canConfirm) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const result = await historyApi.restore(requirementId, version, reason.trim() || undefined);
      onRestored(result);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Restore failed");
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore version {version ?? ""}</DialogTitle>
          <DialogDescription>
            This creates a new version with the contents of version {version ?? ""}. History is
            preserved — nothing is overwritten. Type{" "}
            <span className="font-mono font-semibold">{requiredPhrase}</span> to confirm.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="restore-confirm">Confirmation phrase</Label>
            <Input
              id="restore-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={requiredPhrase}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="restore-reason">Reason (optional)</Label>
            <Input
              id="restore-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you restoring this version?"
              autoComplete="off"
            />
          </div>
          {error ? (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {isSubmitting ? "Restoring…" : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
