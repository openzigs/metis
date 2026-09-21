"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api-client";
import { workspaceSlugSuggestionMessage } from "@/lib/error-suggestion";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
  createdAt: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export default function WorkspacesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: workspaces = [], isLoading } = useQuery({
    queryKey: ["workspaces", "admin-list"],
    queryFn: () => apiFetch<Workspace[]>("/workspaces"),
  });

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; slug: string }) =>
      apiFetch<Workspace>("/workspaces", { method: "POST", body: payload }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setShowForm(false);
      setName("");
      setSlug("");
      setSlugEdited(false);
      setError(null);
    },
    onError: (err: Error) => {
      setError(err.message || "Failed to create workspace");
    },
  });

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !slug.trim()) return;
    // SC 3.3.3 — a malformed slug has a detectable cause, so suggest the fix
    // rather than deferring to a generic server rejection.
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug.trim())) {
      setError(workspaceSlugSuggestionMessage(slug));
      return;
    }
    createMutation.mutate({ name: name.trim(), slug: slug.trim() });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Workspaces</h1>
          <p className="text-sm text-muted-foreground">
            Manage organization workspaces. Projects belong to a workspace for multi-tenant
            isolation.
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            New workspace
          </Button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-lg border bg-card p-4 space-y-4 max-w-lg">
          <h2 className="text-lg font-semibold">Create a workspace</h2>
          <p className="text-sm text-muted-foreground">
            A workspace groups projects, members, and secrets together. You can move existing
            projects into it later.
          </p>

          <div className="space-y-2">
            <Label htmlFor="ws-name">Name</Label>
            <Input
              id="ws-name"
              placeholder="e.g. Engineering"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              autoFocus
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ws-slug">URL slug</Label>
            <Input
              id="ws-slug"
              placeholder="e.g. engineering"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugEdited(true);
              }}
              maxLength={60}
              pattern="^[a-z0-9][a-z0-9-]*[a-z0-9]$"
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers, and hyphens only. Used in URLs.
            </p>
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={createMutation.isPending || !name.trim() || !slug.trim()}
            >
              {createMutation.isPending ? "Creating…" : "Create workspace"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setShowForm(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Workspace list */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading workspaces…</div>
      ) : workspaces.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Building2 className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <h3 className="mt-3 text-sm font-medium">No workspaces yet</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first workspace to start organizing projects.
          </p>
          {!showForm && (
            <Button onClick={() => setShowForm(true)} className="mt-4 gap-2" size="sm">
              <Plus className="h-4 w-4" />
              Create workspace
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-3">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              className="flex items-center justify-between rounded-lg border bg-card p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-medium">{ws.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    /{ws.slug} · {ws.role}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => router.push(`/admin/workspaces/${ws.id}/settings`)}
                  className="gap-1.5"
                >
                  <Settings className="h-4 w-4" />
                  <span className="hidden sm:inline">Settings</span>
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
