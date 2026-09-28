import { PageHeaderSkeleton } from "@/components/ui/page-header";

/**
 * S1 (#143) — segment-level loading UI for a single project.
 * #270 — shaped like a PageHeader and its content, built from Skeleton.
 */
export default function ProjectLoading() {
  return (
    <div className="p-6" data-testid="project-loading">
      <PageHeaderSkeleton label="Loading project…" />
    </div>
  );
}
