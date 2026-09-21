/**
 * Sessions page (#122). Lists resumable AI sessions and lets the user resume.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import { sdkApi } from "@/lib/sdk-alignment-api";

const QK = ["resumable-sessions"];

export default function SessionsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data, isLoading } = useQuery({ queryKey: QK, queryFn: () => sdkApi.listResumable() });

  // #1367 — Resume used to rehydrate server-side and then just invalidate the
  // list, leaving the user on this page with nothing visibly resumed. Send them
  // to Chat with the session id so the transcript is actually restored.
  const resume = useMutation({
    mutationFn: (id: string) => sdkApi.resumeSession(id),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: QK });
      router.push(`/chat?sessionId=${encodeURIComponent(id)}`);
    },
  });

  return (
    <div className="space-y-4 p-2 md:p-0" data-testid="sessions-root">
      <header>
        <h1 className="text-2xl font-semibold">Sessions</h1>
        <p className="text-sm text-muted-foreground">
          Resume a session within 24 hours of its last activity.
        </p>
      </header>

      <Card className="p-4">
        {isLoading ? (
          <SkeletonText lines={3} />
        ) : !data || data.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 py-8 text-center"
            data-testid="sessions-empty"
          >
            <p className="text-sm font-medium">No resumable sessions</p>
            <p className="max-w-md text-sm text-muted-foreground">
              Resumable sessions are recent chats from the last 24 hours. Start a conversation in
              Chat and it will show up here so you can pick up where you left off.
            </p>
            <Button asChild size="sm" className="mt-1">
              <Link href="/chat" data-testid="sessions-empty-cta">
                Start a chat
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {data.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between rounded-md border p-2"
                data-testid={`sess-row-${s.id}`}
              >
                <div>
                  <div className="font-medium">{s.title || s.id}</div>
                  <div className="text-xs text-muted-foreground">
                    {s.currentModel || s.model}
                    {s.planModeActive && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                        plan-mode
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => resume.mutate(s.id)}
                  disabled={resume.isPending}
                  data-testid={`sess-resume-${s.id}`}
                >
                  Resume
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
