/**
 * Issue #2345 (epic #2328) — the link back from an impact analysis or a
 * portfolio check to the change request it was started from: one click returns
 * the analyst to it. The server names the change request only to a reader of
 * its project (`changeRequest` on the result); the title is rendered as text.
 */
import Link from "next/link";
import type { ChangeRequestRef } from "@metis/shared";

export function changeRequestHref(ref: Pick<ChangeRequestRef, "id" | "projectId">): string {
  return `/projects/${encodeURIComponent(ref.projectId)}/analysis?${new URLSearchParams({ analysisId: ref.id }).toString()}`;
}

export function ChangeRequestBackLink({
  changeRequest,
  className,
  testId,
}: {
  changeRequest: ChangeRequestRef;
  className?: string;
  testId: string;
}) {
  return (
    <Link href={changeRequestHref(changeRequest)} className={className} data-testid={testId}>
      ← Back to the change request: {changeRequest.title}
    </Link>
  );
}
