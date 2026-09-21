"use client";

/**
 * Epic #157 — Per-document ACL editor.
 *
 * Lets a reviewer assign user/role/group subjects to the document. An empty
 * list = unrestricted. Updates propagate to every chunk on save.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { aclApi, type AclSubject } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AclEditor(props: {
  projectId: string;
  documentId: string;
  initialSubjects: AclSubject[];
  onSaved?: () => void;
}) {
  const qc = useQueryClient();
  const [subjects, setSubjects] = useState<AclSubject[]>(props.initialSubjects);
  const [draftKind, setDraftKind] = useState<AclSubject["kind"]>("user");
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
            onChange={(e) => setDraftKind(e.target.value as AclSubject["kind"])}
            data-testid="acl-kind-select"
          >
            <option value="user">user</option>
            <option value="role">role</option>
            <option value="group">group</option>
          </select>
        </div>
        <div className="flex-1 space-y-1">
          <Label htmlFor={`acl-value-${props.documentId}`}>Value</Label>
          <Input
            id={`acl-value-${props.documentId}`}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder="e.g. u_123 or admin or eng-team"
            data-testid="acl-value-input"
          />
        </div>
        <Button type="button" onClick={add} variant="outline" data-testid="acl-add">
          Add
        </Button>
      </div>
      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending} data-testid="acl-save">
          {save.isPending ? "Saving…" : "Save ACL"}
        </Button>
      </div>
    </Card>
  );
}
