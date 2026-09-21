/**
 * Settings → Hooks (#114). Manage webhook subscriptions per project.
 */
"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonText } from "@/components/ui/skeleton";
import { sdkApi } from "@/lib/sdk-alignment-api";
import { SDK_HOOK_EVENTS, type SdkHookEvent } from "@metis/shared";

export default function HooksSettingsPage() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const qk = ["hooks", projectId];

  const list = useQuery({
    queryKey: qk,
    queryFn: () => sdkApi.listHooks(projectId),
    enabled: !!projectId,
  });

  const [event, setEvent] = useState<SdkHookEvent>("preToolUse");
  const [url, setUrl] = useState("");

  const create = useMutation({
    mutationFn: () =>
      sdkApi.createHook(projectId, {
        event,
        handlerKind: "webhook",
        config: { url },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk });
      setUrl("");
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      sdkApi.updateHook(projectId, id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => sdkApi.deleteHook(projectId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk }),
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="hooks-root">
      <header>
        <h1 className="text-2xl font-semibold">Hooks</h1>
        <p className="text-sm text-muted-foreground">
          Subscribe webhooks to copilot lifecycle events. Imported hooks start disabled.
        </p>
      </header>

      <Card className="p-4 space-y-3">
        <Input
          placeholder="Project ID"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          data-testid="hk-project-id"
        />
        {projectId && (
          <>
            <select
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={event}
              onChange={(e) => setEvent(e.target.value as SdkHookEvent)}
              data-testid="hk-event"
            >
              {SDK_HOOK_EVENTS.map((evt) => (
                <option key={evt} value={evt}>
                  {evt}
                </option>
              ))}
            </select>
            <Input
              placeholder="https://example.com/hook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              data-testid="hk-url"
            />
            <Button
              onClick={() => create.mutate()}
              disabled={!url.startsWith("https://") || create.isPending}
              data-testid="hk-save"
            >
              {create.isPending ? "Saving…" : "Add webhook"}
            </Button>
          </>
        )}
      </Card>

      {projectId && (
        <Card className="p-4" data-testid="hooks-list">
          <h2 className="text-lg font-medium mb-3">Subscriptions</h2>
          {list.isLoading ? (
            <SkeletonText lines={3} />
          ) : !list.data || list.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No subscriptions.</p>
          ) : (
            <ul className="space-y-2">
              {list.data.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center justify-between rounded-md border p-2"
                  data-testid={`hk-row-${h.id}`}
                >
                  <div className="text-sm">
                    <span className="font-mono">{h.event}</span> →{" "}
                    <span className="text-muted-foreground">
                      {(h.config.url as string) ?? "(builtin)"}
                    </span>{" "}
                    {!h.enabled && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">disabled</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggle.mutate({ id: h.id, enabled: !h.enabled })}
                      data-testid={`hk-toggle-${h.id}`}
                    >
                      {h.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => remove.mutate(h.id)}
                      data-testid={`hk-delete-${h.id}`}
                    >
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
