"use client";

/**
 * #2555 — choose who a document is restricted to, the way an analyst knows
 * them: a person found by name or username among the people who can open the
 * project (`GET /api/users?projectId=`, the @mention and assignee pickers'
 * search), or a role from the role list. No internal id is ever typed: the
 * free-text "Value" field it replaces asked for one ("e.g. u_123").
 *
 * Used by the access-list editor and by the uploader's "Restrict to…".
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ROLE_KEYS } from "@metis/shared";
import { apiFetch } from "@/lib/api-client";
import type { AclSubject, AclUserName } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PickKind = "user" | "role";

/** The people who can open `projectId` whose name or username matches `term`. */
export function searchProjectPeople(projectId: string, term: string): Promise<AclUserName[]> {
  return apiFetch<AclUserName[]>(
    `/users?search=${encodeURIComponent(term)}&limit=8&projectId=${encodeURIComponent(projectId)}`,
  ).then((people) => people ?? []);
}

export function AclSubjectPicker(props: {
  projectId: string;
  /** Prefix for the controls' ids, unique on the page. */
  idPrefix: string;
  /** The subjects already chosen: not offered again. */
  chosen: readonly AclSubject[];
  /** A subject was picked; `person` is who a `user` subject names. */
  onAdd: (subject: AclSubject, person?: AclUserName) => void;
}) {
  const [kind, setKind] = useState<PickKind>("user");
  const [term, setTerm] = useState("");
  const [role, setRole] = useState<string>(ROLE_KEYS[0]);
  const query = term.trim();
  const people = useQuery({
    queryKey: ["users", "acl-picker", props.projectId, query],
    queryFn: () => searchProjectPeople(props.projectId, query),
    enabled: kind === "user" && query !== "",
    staleTime: 30_000,
  });
  const isChosen = (k: PickKind, value: string) =>
    props.chosen.some((s) => s.kind === k && s.value === value);
  const offered = (people.data ?? []).filter((p) => !isChosen("user", p.id));

  return (
    <div className="space-y-2" data-testid="acl-subject-picker">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="space-y-1">
          <Label htmlFor={`${props.idPrefix}-kind`}>Kind</Label>
          <select
            id={`${props.idPrefix}-kind`}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as PickKind)}
            data-testid="acl-kind-select"
          >
            <option value="user">Person</option>
            <option value="role">Role</option>
          </select>
        </div>
        {kind === "user" ? (
          <div className="flex-1 space-y-1">
            <Label htmlFor={`${props.idPrefix}-person`}>Person</Label>
            <Input
              id={`${props.idPrefix}-person`}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search by name or username"
              autoComplete="off"
              data-testid="acl-person-search"
            />
          </div>
        ) : (
          <>
            <div className="flex-1 space-y-1">
              <Label htmlFor={`${props.idPrefix}-role`}>Role</Label>
              <select
                id={`${props.idPrefix}-role`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                data-testid="acl-role-select"
              >
                {ROLE_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={isChosen("role", role)}
              onClick={() => props.onAdd({ kind: "role", value: role })}
              data-testid="acl-add"
            >
              Add
            </Button>
          </>
        )}
      </div>
      {kind === "user" && query !== "" && people.isSuccess ? (
        offered.length > 0 ? (
          <ul className="max-h-40 space-y-1 overflow-auto" aria-label="Matching people">
            {offered.map((person) => (
              <li key={person.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    props.onAdd({ kind: "user", value: person.id }, person);
                    setTerm("");
                  }}
                  data-testid={`acl-person-option-${person.id}`}
                >
                  <span className="font-medium">{person.displayName}</span>
                  <span className="text-muted-foreground">@{person.username}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="acl-person-none">
            No one else in this project matches “{query}”.
          </p>
        )
      ) : null}
      {people.isError ? (
        <p className="text-xs text-destructive" role="alert" data-testid="acl-person-error">
          People could not be searched. Try again.
        </p>
      ) : null}
    </div>
  );
}
