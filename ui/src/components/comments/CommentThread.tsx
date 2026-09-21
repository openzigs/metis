"use client";

/**
 * Epic #728 / Issue #734 — CommentThread component.
 *
 * Renders a single comment thread with all its comments. Shows author avatar,
 * relative timestamp, and edit/delete controls for the current user's own
 * comments.
 */
import { useState } from "react";
import type { CommentThread, CommentItem } from "@/lib/collaboration-api";
import { commentApi } from "@/lib/collaboration-api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MentionInput } from "@/components/comments/MentionInput";

interface CommentThreadProps {
  thread: CommentThread;
  currentUserId?: string;
  onUpdated: () => void;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function UserAvatar({ username }: { username: string }) {
  const initials = username.slice(0, 2).toUpperCase();
  return (
    <div
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white"
      aria-label={username}
    >
      {initials}
    </div>
  );
}

function CommentBubble({
  comment,
  currentUserId,
  onDeleted,
  onEdited,
}: {
  comment: CommentItem;
  currentUserId?: string;
  onDeleted: (id: string) => void;
  onEdited: (id: string, body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(comment.body ?? "");
  const [saving, setSaving] = useState(false);

  if (comment.deleted) {
    return <div className="text-sm italic text-muted-foreground">This comment was deleted.</div>;
  }

  const isOwn = comment.authorId === currentUserId;

  async function handleSave() {
    if (!editBody.trim()) return;
    setSaving(true);
    try {
      await commentApi.edit(comment.id, editBody);
      onEdited(comment.id, editBody);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    await commentApi.delete(comment.id);
    onDeleted(comment.id);
  }

  return (
    <div className="flex gap-2">
      <UserAvatar username={comment.author?.username ?? "?"} />
      <div className="flex-1 rounded-lg bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">
            {comment.author?.displayName ?? comment.author?.username ?? "Unknown"}
          </span>
          <span className="text-xs text-muted-foreground">{timeAgo(comment.createdAt)}</span>
          {comment.editedAt && <span className="text-xs text-muted-foreground">(edited)</span>}
          {isOwn && !editing && (
            <div className="ml-auto flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-xs"
                onClick={() => {
                  setEditBody(comment.body ?? "");
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-xs text-destructive"
                onClick={handleDelete}
              >
                Delete
              </Button>
            </div>
          )}
        </div>
        {editing ? (
          <div className="mt-1 flex flex-col gap-1">
            <Textarea
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              className="min-h-[60px] text-sm"
            />
            <div className="flex gap-1">
              <Button size="sm" onClick={handleSave} disabled={saving}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-sm">{comment.body}</p>
        )}
      </div>
    </div>
  );
}

export function CommentThreadComponent({ thread, currentUserId, onUpdated }: CommentThreadProps) {
  const [comments, setComments] = useState<CommentItem[]>(thread.comments);
  const [replyBody, setReplyBody] = useState("");
  const [replying, setReplying] = useState(false);

  async function handleReply() {
    if (!replyBody.trim()) return;
    setReplying(true);
    try {
      const newComment = await commentApi.reply(thread.id, replyBody);
      setComments((prev) => [...prev, newComment]);
      setReplyBody("");
      onUpdated();
    } finally {
      setReplying(false);
    }
  }

  function handleDeleted(id: string) {
    setComments((prev) => prev.map((c) => (c.id === id ? { ...c, deleted: true, body: null } : c)));
    onUpdated();
  }

  function handleEdited(id: string, body: string) {
    setComments((prev) =>
      prev.map((c) => (c.id === id ? { ...c, body, editedAt: new Date().toISOString() } : c)),
    );
    onUpdated();
  }

  return (
    <div className="flex flex-col gap-2">
      {thread.title && <h4 className="text-sm font-semibold text-foreground">{thread.title}</h4>}
      <div className="flex flex-col gap-2">
        {comments.map((c) => (
          <CommentBubble
            key={c.id}
            comment={c}
            currentUserId={currentUserId}
            onDeleted={handleDeleted}
            onEdited={handleEdited}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-col gap-1">
        <MentionInput
          value={replyBody}
          onChange={setReplyBody}
          placeholder="Reply… Use @username to mention"
          className="min-h-[60px] text-sm"
        />
        <Button size="sm" onClick={handleReply} disabled={replying || !replyBody.trim()}>
          Reply
        </Button>
      </div>
    </div>
  );
}
