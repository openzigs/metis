"use client";

/**
 * Epic #728 / Issue #736 — AssigneePicker component.
 *
 * Dropdown that shows current assignees for a requirement and lets the user
 * add or remove assignees.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { assignmentApi } from "@/lib/collaboration-api";
import type { Assignment } from "@/lib/collaboration-api";
import { apiFetch } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface User {
  id: string;
  username: string;
  displayName: string;
}

interface AssigneePickerProps {
  requirementId: string;
  className?: string;
}

async function searchUsers(q: string): Promise<User[]> {
  if (!q.trim()) return [];
  const data = await apiFetch<{ data: User[] }>(`/users?search=${encodeURIComponent(q)}&limit=8`);
  return data.data ?? [];
}

function assignmentQueryKey(requirementId: string) {
  return ["assignments", requirementId] as const;
}

export function AssigneePicker({ requirementId, className }: AssigneePickerProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: assignmentQueryKey(requirementId),
    queryFn: () => assignmentApi.list(requirementId),
  });

  const { data: searchResults = [] } = useQuery<User[]>({
    queryKey: ["users", "assignee-search", search],
    queryFn: () => searchUsers(search),
    enabled: open && search.length >= 2,
    staleTime: 30_000,
  });

  const assignedUserIds = new Set(assignments.map((a) => a.assigneeId));

  const addMutation = useMutation({
    mutationFn: (userId: string) => assignmentApi.assign(requirementId, { assigneeId: userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: assignmentQueryKey(requirementId),
      });
      setSearch("");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => assignmentApi.unassign(requirementId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: assignmentQueryKey(requirementId),
      });
    },
  });

  return (
    <div className={cn("relative", className)}>
      <div className="flex flex-wrap items-center gap-1">
        {assignments.map((a) => (
          <span
            key={a.id}
            className="flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
          >
            @{a.assignee?.username ?? a.assigneeId}
            <button
              aria-label={`Remove ${a.assignee?.username ?? a.assigneeId}`}
              onClick={() => removeMutation.mutate(a.assigneeId)}
              className="ml-0.5 rounded-full p-0.5 hover:bg-indigo-200 dark:hover:bg-indigo-800"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label="Add assignee"
          onClick={() => setOpen((v) => !v)}
        >
          <UserPlus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-56 rounded-md border bg-popover shadow-md">
          <div className="p-2">
            <Input
              autoFocus
              placeholder="Search users…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 text-sm"
            />
          </div>
          {searchResults.length > 0 && (
            <ul role="listbox" className="max-h-40 overflow-auto pb-2">
              {searchResults.map((u) => {
                const alreadyAssigned = assignedUserIds.has(u.id);
                return (
                  <li
                    key={u.id}
                    role="option"
                    aria-selected={alreadyAssigned}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
                      alreadyAssigned
                        ? "cursor-default text-muted-foreground"
                        : "hover:bg-accent hover:text-accent-foreground",
                    )}
                    onClick={() => {
                      if (!alreadyAssigned) {
                        addMutation.mutate(u.id);
                        setOpen(false);
                      }
                    }}
                  >
                    <span className="font-medium">{u.displayName}</span>
                    <span className="text-muted-foreground">@{u.username}</span>
                    {alreadyAssigned && (
                      <span className="ml-auto text-xs text-muted-foreground">assigned</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {search.length >= 2 && searchResults.length === 0 && (
            <p className="px-3 pb-2 text-xs text-muted-foreground">No users found.</p>
          )}
        </div>
      )}
    </div>
  );
}
