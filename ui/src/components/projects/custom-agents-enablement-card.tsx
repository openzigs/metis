"use client";

/**
 * Epic #260 / Issue #85 — per-project custom-agent enablement toggle.
 *
 * Lists every custom agent that could participate in this project (built-in
 * specialists shared across the workspace plus agents owned by this project)
 * and lets a workspace admin enable/disable each for the project. Toggling
 * PUTs `/api/custom-agents/:id/enablement` and refetches the enabled set so
 * the UI live-updates (AC).
 *
 * #145 — an agent this project OWNS can be edited here (persona, skills,
 * tools, model, approval override) in a dialog; built-ins and agents shared
 * from elsewhere are not editable from a project.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import { sdkApi } from "@/lib/sdk-alignment-api";
import type { CustomAgentDto } from "@metis/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CustomAgentEditForm } from "@/components/custom-agents/CustomAgentEditForm";

interface Props {
  projectId: string;
}

const candidatesKey = (projectId: string) => ["custom-agents", "candidates", projectId] as const;
const enabledKey = (projectId: string) => ["custom-agents", "enabled", projectId] as const;

export function CustomAgentsEnablementCard({ projectId }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CustomAgentDto | null>(null);

  // Candidate agents: built-ins (shared) + this project's own agents.
  const candidates = useQuery({
    queryKey: candidatesKey(projectId),
    queryFn: () => sdkApi.listAgents(projectId, true),
    enabled: Boolean(projectId),
  });

  // Agents currently enabled for this project.
  const enabled = useQuery({
    queryKey: enabledKey(projectId),
    queryFn: () => sdkApi.listEnabledAgents(projectId),
    enabled: Boolean(projectId),
  });

  const toggle = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) =>
      sdkApi.setAgentEnablement(id, { projectId, enabled: next }),
    onSuccess: () => {
      // Refetch the enabled set so the row labels live-update (AC).
      qc.invalidateQueries({ queryKey: enabledKey(projectId) });
    },
  });

  const isLoading = candidates.isLoading || enabled.isLoading;
  const isError = candidates.isError || enabled.isError;

  const enabledIds = new Set((enabled.data ?? []).map((a: CustomAgentDto) => a.id));
  const rows = candidates.data ?? [];

  return (
    <Card className="space-y-3 p-4" data-testid="custom-agents-enablement-card">
      <div>
        <h3 className="text-base font-semibold">Custom agents</h3>
        <p className="text-xs text-muted-foreground">
          Enable analyst agents to participate in this project&apos;s analysis runs.
        </p>
      </div>

      {isLoading ? (
        <SkeletonText lines={3} />
      ) : isError ? (
        <p
          className="text-sm text-destructive"
          role="alert"
          data-testid="custom-agents-enablement-error"
        >
          Failed to load custom agents.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="custom-agents-enablement-empty">
          No custom agents available. Create one from the workspace agent wizard.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((agent: CustomAgentDto) => {
            const on = enabledIds.has(agent.id);
            const pendingThis = toggle.isPending && toggle.variables?.id === agent.id;
            return (
              <li
                key={agent.id}
                className="flex items-center justify-between rounded-md border p-2"
                data-testid={`ca-enablement-row-${agent.id}`}
              >
                <div>
                  <div className="text-sm font-medium">
                    {agent.name}
                    {agent.isBuiltIn && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">built-in</span>
                    )}
                  </div>
                  {agent.description && (
                    <div className="text-xs text-muted-foreground">{agent.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {!agent.isBuiltIn && agent.projectId === projectId && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(agent)}
                      data-testid={`ca-edit-open-${agent.id}`}
                    >
                      Edit
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant={on ? "outline" : "default"}
                    aria-pressed={on}
                    disabled={pendingThis}
                    onClick={() => toggle.mutate({ id: agent.id, next: !on })}
                    data-testid={`ca-enablement-toggle-${agent.id}`}
                  >
                    {pendingThis ? "Saving…" : on ? "Disable" : "Enable"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit agent {editing?.name}</DialogTitle>
            <DialogDescription>
              Persona, skills, tools, model and approval — the agent&apos;s one definition.
            </DialogDescription>
          </DialogHeader>
          {editing ? (
            <CustomAgentEditForm
              agent={editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                qc.invalidateQueries({ queryKey: candidatesKey(projectId) });
                qc.invalidateQueries({ queryKey: enabledKey(projectId) });
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
