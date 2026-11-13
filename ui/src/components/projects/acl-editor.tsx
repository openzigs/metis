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
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { aclApi, type AclSubject } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The subject kinds a reviewer can add (#2248 — not `group`; see above). */
type AddableKind = Exclude<AclSubject["kind"], "group">;

export function AclEditor(props: {
  projectId: string;
  documentId: string;
  initialSubjects: AclSubject[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [subjects, setSubjects] = useState<AclSubject[]>(props.initialSubjects);
  const [draftKind, setDraftKind] = useState<AddableKind>("user");
  const [draftValue, setDraftValue] = useState("");

  const save = useMutation({
    mutationFn: () => aclApi.update(props.projectId, props.documentId, subjects),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quarantine", props.projectId] });
      props.onSaved?.();
    },
  });

  const add = () => {
    if (!draftValue.trim()) return;
    setSubjects([...subjects, { kind: draftKind, value: draftValue.trim() }]);
    setDraftValue("");
  };

  const remove = (index: number) => {
    setSubjects(subjects.filter((_, i) => i !== index));
  };

  return (
    <Card className="space-y-3 p-3" data-testid="acl-editor">
      <h3 className="text-sm font-semibold">Access control</h3>
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
                <code>{s.kind}</code> · {s.value}
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
                aria-label={`Remove ${s.kind} ${s.value}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={`acl-kind-${props.documentId}`}>Kind</Label>
          <select
            id={`acl-kind-${props.documentId}`}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={draftKind}
            onChange={(e) => setDraftKind(e.target.value as AddableKind)}
            data-testid="acl-kind-select"
          >
            <option value="user">user</option>
            <option value="role">role</option>
          </select>
        </div>
        <div className="flex-1 space-y-1">
          <Label htmlFor={`acl-value-${props.documentId}`}>Value</Label>
          <Input
            id={`acl-value-${props.documentId}`}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder="e.g. u_123 or admin"
            data-testid="acl-value-input"
          />
        </div>
        <Button type="button" onClick={add} variant="outline" data-testid="acl-add">
          Add
        </Button>
      </div>
      {/* #2356 — a refused save (a new group, or another editor saving at the
          same time) says why, instead of leaving the old list in place unexplained. */}
      {save.error ? (
        <p className="text-sm text-destructive" role="alert" data-testid="acl-save-error">
          {save.error instanceof Error ? save.error.message : "The access list could not be saved."}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="acl-save">
          {save.isPending ? "Saving…" : "Save ACL"}
        </Button>
      </div>
    </Card>
  );
}
