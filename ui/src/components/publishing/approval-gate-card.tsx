"use client";

/**
 * Epic #609 (#619) — publish/export approval gate UI.
 *
 * - `ApprovalGateSettingsCard`: per-project `requireApprovedReview` toggle,
 *   and (#2436) the `allowSelfApproval` maker-checker toggle, off by default.
 *   Visible to everyone with project.read; the gate toggle is enabled only for
 *   roles carrying `review.admin`, and (#2453) the self-approval toggle only for
 *   an admin, since a coordinator is the maker that maker-checker binds. The
 *   server enforces both regardless.
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
import { queryKeys, reviewGateKey } from "@/lib/query-keys";
import type { ReviewGateConfigPatch } from "@metis/shared";
import { APPROVAL_GATE_UNAVAILABLE, type ApprovalGateBlock } from "@/lib/approval-gate";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

const gateKey = reviewGateKey;

/** #2436 — what the self-approval setting does, under its toggle. */
export const SELF_APPROVAL_HELP =
  "Off (the default), someone who wrote or edited a requirement cannot approve it, and whoever requests a review cannot sign it off; a colleague must. Turn it on for a team of one. Approving still needs the requirement.approve permission. Only an admin can change it, and each change of this setting is recorded in the audit log.";

/** #2453 — shown to a review administrator who is not an admin. */
export const SELF_APPROVAL_ADMIN_ONLY =
  "Only an admin can change self-approval, so whoever is bound by it cannot switch it off for their own project.";

export function ApprovalGateSettingsCard({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canToggle = user ? hasPermission(user.role, "review.admin") : false;
  const canToggleSelfApproval = user?.role === "admin";

  const gate = useQuery({
    queryKey: gateKey(projectId),
    queryFn: () => reviewGateApi.get(projectId),
    enabled: Boolean(projectId),
  });

  const update = useMutation({
    mutationFn: (patch: ReviewGateConfigPatch) => reviewGateApi.update(projectId, patch),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: gateKey(projectId) });
      // #2452 — the Requirements list flags rows by this setting
      // (`selfApprovalForbidden`): re-read it, so turning self-approval on
      // re-enables Approve now, not when the cached list goes stale.
      await qc.invalidateQueries({ queryKey: queryKeys.analyses.requirementsList(projectId) });
    },
  });

  const enabled = gate.data?.requireApprovedReview ?? false;
  const selfApproval = gate.data?.allowSelfApproval ?? false;
  const busy = gate.isLoading || update.isPending;
  const disabled = busy || !canToggle;

  return (
    <Card id="approval-gate" className="scroll-mt-4 p-4" data-testid="approval-gate-card">
      <h2 className="text-sm font-semibold">Approval gate</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        When enabled, publishing issue drafts and exporting requirements or generated documents is
        blocked unless each item has an approved, up-to-date review.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <input
          id="requireApprovedReview"
          data-testid="approval-gate-toggle"
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => update.mutate({ requireApprovedReview: e.target.checked })}
        />
        <Label htmlFor="requireApprovedReview">Require approved review to publish/export</Label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          id="allowSelfApproval"
          data-testid="self-approval-toggle"
          type="checkbox"
          checked={selfApproval}
          disabled={busy || !canToggleSelfApproval}
          onChange={(e) => update.mutate({ allowSelfApproval: e.target.checked })}
        />
        <Label htmlFor="allowSelfApproval">Allow self-approval</Label>
      </div>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="self-approval-help">
        {SELF_APPROVAL_HELP}
      </p>
      {canToggle && !canToggleSelfApproval && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="self-approval-admin-only">
          {SELF_APPROVAL_ADMIN_ONLY}
        </p>
      )}
      {!canToggle && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only review administrators (coordinator/admin) can change the approval gate, and only an
          admin can change self-approval.
        </p>
      )}
      {update.error && (
        <p className="mt-2 text-xs text-destructive" data-testid="approval-gate-toggle-error">
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
      className="mb-3 rounded border border-warning/40 bg-warning-muted p-3 text-xs text-warning"
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
