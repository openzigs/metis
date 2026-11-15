/**
 * #2547 — the "Restricted" badge a document carries wherever it is listed (the
 * Documents page, the quarantine reviewer, the change-request document
 * pickers): it says the document has an access list, who is on it, and, to a
 * member who is not, that they cannot read it. An unrestricted document, or a
 * row the server did not annotate, shows nothing.
 */
import type { AclSubject, DocumentAccess } from "@/lib/projects-api";
import { Badge } from "@/components/ui/badge";

/** "role coordinator, user u_123" — the subjects as the editor names them. */
export function describeAclSubjects(subjects: AclSubject[]): string {
  return subjects.map((s) => `${s.kind} ${s.value}`).join(", ");
}

export function RestrictedBadge({
  access,
  testId,
}: {
  access: DocumentAccess | undefined;
  testId?: string;
}): React.ReactElement | null {
  if (!access?.restricted) return null;
  const readers = describeAclSubjects(access.subjects);
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" data-testid={testId}>
      <Badge variant="outline">Restricted</Badge>
      <span className="text-muted-foreground">Readable by {readers} and admins</span>
      {!access.canRead ? <span className="text-muted-foreground">· you cannot read it</span> : null}
    </span>
  );
}
