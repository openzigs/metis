"use client";

/**
 * Epic #728 / Issue #734 — CommentPanel component.
 *
 * Right-rail slide-out panel (Sheet) that shows all comment threads for
 * a requirement or Spec Kit artifact, and allows creating new threads.
 */
import { useCallback, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { CommentThreadComponent } from "@/components/comments/CommentThread";
import { MentionInput } from "@/components/comments/MentionInput";
import { commentApi } from "@/lib/collaboration-api";
import type { CommentThread } from "@/lib/collaboration-api";

// ---- Query keys ------------------------------------------------------------

function threadQueryKey(
  scope: "requirement" | "artifact",
  id: string,
  extra?: string,
): readonly unknown[] {
  return scope === "requirement"
    ? ["comments", "requirement", id]
    : ["comments", "artifact", id, extra ?? ""];
}

// ---- Props -----------------------------------------------------------------

interface CommentPanelProps {
  open: boolean;
  onClose: () => void;
  /** Requirement mode */
  requirementId?: string;
  /** Spec Kit artifact mode */
  projectId?: string;
  artifactName?: string;
  currentUserId?: string;
  title?: string;
}

// ---- Component -------------------------------------------------------------

export function CommentPanel({
  open,
  onClose,
  requirementId,
  projectId,
  artifactName,
  currentUserId,
  title,
}: CommentPanelProps) {
  const queryClient = useQueryClient();
  const [newBody, setNewBody] = useState("");
  const [newTitle, setNewTitle] = useState("");

  const isRequirement = !!requirementId;
  const queryKey = isRequirement
    ? threadQueryKey("requirement", requirementId!)
    : threadQueryKey("artifact", projectId ?? "", artifactName);

  const { data: threads = [], isLoading } = useQuery<CommentThread[]>({
    queryKey,
    queryFn: () =>
      isRequirement
        ? commentApi.listForRequirement(requirementId!)
        : commentApi.listForArtifact(projectId!, artifactName!),
    enabled: open && (!!requirementId || (!!projectId && !!artifactName)),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      isRequirement
        ? commentApi.createForRequirement(requirementId!, {
            title: newTitle.trim() || undefined,
            body: newBody,
          })
        : commentApi.createForArtifact(projectId!, artifactName!, {
            title: newTitle.trim() || undefined,
            body: newBody,
          }),
    onSuccess: () => {
      setNewBody("");
      setNewTitle("");
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const handleUpdated = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="flex w-96 flex-col gap-0 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <SheetTitle className="text-sm font-semibold">{title ?? "Comments"}</SheetTitle>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            aria-label="Close comments"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        <SheetDescription className="sr-only">
          Comment threads for {title ?? "this item"}
        </SheetDescription>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && threads.length === 0 && (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          )}
          <div className="flex flex-col gap-4">
            {threads.map((thread) => (
              <div key={thread.id}>
                <CommentThreadComponent
                  thread={thread}
                  currentUserId={currentUserId}
                  onUpdated={handleUpdated}
                />
                <Separator className="mt-4" />
              </div>
            ))}
          </div>
        </div>

        {/* New thread form */}
        <div className="border-t px-4 py-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">New comment</p>
          <MentionInput
            value={newBody}
            onChange={setNewBody}
            placeholder="Write a comment… Use @username to mention"
            className="mb-2 min-h-[70px] text-sm"
          />
          <Button
            size="sm"
            className="w-full"
            disabled={!newBody.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            Post
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
