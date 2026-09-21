"use client";

/**
 * GitHub Projects v2 settings card (Epic #163, Issue #108).
 *
 * - Picks a board from the org's visible Projects v2 boards (server side
 *   resolves the PAT from the vault by `secretRef`, never touches the
 *   browser).
 * - Lets the operator paste field IDs for Status / Phase / Story Points
 *   so the publisher can call `updateProjectV2ItemFieldValue` per issue.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import {
  projectsV2Api,
  type ProjectV2FieldMapping,
  type ProjectsV2Board,
} from "@/lib/enterprise-api";

const FIELD_KEYS = ["Status", "Phase", "Story Points"] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

export interface ProjectsV2SettingsCardProps {
  projectId: string;
}

export function ProjectsV2SettingsCard({ projectId }: ProjectsV2SettingsCardProps) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["projects-v2-settings", projectId],
    queryFn: () => projectsV2Api.getSettings(projectId),
  });
  const [boardId, setBoardId] = useState<string | null>(null);
  const [secretRef, setSecretRef] = useState("");
  const [targetOwner, setTargetOwner] = useState("");
  const [targetBaseUrl, setTargetBaseUrl] = useState("");
  const [boards, setBoards] = useState<ProjectsV2Board[]>([]);
  const [fields, setFields] = useState<Record<FieldKey, ProjectV2FieldMapping>>({
    Status: { fieldId: "", type: "single_select", value: "" },
    Phase: { fieldId: "", type: "single_select", value: "" },
    "Story Points": { fieldId: "", type: "number", value: 0 },
  });

  useEffect(() => {
    if (settings.data) {
      setBoardId(settings.data.githubProjectId);
      const m = settings.data.fieldMappings || {};
      setFields((prev) => ({
        Status: m.Status ?? prev.Status,
        Phase: m.Phase ?? prev.Phase,
        "Story Points": m["Story Points"] ?? prev["Story Points"],
      }));
    }
  }, [settings.data]);

  const fetchBoards = useMutation({
    mutationFn: () =>
      projectsV2Api.listBoards(projectId, {
        secretRef,
        targetOwner,
        targetBaseUrl: targetBaseUrl || null,
      }),
    onSuccess: (data) => setBoards(data),
  });

  const save = useMutation({
    mutationFn: () =>
      projectsV2Api.updateSettings(projectId, {
        githubProjectId: boardId,
        fieldMappings: fields,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects-v2-settings", projectId] }),
  });

  return (
    <Card className="space-y-3 p-4" data-testid="projects-v2-settings-card">
      <header>
        <h2 className="text-sm font-semibold">GitHub Projects v2</h2>
        <p className="text-xs text-muted-foreground">
          Issues created during publish will be added to this board, with the listed field IDs
          populated via GraphQL.
        </p>
      </header>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label htmlFor="pv2-secret">Vault secret ref</Label>
          <Input
            id="pv2-secret"
            data-testid="pv2-secret"
            value={secretRef}
            onChange={(e) => setSecretRef(e.target.value)}
            placeholder="vault:gh-publish-token"
          />
        </div>
        <div>
          <Label htmlFor="pv2-owner">Target owner</Label>
          <Input
            id="pv2-owner"
            data-testid="pv2-owner"
            value={targetOwner}
            onChange={(e) => setTargetOwner(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="pv2-base-url">GHE base URL (optional)</Label>
          <Input
            id="pv2-base-url"
            data-testid="pv2-base-url"
            value={targetBaseUrl}
            onChange={(e) => setTargetBaseUrl(e.target.value)}
          />
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        data-testid="pv2-load-boards"
        disabled={!secretRef || !targetOwner || fetchBoards.isPending}
        onClick={() => fetchBoards.mutate()}
      >
        {fetchBoards.isPending ? "Loading boards…" : "Load boards"}
      </Button>
      {fetchBoards.error && (
        <p className="text-xs text-red-600" data-testid="pv2-error">
          {fetchBoards.error instanceof ApiError
            ? fetchBoards.error.message
            : String(fetchBoards.error)}
        </p>
      )}

      {boards.length > 0 && (
        <div>
          <Label htmlFor="pv2-board">Board</Label>
          <select
            id="pv2-board"
            data-testid="pv2-board-select"
            className="block w-full rounded border bg-background px-2 py-1 text-sm"
            value={boardId ?? ""}
            onChange={(e) => setBoardId(e.target.value || null)}
          >
            <option value="">— None —</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                #{b.number} {b.title}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">Field mappings</h3>
        {FIELD_KEYS.map((key) => {
          const m = fields[key];
          return (
            <div key={key} className="grid grid-cols-3 gap-2">
              <div>
                <Label htmlFor={`pv2-${key}-id`}>{key} field id</Label>
                <Input
                  id={`pv2-${key}-id`}
                  data-testid={`pv2-${key.replace(/\s+/g, "-").toLowerCase()}-id`}
                  value={m.fieldId}
                  onChange={(e) =>
                    setFields((prev) => ({
                      ...prev,
                      [key]: { ...prev[key], fieldId: e.target.value },
                    }))
                  }
                  placeholder="PVTF_lAH..."
                />
              </div>
              <div>
                <Label htmlFor={`pv2-${key}-type`}>Type</Label>
                <select
                  id={`pv2-${key}-type`}
                  className="block w-full rounded border bg-background px-2 py-1 text-sm"
                  value={m.type}
                  onChange={(e) =>
                    setFields((prev) => ({
                      ...prev,
                      [key]: {
                        ...prev[key],
                        type: e.target.value as ProjectV2FieldMapping["type"],
                      },
                    }))
                  }
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="date">date</option>
                  <option value="single_select">single_select</option>
                </select>
              </div>
              <div>
                <Label htmlFor={`pv2-${key}-value`}>Value / option id</Label>
                <Input
                  id={`pv2-${key}-value`}
                  value={String(m.value)}
                  onChange={(e) =>
                    setFields((prev) => ({
                      ...prev,
                      [key]: {
                        ...prev[key],
                        value:
                          prev[key].type === "number"
                            ? Number(e.target.value || 0)
                            : e.target.value,
                      },
                    }))
                  }
                />
              </div>
            </div>
          );
        })}
      </div>

      <Button
        size="sm"
        data-testid="pv2-save"
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? "Saving…" : "Save Projects v2 settings"}
      </Button>
      {save.isSuccess && <span className="ml-2 text-xs text-emerald-600">Saved.</span>}
    </Card>
  );
}
