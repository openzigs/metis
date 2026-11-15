"use client";

/**
 * Epic #157 — Per-document ACL editor.
 *
 * Lets a reviewer assign user/role subjects to the document. An empty
 * list = unrestricted. Updates propagate to every chunk on save.
 *
 * #2248 — no `group` subject is offered: METIS stores no group membership, so
 * a group subject matches nobody: it grants no access, and a document whose
 * only subjects are groups is retrievable by admins alone. A group subject
 * already on a document is still listed, with that warning, so it can be
 * removed.
 *
 * #2547 — mounted on each document of the Documents page and the quarantine
 * reviewer. A save that leaves the editor off the list is allowed, but they
 * then cannot read the document or change its list again (`PATCH /acl`
 * refuses a member it is restricted away from), so the editor says so first.
 *
 * #2555 — subjects are picked, not typed: a person by name among the project's
 * people, a role from the role list (`AclSubjectPicker`), and each is listed by
 * name (`aclSubjectLabel`), never by internal id.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { aclApi, type AclSubject, type AclUserName } from "@/lib/projects-api";
import { aclSubjectLabel } from "@/lib/document-access";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AclSubjectPicker } from "@/components/projects/acl-subject-picker";

/**
 * #2547 — `subjects` would shut `viewer` out: a non-empty list naming neither
 * their user id nor their role, and no admin bypass (the server's rule).
 * An approximation for a warning only: `viewer.role` is the session's role,
 * while the server decides on the durable role (`resolveAclActor`), so for a
 * member whose role changed since sign-in it may be wrong either way, and the
 * warning says so. The server stays authoritative.
 */
export function aclLocksOut(
  subjects: AclSubject[],
  viewer: { id: string; role: string } | null,
): boolean {
  if (!viewer || viewer.role === "admin" || subjects.length === 0) return false;
  return !subjects.some(
    (s) =>
      (s.kind === "user" && s.value === viewer.id) ||
      (s.kind === "role" && s.value === viewer.role),
  );
}

/** #2555 — a listed person's username beside their name, to tell two namesakes apart. */
function Username({ id, people }: { id: string; people: readonly AclUserName[] }) {
  const person = people.find((p) => p.id === id);
  return person ? <span className="text-muted-foreground">{` @${person.username}`}</span> : null;
}

export function AclEditor(props: {
  projectId: string;
  documentId: string;
  initialSubjects: AclSubject[];
  /** #2555 — the people `initialSubjects` names (`access.users`), to list them by name. */
  initialUsers?: AclUserName[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [subjects, setSubjects] = useState<AclSubject[]>(props.initialSubjects);
  const [people, setPeople] = useState<AclUserName[]>(props.initialUsers ?? []);

  const save = useMutation({
    mutationFn: () => aclApi.update(props.projectId, props.documentId, subjects),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quarantine", props.projectId] });
      // #2547 — the Documents list shows the badge from the saved list.
      qc.invalidateQueries({ queryKey: queryKeys.documents.forProject(props.projectId) });
      props.onSaved?.();
    },
  });

  const add = (subject: AclSubject, person?: AclUserName) => {
    if (subjects.some((s) => s.kind === subject.kind && s.value === subject.value)) return;
    setSubjects([...subjects, subject]);
    if (person) setPeople([...people.filter((p) => p.id !== person.id), person]);
  };

  const remove = (index: number) => {
    setSubjects(subjects.filter((_, i) => i !== index));
  };

  return (
    <Card className="space-y-3 p-3" data-testid="acl-editor">
      <h3 className="text-sm font-semibold">Who can read this document</h3>
      {subjects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No restrictions — every project member can retrieve this document.
        </p>
      ) : (
        <ul className="space-y-1" data-testid="acl-subjects">
          {subjects.map((s, i) => (
            <li
              key={`${s.kind}:${s.value}:${i}`}
              className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs"
            >
              <span>
                {aclSubjectLabel(s, people)}
                {s.kind === "user" ? <Username id={s.value} people={people} /> : null}
                {s.kind === "group" && (
                  <span className="block text-muted-foreground" data-testid="acl-group-warning">
                    Matches no one: METIS does not know group membership, so this entry grants no
                    access (only admins and the other entries here can retrieve the document).
                    Remove it, or name users or roles instead.
                  </span>
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(i)}
                aria-label={`Remove ${aclSubjectLabel(s, people)}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AclSubjectPicker
        projectId={props.projectId}
        idPrefix={`acl-${props.documentId}`}
        chosen={subjects}
        onAdd={add}
      />
      {/* #2356 — a refused save (a new group, or another editor saving at the
          same time) says why, instead of leaving the old list in place unexplained. */}
      {aclLocksOut(subjects, user) ? (
        <p className="text-xs text-warning" role="status" data-testid="acl-lockout-warning">
          You are not on this list: once it is saved you will not be able to read this document or
          change who can. Add yourself or your role to keep access. This uses your role from when
          you signed in; if it has changed since, this warning may be out of date.
        </p>
      ) : null}
      {save.error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="acl-save-error">
          {save.error instanceof Error ? save.error.message : "The access list could not be saved."}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="acl-save">
          {save.isPending ? "Saving…" : "Save access list"}
        </Button>
      </div>
    </Card>
  );
}
