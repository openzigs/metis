/**
 * #2547 — the "Restricted" badge a document carries wherever it is listed (the
 * Documents page, the quarantine reviewer, the change-request document
 * pickers). To a reader of the document it says who else reads it; to a
 * member the list leaves out it says only "Restricted": the server sends such
 * a member no subjects (#2546), so who reads it is never shown to them. An
 * unrestricted document, or a row the server did not annotate, shows nothing.
 */
import type { AclSubject, DocumentAccess } from "@/lib/projects-api";
import { Badge } from "@/components/ui/badge";

/** "role coordinator, user u_123" — the subjects as the editor names them. */
export function describeAclSubjects(subjects: AclSubject[]): string {
  return subjects.map((s) => `${s.kind} ${s.value}`).join(", ");
}

/**
 * The subjects that can actually read: a legacy `group` subject matches no
 * one (#2261 — METIS stores no group membership), so it is not named as one.
 */
function readerSubjects(subjects: AclSubject[]): AclSubject[] {
  return subjects.filter((s) => s.kind !== "group");
}

export function RestrictedBadge({
  access,
  testId,
}: {
  access: DocumentAccess | undefined;
  testId?: string;
}): React.ReactElement | null {
  if (!access?.restricted) return null;
  if (!access.canRead) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-xs" data-testid={testId}>
        <Badge variant="outline">Restricted</Badge>
      </span>
    );
  }
  const readers = readerSubjects(access.subjects);
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-xs" data-testid={testId}>
      <Badge variant="outline">Restricted</Badge>
      <span className="text-muted-foreground">
        {readers.length > 0
          ? `Readable by ${describeAclSubjects(readers)} and admins`
          : "Readable by admins only"}
      </span>
    </span>
  );
}
