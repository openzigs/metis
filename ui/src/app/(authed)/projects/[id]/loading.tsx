import { SkeletonText } from "@/components/ui/skeleton";

/** S1 (#143) — segment-level loading UI for a single project. */
export default function ProjectLoading() {
  return (
    <div className="space-y-4 p-6" data-testid="project-loading">
      <SkeletonText lines={2} label="Loading project…" className="max-w-sm" />
      <SkeletonText lines={6} label="Loading project content…" />
    </div>
  );
}
