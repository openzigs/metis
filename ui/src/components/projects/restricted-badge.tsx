/**
 * #2547 — the "Restricted" badge a document carries wherever it is listed (the
 * Documents page, the quarantine reviewer, the change-request document
 * pickers). To a reader of the document it says who else reads it; to a
 * member the list leaves out it says only "Restricted": the server sends such
 * a member no subjects (#2546), so who reads it is never shown to them. An
 * unrestricted document, or a row the server did not annotate, shows nothing.
 *
 * #2555 — a person is named by their display name, never their internal id
 * ("Readable by Alice Smith, the coordinator role and admins").
 */
import type { AclSubject, AclUserName, DocumentAccess } from "@/lib/projects-api";
import { aclSubjectLabel, UNKNOWN_ACL_PERSON } from "@/lib/document-access";
import { Badge } from "@/components/ui/badge";

/**
 * "Alice Smith, the coordinator role" — the subjects as the editor names them.
 * People the server named no one for are counted once, after the rest ("2
 * people not in this project"), not repeated.
 */
export function describeAclSubjects(
  subjects: AclSubject[],
  users?: readonly AclUserName[],
): string {
  const labels: string[] = [];
  let unknown = 0;
  for (const s of subjects) {
    const label = aclSubjectLabel(s, users);
    if (label === UNKNOWN_ACL_PERSON) unknown += 1;
    else labels.push(label);
  }
  if (unknown === 1) labels.push(UNKNOWN_ACL_PERSON);
  if (unknown > 1) labels.push(`${unknown} people not in this project`);
  return labels.join(", ");
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
          ? `Readable by ${describeAclSubjects(readers, access.users)} and admins`
          : "Readable by admins only"}
      </span>
    </span>
  );
}
