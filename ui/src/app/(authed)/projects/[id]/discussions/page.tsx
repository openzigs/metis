"use client";

/**
 * Epic #475 (Phase 4, #486) — Discussions tab: thread list + create.
 *
 * A thin Next.js client wrapper around the discussions client API. The list
 * renders a project's collaborative threads; "New discussion" creates one and
 * routes into its thread view. The interactive, testable pieces (message list,
 * composer, realtime wiring) live in `@/components/chat/discussion-*`.
 */
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createThread, listThreads } from "@/lib/discussions-api";

export default function DiscussionsListPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const router = useRouter();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const {
    data: threads = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["discussions", projectId],
    queryFn: () => listThreads(projectId),
    enabled: !!projectId,
  });

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const thread = await createThread({
        projectId,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["discussions", projectId] });
      router.push(`/projects/${projectId}/discussions/${thread.id}`);
    } catch (err) {
      toast.error((err as Error).message || "Failed to create discussion");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Discussions</h1>
          <p className="text-sm text-muted-foreground">
            Collaborate with your team and the AI participant in a shared, realtime thread.
          </p>
        </div>
      </div>

      <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="new-discussion-title" className="text-sm font-medium">
            New discussion
          </label>
          <Input
            id="new-discussion-title"
            placeholder="Optional title…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={creating}
          />
        </div>
        <Button onClick={() => void handleCreate()} disabled={creating || !projectId}>
          {creating ? "Creating…" : "Start discussion"}
        </Button>
      </Card>

      {error ? (
        <div
          role="alert"
          className="rounded border border-destructive p-3 text-sm text-destructive"
        >
          {(error as Error).message || "Failed to load discussions"}
        </div>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading discussions…</p>
      ) : threads.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No discussions yet. Start one above to bring the team together.
        </p>
      ) : (
        <ul className="space-y-2">
          {threads.map((t) => (
            <li key={t.id}>
              <Link
                href={`/projects/${projectId}/discussions/${t.id}`}
                className="flex items-center justify-between rounded-md border border-border p-3 text-sm transition-colors hover:bg-accent"
              >
                <span className="font-medium">{t.title || "Untitled discussion"}</span>
                <span className="text-xs text-muted-foreground">AI: {t.aiResponseMode}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
