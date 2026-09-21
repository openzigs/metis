"use client";

/**
 * Epic #728 / Issue #736 — PresenceAvatars component.
 *
 * Subscribes to `presence:update` socket events for a given artifact
 * room and renders up to 5 user avatars + overflow badge.
 */
import { useEffect, useState } from "react";
import { useSocket } from "@/lib/socket-client";
import { cn } from "@/lib/utils";

interface PresenceUser {
  userId: string;
  username: string;
}

/**
 * Mirrors the server's `presence:update` payload exactly
 * (see `server/src/lib/collaboration/presence.ts`). The server keys updates by
 * room (`presence:{artifactType}:{artifactId}`) and does NOT echo back the
 * artifactType/artifactId fields — clients must match on `room`.
 */
interface PresenceUpdate {
  room: string;
  users: PresenceUser[];
  ts: number;
}

interface PresenceAvatarsProps {
  artifactType: string;
  artifactId: string;
  /** Max visible avatars before showing "+N". Default 5. */
  maxVisible?: number;
  className?: string;
}

function getColor(username: string): string {
  const colors = [
    "bg-violet-600",
    "bg-indigo-600",
    "bg-sky-600",
    "bg-emerald-600",
    "bg-amber-600",
    "bg-rose-600",
    "bg-pink-600",
    "bg-teal-600",
  ];
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash * 31 + username.charCodeAt(i)) & 0xffffffff;
  }
  return colors[Math.abs(hash) % colors.length];
}

export function PresenceAvatars({
  artifactType,
  artifactId,
  maxVisible = 5,
  className,
}: PresenceAvatarsProps) {
  const socket = useSocket();
  const [presentUsers, setPresentUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    if (!socket) return;
    // Join our presence room. The server derives the room key from these two
    // fields as `presence:{artifactType}:{artifactId}`.
    socket.emit("presence:join", { artifactType, artifactId });

    // The server broadcasts `presence:update` keyed by `room` (it does not echo
    // artifactType/artifactId), so match on the room key we expect for this
    // artifact instead of the absent identity fields.
    const expectedRoom = `presence:${artifactType}:${artifactId}`;

    function handleUpdate(update: PresenceUpdate) {
      if (update.room === expectedRoom) {
        setPresentUsers(update.users);
      }
    }
    socket.on("presence:update", handleUpdate);

    return () => {
      socket.emit("presence:leave", { artifactType, artifactId });
      socket.off("presence:update", handleUpdate);
    };
  }, [socket, artifactType, artifactId]);

  if (presentUsers.length === 0) return null;

  // Issue #418 — the presence payload carries one entry per live CONNECTION, so
  // the same `userId` can appear more than once (e.g. a user with two tabs).
  // Keying avatars by `userId` collided and produced React duplicate-key
  // warnings. Decision: render one avatar per DISTINCT user (a person viewing
  // from two tabs is still one viewer), and use the user id as the React key —
  // which is now guaranteed unique because the list is de-duplicated. The
  // payload has no per-connection socketId to key on, so de-duplication is the
  // least-risky way to keep keys stable AND make the "N user(s) viewing" count
  // reflect distinct people rather than raw socket connections.
  const distinctUsers: PresenceUser[] = [];
  const seen = new Set<string>();
  for (const u of presentUsers) {
    if (seen.has(u.userId)) continue;
    seen.add(u.userId);
    distinctUsers.push(u);
  }

  const visible = distinctUsers.slice(0, maxVisible);
  const overflow = distinctUsers.length - maxVisible;

  return (
    <div
      className={cn("flex items-center -space-x-1", className)}
      aria-label={`${distinctUsers.length} user(s) viewing`}
    >
      {visible.map((u) => (
        <div
          key={u.userId}
          title={u.username}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-background",
            getColor(u.username),
          )}
          aria-label={u.username}
        >
          {u.username.slice(0, 2).toUpperCase()}
        </div>
      ))}
      {overflow > 0 && (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs font-semibold ring-2 ring-background">
          +{overflow}
        </div>
      )}
    </div>
  );
}
