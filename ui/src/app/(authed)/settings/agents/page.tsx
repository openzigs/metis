/**
 * Settings → Custom Agents (#112). Manage user/project-scoped subagents.
 * Built-ins are read-only.
 */
"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonText } from "@/components/ui/skeleton";
import { sdkApi, type CreateCustomAgentInput } from "@/lib/sdk-alignment-api";
import type { CustomAgentDto } from "@metis/shared";

const QK = ["custom-agents"];

export default function AgentsSettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: QK,
    queryFn: () => sdkApi.listAgents(),
  });

  const [draft, setDraft] = useState<CreateCustomAgentInput>({
    projectId: "",
    name: "",
    description: "",
    systemPrompt: "",
    tools: [],
  });

  const create = useMutation({
    mutationFn: () => sdkApi.createAgent(draft),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK });
      setDraft({ projectId: "", name: "", description: "", systemPrompt: "", tools: [] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => sdkApi.deleteAgent(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK }),
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="custom-agents-root">
      <header>
        <h1 className="text-2xl font-semibold">Custom Agents</h1>
        <p className="text-sm text-muted-foreground">
          Built-in specialists are read-only. Add project-scoped agents to tailor behavior.
        </p>
      </header>

      <Card className="p-4 space-y-3" data-testid="custom-agents-create">
        <h2 className="text-lg font-medium">Add agent</h2>
        <Input
          placeholder="Project ID"
          value={draft.projectId}
          onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}
          data-testid="ca-project-id"
        />
        <Input
          placeholder="Name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          data-testid="ca-name"
        />
        <Input
          placeholder="Description"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          data-testid="ca-description"
        />
        <textarea
          className="w-full min-h-[80px] rounded-md border bg-background p-2 text-sm"
          placeholder="System prompt"
          value={draft.systemPrompt}
          onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
          data-testid="ca-system-prompt"
        />
        <Button
          onClick={() => create.mutate()}
          disabled={!draft.projectId || !draft.name || !draft.systemPrompt || create.isPending}
          data-testid="ca-save"
        >
          {create.isPending ? "Saving…" : "Save agent"}
        </Button>
      </Card>

      <Card className="p-4" data-testid="custom-agents-list">
        <h2 className="text-lg font-medium mb-3">Agents</h2>
        {isLoading ? (
          <SkeletonText lines={3} />
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.map((a: CustomAgentDto) => (
              <li
                key={a.id}
                className="flex items-center justify-between rounded-md border p-2"
                data-testid={`ca-row-${a.id}`}
              >
                <div>
                  <div className="font-medium">
                    {a.name}{" "}
                    {a.isBuiltIn && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">built-in</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{a.description || "—"}</div>
                </div>
                {!a.isBuiltIn && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => remove.mutate(a.id)}
                    data-testid={`ca-delete-${a.id}`}
                  >
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
