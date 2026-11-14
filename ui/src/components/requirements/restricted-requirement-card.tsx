/**
 * #2447 — a requirement the viewer cannot see a source of, on the change
 * request page. The server sends its placeholder (`restricted: true`, title
 * "Restricted"); this shows where it sits in the list and why its text is
 * hidden, with none of the actions the server would refuse (edit, review,
 * history, comments, assignments).
 */
import { Lock } from "lucide-react";
import type { RequirementSummary } from "@/lib/analysis-api";

export function RestrictedRequirementCard({
  requirement,
}: {
  requirement: Pick<
    RequirementSummary,
    "id" | "title" | "body" | "type" | "priority" | "reviewStatus"
  >;
}) {
  return (
    <div
      id={`requirement-${requirement.id}`}
      data-testid={`req-restricted-${requirement.id}`}
      className="scroll-mt-4 rounded border border-dashed border-border bg-muted/20 p-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Lock className="h-3.5 w-3.5" aria-hidden="true" />
        {requirement.title}
      </div>
      <div className="text-xs text-muted-foreground">
        {requirement.type} · {requirement.priority} · {requirement.reviewStatus}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{requirement.body}</p>
    </div>
  );
}
