/**
 * Epic #298 / Issue #312 — finding-level API helpers.
 */
import { apiFetch } from "@/lib/api-client";

export const findingsApi = {
  /**
   * Acknowledge that a human reviewed an `ambiguous`-derivation finding.
   * Records an audit row server-side; does not mutate the finding row itself.
   */
  acknowledgeReview(findingId: string, note?: string): Promise<{ id: string; reviewedAt: string }> {
    return apiFetch<{ id: string; reviewedAt: string }>(`/findings/${findingId}/review-ack`, {
      method: "POST",
      body: note ? { note } : {},
    });
  },
};
