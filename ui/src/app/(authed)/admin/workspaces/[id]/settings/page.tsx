"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Trash2, Crown, Shield, User, ArrowRightLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api-client";

interface WorkspaceDetails {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  members: {
    id: string;
    role: string;
    user: { id: string; username: string; displayName: string; email: string };
  }[];
  _count: { projects: number };
}

async function fetchWorkspace(id: string): Promise<WorkspaceDetails> {
  return apiFetch<WorkspaceDetails>(`/workspaces/${id}`);
}

export default function WorkspaceSettingsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const { data: workspace, isLoading } = useQuery({
    queryKey: ["workspace", params.id],
    queryFn: () => fetchWorkspace(params.id),
  });

  useEffect(() => {
    if (workspace) setName(workspace.name);
  }, [workspace]);

  const updateMutation = useMutation({
    mutationFn: async (data: { name?: string }) => {
      return apiFetch(`/workspaces/${params.id}`, {
        method: "PATCH",
        body: data,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace", params.id] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiFetch(`/workspaces/${params.id}`, { method: "DELETE" });
    },
    onSuccess: () => router.push("/admin"),
  });

  const updateRoleMutation = useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: string }) => {
      await apiFetch(`/workspaces/${params.id}/members/${memberId}`, {
        method: "PATCH",
        body: { role },
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace", params.id] }),
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (memberId: string) => {
      await apiFetch(`/workspaces/${params.id}/members/${memberId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace", params.id] }),
  });

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading workspace settings…</div>;
  }

  if (!workspace) {
    return <div className="p-8 text-destructive">Workspace not found</div>;
  }

  const roleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown className="h-4 w-4 text-amber-500" />;
      case "admin":
        return <Shield className="h-4 w-4 text-blue-500" />;
      default:
        return <User className="h-4 w-4 text-muted-foreground" />;
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Building2 className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Workspace Settings</h1>
      </div>

      {/* General Settings */}
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Update your workspace name and branding</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ws-name">Name</Label>
            <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="text-sm text-muted-foreground">
            Slug: <code className="rounded bg-muted px-1.5 py-0.5">{workspace.slug}</code>
            {" · "}
            {workspace._count.projects} project(s)
          </div>
          <Button
            onClick={() => updateMutation.mutate({ name })}
            disabled={updateMutation.isPending || name === workspace.name}
          >
            Save changes
          </Button>
        </CardContent>
      </Card>

      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>Manage workspace members and their roles</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="divide-y">
            {workspace.members.map((m) => (
              <div key={m.id} className="flex items-center gap-3 py-3">
                {roleIcon(m.role)}
                <div className="flex-1">
                  <p className="font-medium">{m.user.displayName}</p>
                  <p className="text-sm text-muted-foreground">{m.user.email}</p>
                </div>
                <select
                  value={m.role}
                  onChange={(e) =>
                    updateRoleMutation.mutate({ memberId: m.id, role: e.target.value })
                  }
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                >
                  <option value="owner">Owner</option>
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </select>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeMemberMutation.mutate(m.id)}
                  aria-label={`Remove ${m.user.displayName}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>Irreversible actions — proceed with caution</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <p className="font-medium">Transfer ownership</p>
              <p className="text-sm text-muted-foreground">
                Hand off workspace ownership to another member
              </p>
            </div>
            <Button variant="outline" size="sm">
              <ArrowRightLeft className="mr-1.5 h-4 w-4" />
              Transfer
            </Button>
          </div>
          <div className="flex items-center justify-between rounded-md border border-destructive/30 p-3">
            <div>
              <p className="font-medium">Delete workspace</p>
              <p className="text-sm text-muted-foreground">
                This will soft-delete the workspace and all its data
              </p>
            </div>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  <Trash2 className="mr-1.5 h-4 w-4" />
                  Delete
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete workspace &ldquo;{workspace.name}&rdquo;?</DialogTitle>
                  <DialogDescription>
                    This action cannot be easily undone. All projects in this workspace will become
                    orphaned and team members will lose access.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline">Cancel</Button>
                  <Button variant="destructive" onClick={() => deleteMutation.mutate()}>
                    Delete workspace
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
