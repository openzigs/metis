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
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  medium: {
    label: "Medium Trust",
    className: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  low: {
    label: "Low Trust",
    className: "bg-red-500/15 text-red-300 border-red-500/30",
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
        <p className="text-sm text-zinc-400">No web research evidence to review.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Evidence Review</h3>
      <p className="text-sm text-zinc-400">
        Review the web research evidence below. Approve or reject each piece.
      </p>

      {digests.map((digest) => {
        const approval = approvals.find((a) => a.itemId === digest.id && a.type === "evidence");
        const isResolved = approval && approval.status !== "pending";

        return (
          <Card key={digest.id} className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-sm">
                Query: <span className="text-zinc-300">{digest.query}</span>
              </h4>
              {digest.needsHumanReview && (
                <span className="rounded border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
                  Needs Review
                </span>
              )}
            </div>

            <p className="text-sm text-zinc-300">{digest.digest}</p>

            {digest.sources.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-zinc-400">Sources:</p>
                {digest.sources.map((source, i) => {
                  const badge = TRUST_BADGES[source.domainTrust];
                  return (
                    <div
                      key={i}
                      className="rounded border border-zinc-800 bg-zinc-900/40 p-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate text-blue-400 hover:underline"
                        >
                          {source.title}
                        </a>
                        <span
                          className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 ${badge.className}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <p className="mt-1 text-zinc-400">{source.excerpt}</p>
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
              <p className="text-xs text-zinc-500">
                Status:{" "}
                <span
                  className={approval.status === "approved" ? "text-emerald-400" : "text-red-400"}
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
