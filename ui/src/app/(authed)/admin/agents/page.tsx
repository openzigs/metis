"use client";

/**
 * Phase 10 — admin Agents library page (issue #74 AC).
 *
 * List + search + view + create/edit/delete + version timeline + a
 * default-skill picker (multi-select against the global Skills library).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatLibrarySaveError } from "@/lib/format-agent-save-error";
import { agentsApi, skillsApi, type AgentDetail, type AgentSummary } from "@/lib/library-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function AdminAgentsPage() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AgentSummary | null>(null);
  const [versionsTarget, setVersionsTarget] = useState<AgentSummary | null>(null);

  const filters = useMemo(
    () => ({
      ...(query.trim().length > 0 ? { q: query.trim() } : {}),
      ...(includeArchived ? { includeArchived: "1" as const } : {}),
    }),
    [query, includeArchived],
  );
  const list = useQuery({
    queryKey: queryKeys.agents.list(filters),
    queryFn: () => agentsApi.list(filters),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.agents.all }).catch(() => {});

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground">
            Persona definitions that bind a system prompt + a default skill set to a chat session.
            Tool refs are validated at save time against the live tool registry.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="new-agent">New agent</Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Create agent</DialogTitle>
              <DialogDescription>
                Author an agent as <code>.agent.md</code> — YAML frontmatter plus a Markdown body
                that becomes the system prompt.
              </DialogDescription>
            </DialogHeader>
            <AgentForm
              onCancel={() => setCreateOpen(false)}
              onSaved={() => {
                setCreateOpen(false);
                invalidate();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      <div className="flex items-center gap-3">
        <Input
          aria-label="Search agents"
          placeholder="Search by name, description, or key…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
          data-testid="agents-search"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Include archived
        </label>
      </div>

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Model</th>
              <th className="px-4 py-3">Default skills</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                  Loading…
                </td>
              </tr>
            ) : (list.data?.items ?? []).length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={6}>
                  No agents match.
                </td>
              </tr>
            ) : (
              list.data?.items.map((a) => (
                <AgentRow
                  key={a.id}
                  agent={a}
                  onEdit={() => setEditTarget(a)}
                  onVersions={() => setVersionsTarget(a)}
                  onChange={invalidate}
                />
              ))
            )}
          </tbody>
        </table>
      </Card>

      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit agent {editTarget?.key}</DialogTitle>
            <DialogDescription>
              Saving creates a new immutable version of this agent.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <AgentEditLoader
              id={editTarget.id}
              onCancel={() => setEditTarget(null)}
              onSaved={() => {
                setEditTarget(null);
                invalidate();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={versionsTarget !== null} onOpenChange={(o) => !o && setVersionsTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Versions — {versionsTarget?.key}</DialogTitle>
            <DialogDescription>Immutable version history for this agent.</DialogDescription>
          </DialogHeader>
          {versionsTarget ? <VersionsTimeline agentId={versionsTarget.id} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AgentRow({
  agent,
  onEdit,
  onVersions,
  onChange,
}: {
  agent: AgentSummary;
  onEdit: () => void;
  onVersions: () => void;
  onChange: () => void;
}) {
  const archive = useMutation({
    mutationFn: () => agentsApi.archive(agent.id),
    onSuccess: onChange,
  });
  const enable = useMutation({
    mutationFn: () => (agent.enabled ? agentsApi.disable(agent.id) : agentsApi.enable(agent.id)),
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () => agentsApi.remove(agent.id),
    onSuccess: onChange,
  });
  return (
    <tr className="border-t">
      <td className="px-4 py-3 font-mono text-xs">{agent.key}</td>
      <td className="px-4 py-3">
        <div className="font-medium">{agent.displayName || agent.name}</div>
        <div className="text-xs text-muted-foreground line-clamp-1">{agent.description}</div>
      </td>
      <td className="px-4 py-3">{agent.model || "—"}</td>
      <td className="px-4 py-3">
        {agent.defaultSkillKeys.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          agent.defaultSkillKeys.map((k) => (
            <span
              key={k}
              className="mr-1 inline-block rounded bg-muted px-2 py-0.5 font-mono text-xs"
            >
              {k}
            </span>
          ))
        )}
      </td>
      <td className="px-4 py-3">
        {agent.archived ? (
          <span className="rounded bg-muted px-2 py-0.5 text-xs">archived</span>
        ) : agent.enabled ? (
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-900">enabled</span>
        ) : (
          <span className="rounded bg-yellow-100 px-2 py-0.5 text-xs text-yellow-900">
            disabled
          </span>
        )}
      </td>
      <td className="space-x-2 px-4 py-3 text-right">
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="outline" size="sm" onClick={onVersions}>
          Versions
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={enable.isPending}
          onClick={() => enable.mutate()}
        >
          {agent.enabled ? "Disable" : "Enable"}
        </Button>
        {!agent.archived ? (
          <Button
            variant="outline"
            size="sm"
            disabled={archive.isPending}
            onClick={() => archive.mutate()}
          >
            Archive
          </Button>
        ) : null}
        <Button
          variant="destructive"
          size="sm"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete agent ${agent.key}?`)) remove.mutate();
          }}
        >
          Delete
        </Button>
      </td>
    </tr>
  );
}

const AGENT_TEMPLATE = `---
name: my-agent
displayName: My Agent
description: One-sentence persona summary.
version: 0.1.0
model: gpt
tools: []
---

You are an expert assistant for ...
`;

function AgentEditLoader({
  id,
  onCancel,
  onSaved,
}: {
  id: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const detail = useQuery({
    queryKey: queryKeys.agents.detail(id),
    queryFn: () => agentsApi.get(id),
  });
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (detail.isError || !detail.data)
    return <p className="text-sm text-destructive">Failed to load agent.</p>;
  return <AgentForm initial={detail.data} onCancel={onCancel} onSaved={onSaved} />;
}

function AgentForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: AgentDetail;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const skillsList = useQuery({
    queryKey: queryKeys.skills.list({ pickerOnly: true }),
    queryFn: () => skillsApi.list(),
  });
  const [source, setSource] = useState(() =>
    initial ? rebuildAgentSource(initial) : AGENT_TEMPLATE,
  );
  const [defaultKeys, setDefaultKeys] = useState<string[]>(() => initial?.defaultSkillKeys ?? []);
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(initial);

  const save = useMutation({
    mutationFn: () =>
      isEdit
        ? agentsApi.update(initial!.id, source, defaultKeys)
        : agentsApi.create(source, defaultKeys),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err: unknown) => {
      setError(formatLibrarySaveError(err));
    },
  });

  const toggleSkill = (key: string) =>
    setDefaultKeys((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="agent-source">.agent.md source</Label>
        <textarea
          id="agent-source"
          className="border-input bg-background h-64 w-full rounded-md border p-3 font-mono text-xs"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          data-testid="agent-source"
        />
        <p className="text-xs text-muted-foreground">
          YAML frontmatter (`name`, optional `description`/`model`/`tools`/`tags`/`handoffs`)
          followed by the Markdown body that becomes the agent&apos;s system prompt.
        </p>
      </div>
      <div className="space-y-2">
        <Label>Default skills (auto-loaded into every session under this agent)</Label>
        <div
          className="max-h-40 overflow-y-auto rounded border p-2"
          data-testid="agent-skill-picker"
        >
          {skillsList.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading skills…</p>
          ) : (skillsList.data?.items ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No skills available.</p>
          ) : (
            (skillsList.data?.items ?? [])
              .filter((s) => s.enabled && !s.archived)
              .map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 rounded p-1 text-sm hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={defaultKeys.includes(s.key)}
                    onChange={() => toggleSkill(s.key)}
                    data-testid={`agent-skill-${s.key}`}
                  />
                  <span className="font-mono text-xs">{s.key}</span>
                  <span className="text-xs text-muted-foreground">— {s.name}</span>
                </label>
              ))
          )}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending} data-testid="agent-save">
          {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create"}
        </Button>
      </div>
    </form>
  );
}

function VersionsTimeline({ agentId }: { agentId: string }) {
  const versions = useQuery({
    queryKey: queryKeys.agents.versions(agentId),
    queryFn: () => agentsApi.versions(agentId),
  });
  if (versions.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const items = versions.data?.items ?? [];
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No versions yet.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {items.map((v) => (
        <li key={v.id} className="flex items-center justify-between rounded border p-2">
          <div>
            <div className="font-medium">v{v.version}</div>
            <div className="text-xs text-muted-foreground">
              {new Date(v.createdAt).toLocaleString()}
            </div>
          </div>
          <code className="text-xs text-muted-foreground">
            sha256:{v.contentSha256.slice(0, 12)}…
          </code>
        </li>
      ))}
    </ol>
  );
}

/**
 * Same idea as `rebuildSource` for skills — re-emit a canonical YAML
 * frontmatter from the persisted manifest so the textarea round-trips
 * through the server's parser without mutating the contentSha256.
 */
export function rebuildAgentSource(detail: AgentDetail): string {
  const m = detail.manifest as Record<string, unknown>;
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "", detail.systemPrompt);
  return lines.join("\n");
}
