/**
 * Settings → Triggers (#147).
 *
 * CRUD over `/api/projects/:projectId/triggers` plus a "Test fire" affordance
 * that POSTs an HMAC-signed payload to `/api/triggers/:id/fire`.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonText } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api-client";
import { asyncApi, type TriggerDto } from "@/lib/async-platform-api";

const SOURCES: TriggerDto["source"][] = ["webhook", "github", "slack", "cron"];

interface AccessibleProject {
  id: string;
  name: string;
}

/**
 * Searchable single-select project picker. Reuses the `/search/projects`
 * endpoint that backs the chat page's ProjectScopeSelector, so we don't ask
 * the user to paste a raw Project ID.
 */
function ProjectPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["search", "accessible-projects"],
    queryFn: () => apiFetch<AccessibleProject[]>("/search/projects"),
  });

  useEffect(() => {
    if (!open) return;
    function handleMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  const selected = projects.find((p) => p.id === value);
  const label = selected ? selected.name : value || "Select a project";
  const visible = filter.trim()
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(filter.toLowerCase()) ||
          p.id.toLowerCase().includes(filter.toLowerCase()),
      )
    : projects;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label="Project"
        data-testid="tg-project-id"
        className="flex w-full items-center justify-between rounded-md border bg-background px-3 py-2 text-left text-sm disabled:opacity-50"
        onClick={() => setOpen((o) => !o)}
        disabled={isLoading}
      >
        <span className={selected ? "" : "text-muted-foreground"}>{label}</span>
        <span className="ml-2 text-muted-foreground">▾</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border bg-popover p-2 shadow-md"
          role="listbox"
          aria-label="Select a project"
        >
          <Input
            autoFocus
            placeholder="Search projects…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="tg-project-search"
          />
          <div className="mt-2 max-h-48 overflow-y-auto">
            {visible.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={p.id === value}
                className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
                  p.id === value ? "bg-accent font-medium" : ""
                }`}
                data-testid={`tg-project-option-${p.id}`}
                onClick={() => {
                  onChange(p.id);
                  setOpen(false);
                  setFilter("");
                }}
              >
                {p.name}
              </button>
            ))}
            {visible.length === 0 && !isLoading && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No projects found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function parseConfig(raw: TriggerDto["config"]): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

export default function TriggersSettingsPage() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState<TriggerDto["source"]>("webhook");
  const [secret, setSecret] = useState("");
  const [extraConfig, setExtraConfig] = useState("");

  const qk = ["triggers", projectId];
  const list = useQuery({
    queryKey: qk,
    queryFn: () => asyncApi.listTriggers(projectId),
    enabled: !!projectId,
  });

  const create = useMutation({
    mutationFn: () => {
      let extra: Record<string, unknown> = {};
      if (extraConfig.trim()) {
        try {
          extra = JSON.parse(extraConfig) as Record<string, unknown>;
        } catch {
          throw new Error("Invalid JSON in config");
        }
      }
      return asyncApi.createTrigger(projectId, {
        name,
        source,
        config: { ...(secret ? { secret } : {}), ...extra },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk });
      setName("");
      setSecret("");
      setExtraConfig("");
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      asyncApi.updateTrigger(projectId, id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => asyncApi.deleteTrigger(projectId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk }),
  });

  return (
    <div className="space-y-4 p-2 md:p-0">
      <h1 className="text-xl font-semibold">Triggers</h1>
      <Card className="space-y-3 p-4">
        <ProjectPicker value={projectId} onChange={setProjectId} />
        {projectId && (
          <>
            <Input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="tg-name"
            />
            <select
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={source}
              onChange={(e) => setSource(e.target.value as TriggerDto["source"])}
              data-testid="tg-source"
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Input
              placeholder="Shared secret (HMAC)"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              data-testid="tg-secret"
            />
            <textarea
              placeholder='Extra config JSON (e.g. {"repo":"acme/app","event":"issues.opened"})'
              className="h-20 w-full rounded-md border bg-background p-2 font-mono text-xs"
              value={extraConfig}
              onChange={(e) => setExtraConfig(e.target.value)}
              data-testid="tg-config"
            />
            <Button
              onClick={() => create.mutate()}
              disabled={!name || create.isPending}
              data-testid="tg-save"
            >
              {create.isPending ? "Saving…" : "Add trigger"}
            </Button>
          </>
        )}
      </Card>

      {projectId && (
        <Card className="p-4" data-testid="triggers-list">
          <h2 className="mb-3 text-lg font-medium">Triggers</h2>
          {list.isLoading ? (
            <SkeletonText lines={3} />
          ) : list.isError ? (
            <div className="text-sm text-red-600" data-testid="tg-error">
              Failed to load triggers: {(list.error as Error).message}
              <Button
                size="sm"
                variant="outline"
                className="ml-3"
                onClick={() => list.refetch()}
                data-testid="tg-retry"
              >
                Retry
              </Button>
            </div>
          ) : !list.data || list.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No triggers.</p>
          ) : (
            <ul className="space-y-2">
              {list.data.items.map((t) => {
                const cfg = parseConfig(t.config);
                return (
                  <li
                    key={t.id}
                    className="flex items-center justify-between rounded-md border p-2"
                    data-testid={`tg-row-${t.id}`}
                  >
                    <div className="text-sm">
                      <span className="font-mono">{t.source}</span> · {t.name}
                      {cfg.repo ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          repo={String(cfg.repo)}
                        </span>
                      ) : null}
                      {!t.enabled && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                          disabled
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggle.mutate({ id: t.id, enabled: !t.enabled })}
                        data-testid={`tg-toggle-${t.id}`}
                      >
                        {t.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => remove.mutate(t.id)}
                        data-testid={`tg-delete-${t.id}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
