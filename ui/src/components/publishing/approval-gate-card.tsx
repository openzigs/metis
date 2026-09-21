"use client";

/**
 * Epic #609 (#619) — publish/export approval gate UI.
 *
 * - `ApprovalGateSettingsCard`: per-project `requireApprovedReview` toggle.
 *   Visible to everyone with project.read; the toggle itself is enabled only
 *   for roles carrying `review.admin` (the server enforces this regardless).
 * - `ApprovalGateBlockNotice`: renders a 409 APPROVAL_REQUIRED / 503
 *   APPROVAL_GATE_UNAVAILABLE block with the offending items and a link to
 *   the review queue so the user can create/view the required reviews.
 */
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPermission } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { reviewGateApi } from "@/lib/publishing-api";
import { APPROVAL_GATE_UNAVAILABLE, type ApprovalGateBlock } from "@/lib/approval-gate";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

const gateKey = (projectId: string) => ["publishing", "review-gate", projectId] as const;

export function ApprovalGateSettingsCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canToggle = user ? hasPermission(user.role, "review.admin") : false;

  const gate = useQuery({
    queryKey: gateKey(projectId),
    queryFn: () => reviewGateApi.get(projectId),
    enabled: Boolean(projectId),
  });

  const update = useMutation({
    mutationFn: (requireApprovedReview: boolean) =>
      reviewGateApi.update(projectId, { requireApprovedReview }),
    onSuccess: () => qc.invalidateQueries({ queryKey: gateKey(projectId) }),
  });

  const enabled = gate.data?.requireApprovedReview ?? false;

  return (
    <Card className="p-4" data-testid="approval-gate-card">
      <h2 className="text-sm font-semibold">Approval gate</h2>
      <p className="mt-1 text-xs text-slate-500">
        When enabled, publishing issue drafts and exporting requirements or generated documents is
        blocked unless each item has an approved, up-to-date review.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          id="requireApprovedReview"
          data-testid="approval-gate-toggle"
          type="checkbox"
          checked={enabled}
          disabled={gate.isLoading || update.isPending || !canToggle}
          onChange={(e) => update.mutate(e.target.checked)}
        />
        <Label htmlFor="requireApprovedReview">Require approved review to publish/export</Label>
      </div>
      {!canToggle && (
        <p className="mt-2 text-xs text-slate-400">
          Only review administrators (coordinator/admin) can change this setting.
        </p>
      )}
      {update.error && (
        <p className="mt-2 text-xs text-red-600" data-testid="approval-gate-toggle-error">
          {update.error instanceof ApiError ? update.error.message : String(update.error)}
        </p>
      )}
    </Card>
  );
}

/**
 * Issue #1117 (finding F) — a bare `join(", ")` of 16 cuids is not information.
 * Lead with the COUNT (the thing a reader can act on), then show a bounded
 * sample rather than a wall of opaque ids.
 */
const ID_SAMPLE = 5;

function BlockedIdList({
  label,
  ids,
  testId,
}: {
  label: string;
  ids: string[];
  testId: string;
}): React.ReactElement | null {
  if (ids.length === 0) return null;
  const shown = ids.slice(0, ID_SAMPLE);
  return (
    <p className="mt-1" data-testid={testId}>
      <span className="font-medium">
        {ids.length} {label}
      </span>
      : <span className="font-mono">{shown.join(", ")}</span>
      {ids.length > shown.length && <span> and {ids.length - shown.length} more</span>}
    </p>
  );
}

export function ApprovalGateBlockNotice({ block }: { block: ApprovalGateBlock }) {
  return (
    <div
      role="alert"
      className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900"
      data-testid="approval-gate-block"
    >
      <p className="font-semibold">
        {block.code === APPROVAL_GATE_UNAVAILABLE
          ? "Approval gate check failed — publishing is blocked (fail-closed)."
          : "Blocked by the approval gate."}
      </p>
      <p className="mt-1">{block.message}</p>
      <BlockedIdList
        label="requirement(s) need an approved, up-to-date review"
        ids={block.requirementIds}
        testId="gate-requirement-ids"
      />
      <BlockedIdList
        label="draft(s) have no linked requirement, so they cannot be verified"
        ids={block.unlinkedDraftIds}
        testId="gate-unlinked-draft-ids"
      />
      <BlockedIdList
        label="document(s) need an approved, up-to-date review"
        ids={block.documentIds}
        testId="gate-document-ids"
      />
      {block.code !== APPROVAL_GATE_UNAVAILABLE && (
        <p className="mt-2">
          <Link href="/reviews" className="font-medium underline">
            Create or view reviews
          </Link>
        </p>
      )}
    </div>
  );
}
