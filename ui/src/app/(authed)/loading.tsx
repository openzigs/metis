import { PageHeaderSkeleton } from "@/components/ui/page-header";

/**
 * S1 (#143) — default loading UI for the authed segment. Next.js renders this
 * automatically while an async page/layout in the segment is pending.
 * #270 — shaped like a PageHeader and its content, built from Skeleton.
 */
export default function AuthedLoading() {
  return (
    <div className="p-2 md:p-0" data-testid="authed-loading">
      <PageHeaderSkeleton label="Loading page…" />
    </div>
  );
}
