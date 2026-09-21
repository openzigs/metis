/**
 * Phase 12 — Library "Browse" tab.
 *
 * Lifted out of the original `library/page.tsx` so the new tabbed
 * container can host it alongside Templates and Artifacts. Filters
 * (kind/tag) and per-project toggles preserved.
 */
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { libraryApi, type LibrarySearchHit } from "@/lib/library-api";
import { queryKeys } from "@/lib/query-keys";
import { useAuth } from "@/lib/auth-context";
import { ProjectSkillAllowlistToggle } from "@/components/library/project-skill-allowlist-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SkeletonText } from "@/components/ui/skeleton";

interface Props {
  projectId: string | null;
}

export function LibraryBrowseSection({ projectId }: Props) {
  const { user } = useAuth();
  const canManage = user?.permissions.includes("project.update") ?? false;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "skill" | "agent">("all");
  const [tag, setTag] = useState("");

  const filters = useMemo(
    () => ({
      ...(query.trim().length > 0 ? { q: query.trim() } : {}),
      ...(kind !== "all" ? { kind } : {}),
      ...(tag.trim().length > 0 ? { tag: tag.trim() } : {}),
    }),
    [query, kind, tag],
  );
  const search = useQuery({
    queryKey: queryKeys.library.search(filters),
    queryFn: () => libraryApi.search(filters),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search library"
          placeholder="Search by name, description, or tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-md"
          data-testid="library-search"
        />
        <Input
          aria-label="Filter by tag"
          placeholder="Tag"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          className="max-w-[10rem]"
          data-testid="library-filter-tag"
        />
        <div className="flex items-center gap-1 text-sm">
          {(["all", "skill", "agent"] as const).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={kind === k ? "default" : "outline"}
              onClick={() => setKind(k)}
              data-testid={`library-filter-${k}`}
            >
              {k === "all" ? "All" : k === "skill" ? "Skills" : "Agents"}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-3">
        {search.isLoading ? (
          <SkeletonText lines={3} />
        ) : (search.data?.items ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches.</p>
        ) : (
          search.data?.items.map((hit) => (
            <LibraryHitCard
              key={`${hit.kind}:${hit.id}`}
              hit={hit}
              projectId={projectId}
              canManage={canManage}
            />
          ))
        )}
      </div>
    </div>
  );
}

function LibraryHitCard({
  hit,
  projectId,
  canManage,
}: {
  hit: LibrarySearchHit;
  projectId: string | null;
  canManage: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={
                hit.kind === "skill"
                  ? "rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-900"
                  : "rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-900"
              }
            >
              {hit.kind}
            </span>
            <h3 className="font-medium">{hit.name}</h3>
            <code className="text-xs text-muted-foreground">{hit.key}</code>
          </div>
          <p className="text-sm text-muted-foreground">{hit.description}</p>
          {hit.tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {hit.tags.map((t) => (
                <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {projectId ? (
          hit.kind === "skill" ? (
            <ProjectSkillAllowlistToggle
              projectId={projectId}
              skillId={hit.id}
              canManage={canManage}
            />
          ) : (
            <ProjectToggle projectId={projectId} hit={hit} />
          )
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Per-project AGENT toggle. Skills now use {@link ProjectSkillAllowlistToggle}
 * (the #469 default-allow-aware variant); this simpler explicit-row toggle is
 * retained unchanged for agents, which are out of scope for #469.
 */
function ProjectToggle({ projectId, hit }: { projectId: string; hit: LibrarySearchHit }) {
  const qc = useQueryClient();
  const agentsQuery = useQuery({
    queryKey: queryKeys.library.projectAgents(projectId),
    queryFn: () => libraryApi.projectAgents(projectId),
  });

  const entry = agentsQuery.data?.items.find((e) => e.agentId === hit.id);
  const enabled = entry?.enabled === true;

  const toggle = useMutation({
    mutationFn: () => libraryApi.setProjectAgent(projectId, hit.id, !enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.library.projectAgents(projectId) });
    },
  });

  return (
    <Button
      size="sm"
      variant={enabled ? "default" : "outline"}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
      data-testid={`project-toggle-${hit.kind}-${hit.id}`}
    >
      {enabled ? "Enabled" : "Enable"}
    </Button>
  );
}
