"use client";

/**
 * Epic #475 (Phase 4, #486) — single discussion thread view.
 *
 * Thin Next.js wrapper hosting the testable `DiscussionThreadView` component.
 * Resolves the thread's `aiResponseMode` from the project's thread list (shared
 * query cache) so an @AI mention triggers a reply consistently with the server
 * gate; defaults to `on_mention` while the list loads.
 */
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { listThreads, type AiResponseMode } from "@/lib/discussions-api";
import { DiscussionThreadView } from "@/components/chat/discussion-thread-view";

export default function DiscussionThreadPage() {
  const params = useParams<{ id: string; discussionId: string }>();
  const projectId = params?.id ?? "";
  const discussionId = params?.discussionId ?? "";
  const { user } = useAuth();

  const { data: threads = [] } = useQuery({
    queryKey: ["discussions", projectId],
    queryFn: () => listThreads(projectId),
    enabled: !!projectId,
  });
  const thread = threads.find((t) => t.id === discussionId);
  const aiResponseMode: AiResponseMode = thread?.aiResponseMode ?? "on_mention";

  return (
    <div className="flex h-[calc(100vh-9rem)] flex-col gap-3 p-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href={`/projects/${projectId}/discussions`}
            className="text-xs text-muted-foreground hover:underline"
          >
            ← All discussions
          </Link>
          <h1 className="text-xl font-semibold">{thread?.title || "Discussion"}</h1>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DiscussionThreadView
          threadId={discussionId}
          currentUserId={user?.id}
          aiResponseMode={aiResponseMode}
          projectId={projectId}
        />
      </div>
    </div>
  );
}
