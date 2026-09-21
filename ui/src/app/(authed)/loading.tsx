import { SkeletonText } from "@/components/ui/skeleton";

/**
 * S1 (#143) — default loading UI for the authed segment. Next.js renders this
 * automatically while an async page/layout in the segment is pending.
 */
export default function AuthedLoading() {
  return (
    <div className="space-y-4 p-2 md:p-0" data-testid="authed-loading">
      <SkeletonText lines={2} label="Loading page…" className="max-w-sm" />
      <SkeletonText lines={5} label="Loading content…" />
    </div>
  );
}
