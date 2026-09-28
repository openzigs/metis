"use client";

/**
 * Evidence Review Panel (Epic #597 / Issue #625).
 *
 * Displays web research evidence digests with source links, domain trust
 * badges, and approve/reject controls for each piece of evidence.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { analysisApi, type ApprovalRequestPayload } from "@/lib/analysis-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type DomainTrust = "high" | "medium" | "low";

interface WebSource {
  url: string;
  title: string;
  excerpt: string;
  relevanceScore: number;
  domainTrust: DomainTrust;
}

interface EvidenceDigest {
  id: string;
  requirementId: string;
  query: string;
  sources: WebSource[];
  digest: string;
  needsHumanReview: boolean;
}

interface EvidenceReviewProps {
  projectId: string;
  analysisId: string;
  digests: EvidenceDigest[];
  approvals: ApprovalRequestPayload[];
  onApprovalChange: () => void;
}

const TRUST_BADGES: Record<DomainTrust, { label: string; className: string }> = {
  high: {
    label: "High Trust",
    className: "bg-success-muted text-success border-success/40",
  },
  medium: {
    label: "Medium Trust",
    className: "bg-warning-muted text-warning border-warning/40",
  },
  low: {
    label: "Low Trust",
    className: "bg-destructive/10 text-destructive border-destructive/40",
  },
};

export function EvidenceReview({
  projectId,
  analysisId,
  digests,
  approvals,
  onApprovalChange,
}: EvidenceReviewProps): React.ReactElement {
  const qc = useQueryClient();

  const reviewMutation = useMutation({
    mutationFn: ({ approvalId, status }: { approvalId: string; status: "approved" | "rejected" }) =>
      analysisApi.reviewApproval(projectId, analysisId, approvalId, { status }),
    onSuccess: () => {
      onApprovalChange();
      qc.invalidateQueries({ queryKey: ["approvals", analysisId] });
    },
  });

  if (digests.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">No web research evidence to review.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Evidence Review</h3>
      <p className="text-sm text-muted-foreground">
        Review the web research evidence below. Approve or reject each piece.
      </p>

      {digests.map((digest) => {
        const approval = approvals.find((a) => a.itemId === digest.id && a.type === "evidence");
        const isResolved = approval && approval.status !== "pending";

        return (
          <Card key={digest.id} className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm">
                Query: <span className="text-foreground">{digest.query}</span>
              </h4>
              {digest.needsHumanReview && (
                <span className="rounded border border-warning/40 bg-warning-muted px-2 py-0.5 text-xs text-warning">
                  Needs Review
                </span>
              )}
            </div>

            <p className="text-sm text-foreground">{digest.digest}</p>

            {digest.sources.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Sources:</p>
                {digest.sources.map((source, i) => {
                  const badge = TRUST_BADGES[source.domainTrust];
                  return (
                    <div key={i} className="rounded border border-border bg-muted/40 p-2 text-xs">
                      <div className="flex items-center gap-2">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-info hover:underline"
                        >
                          {source.title}
                        </a>
                        <span
                          className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{source.excerpt}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {approval && !isResolved && (
              <div className="flex items-center gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    reviewMutation.mutate({
                      approvalId: approval.id,
                      status: "approved",
                    })
                  }
                  disabled={reviewMutation.isPending}
                >
                  ✓ Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    reviewMutation.mutate({
                      approvalId: approval.id,
                      status: "rejected",
                    })
                  }
                  disabled={reviewMutation.isPending}
                >
                  ✕ Reject
                </Button>
              </div>
            )}

            {isResolved && (
              <p className="text-xs text-muted-foreground">
                Status:{" "}
                <span
                  className={approval.status === "approved" ? "text-success" : "text-destructive"}
                >
                  {approval.status}
                </span>
                {approval.reviewNote && ` — ${approval.reviewNote}`}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
