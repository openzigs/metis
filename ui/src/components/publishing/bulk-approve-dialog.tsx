"use client";

/**
 * Bulk-approve confirmation dialog.
 *
 * Shown before bulk-approving a multi-select set of drafts. Surfaces the
 * status breakdown of the selection (created/updated/skipped) so the
 * coordinator knows exactly how many drafts will actually transition vs
 * which ones are already approved/published and will be skipped.
 */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface BulkApproveCounts {
  total: number;
  created: number;
  updated: number;
  skipped: number;
}

export interface BulkApproveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  counts: BulkApproveCounts;
  pending: boolean;
  onConfirm: () => void;
}

/**
 * Compute counts from a list of drafts whose status feeds the breakdown.
 *  - "created"  → drafts that will transition draft → approved.
 *  - "updated"  → drafts already approved (re-approve is a no-op but allowed).
 *  - "skipped"  → drafts that are published / failed and won't change.
 */
export function computeApprovalCounts(
  selected: Array<{ id: string; status: string }>,
): BulkApproveCounts {
  let created = 0;
  let updated = 0;
  let skipped = 0;
  for (const d of selected) {
    if (d.status === "draft") created += 1;
    else if (d.status === "approved") updated += 1;
    else skipped += 1;
  }
  return { total: selected.length, created, updated, skipped };
}

export function BulkApproveDialog({
  open,
  onOpenChange,
  counts,
  pending,
  onConfirm,
}: BulkApproveDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Approve {counts.total} draft{counts.total === 1 ? "" : "s"}?
          </DialogTitle>
        </DialogHeader>
        <ul className="mt-2 space-y-1 text-sm" data-testid="bulk-approve-counts">
          <li>
            <span className="text-emerald-700 font-medium">{counts.created}</span> will be approved
            (draft → approved)
          </li>
          <li>
            <span className="text-sky-700 font-medium">{counts.updated}</span> already approved
            (re-confirmed)
          </li>
          <li>
            <span className="text-slate-500 font-medium">{counts.skipped}</span> skipped (published
            or failed)
          </li>
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending || counts.created + counts.updated === 0}>
            {pending ? "Approving…" : `Approve ${counts.created + counts.updated}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
