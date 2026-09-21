"use client";

/**
 * Phase 10 — admin Skills library page (issue #73 AC).
 *
 * List + search + view + create/edit/delete + version timeline. Source is a
 * YAML-frontmatter Markdown doc; the page surfaces the same shape the
 * server's import flow accepts so admins can paste a skill file from
 * `.github/skills/<name>/SKILL.md` directly.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { skillsApi, type SkillDetail, type SkillSummary } from "@/lib/library-api";
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

export default function AdminSkillsPage() {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SkillSummary | null>(null);
  const [versionsTarget, setVersionsTarget] = useState<SkillSummary | null>(null);

  const filters = useMemo(
    () => ({
      ...(query.trim().length > 0 ? { q: query.trim() } : {}),
      ...(includeArchived ? { includeArchived: "1" as const } : {}),
    }),
    [query, includeArchived],
  );
  const list = useQuery({
    queryKey: queryKeys.skills.list(filters),
    queryFn: () => skillsApi.list(filters),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.skills.all }).catch(() => {});

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
          <p className="text-sm text-muted-foreground">
            Reusable instruction blocks injected into chat sessions. Each save creates an immutable
            version row.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="new-skill">New skill</Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Create skill</DialogTitle>
              <DialogDescription>
                Author a skill as <code>SKILL.md</code> — YAML frontmatter plus a Markdown body that
                becomes the skill instructions.
              </DialogDescription>
            </DialogHeader>
            <SkillForm
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
          aria-label="Search skills"
          placeholder="Search by name, description, or key…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
          data-testid="skills-search"
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
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Tags</th>
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
                  No skills match.
                </td>
              </tr>
            ) : (
              list.data?.items.map((s) => (
                <SkillRow
                  key={s.id}
                  skill={s}
                  onEdit={() => setEditTarget(s)}
                  onVersions={() => setVersionsTarget(s)}
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
            <DialogTitle>Edit skill {editTarget?.key}</DialogTitle>
            <DialogDescription>
              Saving creates a new immutable version of this skill.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <SkillEditLoader
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
            <DialogDescription>Immutable version history for this skill.</DialogDescription>
          </DialogHeader>
          {versionsTarget ? <VersionsTimeline skillId={versionsTarget.id} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SkillRow({
  skill,
  onEdit,
  onVersions,
  onChange,
}: {
  skill: SkillSummary;
  onEdit: () => void;
  onVersions: () => void;
  onChange: () => void;
}) {
  const archive = useMutation({
    mutationFn: () => skillsApi.archive(skill.id),
    onSuccess: onChange,
  });
  const enable = useMutation({
    mutationFn: () => (skill.enabled ? skillsApi.disable(skill.id) : skillsApi.enable(skill.id)),
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () => skillsApi.remove(skill.id),
    onSuccess: onChange,
  });
  return (
    <tr className="border-t">
      <td className="px-4 py-3 font-mono text-xs">{skill.key}</td>
      <td className="px-4 py-3">
        <div className="font-medium">{skill.name}</div>
        <div className="text-xs text-muted-foreground line-clamp-1">{skill.description}</div>
      </td>
      <td className="px-4 py-3">{skill.version}</td>
      <td className="px-4 py-3">
        {skill.tags.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          skill.tags.map((t) => (
            <span key={t} className="mr-1 inline-block rounded bg-muted px-2 py-0.5 text-xs">
              {t}
            </span>
          ))
        )}
      </td>
      <td className="px-4 py-3">
        {skill.archived ? (
          <span className="rounded bg-muted px-2 py-0.5 text-xs">archived</span>
        ) : skill.enabled ? (
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
          {skill.enabled ? "Disable" : "Enable"}
        </Button>
        {!skill.archived ? (
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
            if (window.confirm(`Delete skill ${skill.key}? Versions are kept for audit.`)) {
              remove.mutate();
            }
          }}
        >
          Delete
        </Button>
      </td>
    </tr>
  );
}

const TEMPLATE = `---
name: my-skill
description: A short description shown in the picker.
version: 0.1.0
tags: [example]
---

Body of the skill — Markdown instructions injected as a system block.
`;

function SkillEditLoader({
  id,
  onCancel,
  onSaved,
}: {
  id: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const detail = useQuery({
    queryKey: queryKeys.skills.detail(id),
    queryFn: () => skillsApi.get(id),
  });
  if (detail.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (detail.isError || !detail.data)
    return <p className="text-sm text-destructive">Failed to load skill.</p>;
  return <SkillForm initial={detail.data} onCancel={onCancel} onSaved={onSaved} />;
}

function SkillForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: SkillDetail;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [source, setSource] = useState(() => (initial ? rebuildSource(initial) : TEMPLATE));
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(initial);

  const save = useMutation({
    mutationFn: () => (isEdit ? skillsApi.update(initial!.id, source) : skillsApi.create(source)),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err: unknown) => {
      setError(err instanceof ApiError ? err.message : "Save failed");
    },
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="skill-source">SKILL.md source</Label>
        <textarea
          id="skill-source"
          className="border-input bg-background h-72 w-full rounded-md border p-3 font-mono text-xs"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          data-testid="skill-source"
        />
        <p className="text-xs text-muted-foreground">
          YAML frontmatter (`name`, `description`, `version`, optional `tools`/`tags`/`resources`)
          followed by the Markdown body.
        </p>
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
        <Button type="submit" disabled={save.isPending} data-testid="skill-save">
          {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create"}
        </Button>
      </div>
    </form>
  );
}

function VersionsTimeline({ skillId }: { skillId: string }) {
  const versions = useQuery({
    queryKey: queryKeys.skills.versions(skillId),
    queryFn: () => skillsApi.versions(skillId),
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
 * Reconstruct an editable SKILL.md source from a `SkillDetail`. The server
 * stores the parsed frontmatter as JSON (`manifest`) and the body as
 * `instructions`; we re-emit a canonical YAML frontmatter so the textarea
 * round-trips cleanly through the same parser the API uses on save.
 */
export function rebuildSource(detail: SkillDetail): string {
  const m = detail.manifest as Record<string, unknown>;
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else if (typeof v === "string") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---", "", detail.instructions);
  return lines.join("\n");
}
