/**
 * Phase 12 — chat-time skill loader (deferred from #140 / Phase 10).
 *
 * Lists library skills allowed for the active session's project, lets the
 * user load one with a single click, and shows the order in which skills
 * were already injected into the session's system-message stack.
 *
 * Server-side enforcement of the per-project allow-list (PROJECT_SKILL_NOT_ALLOWED
 * → 403) lives in the existing route — the UI only surfaces what the
 * server returns and posts the load action against the same endpoint.
 */
"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { libraryApi, type ProjectAvailableSkill } from "@/lib/library-api";
import { queryKeys } from "@/lib/query-keys";
import { phase12QueryKeys } from "@/lib/phase12-query-keys";

interface LoadedSkill {
  id: string;
  key: string;
  name: string;
  description: string;
  loadedAt: string;
}

interface LoadedSkillsResponse {
  items: LoadedSkill[];
}

interface LoadSkillResponse {
  alreadyLoaded: boolean;
  loadedSkillIds: string[];
  skill: LoadedSkill;
}

const sessionSkillsApi = {
  list: (sessionId: string) => apiFetch<LoadedSkillsResponse>(`/ai/sessions/${sessionId}/skills`),
  load: (sessionId: string, skillId: string) =>
    apiFetch<LoadSkillResponse>(`/ai/sessions/${sessionId}/skills`, {
      method: "POST",
      body: { skillId },
    }),
};

interface Props {
  sessionId: string | null;
  projectId: string | null;
  /** When true, render as a side panel; otherwise inline (e.g. workbench). */
  variant?: "panel" | "inline";
}

export function LoadedSkillsPanel({ sessionId, projectId, variant = "panel" }: Props) {
  const qc = useQueryClient();
  // The chat picker must reflect the runtime gate (default-allow all enabled
  // skills when a project has no explicit allowlist rows), NOT the raw explicit
  // allowlist — otherwise authored skills look unavailable even though the
  // session runtime would allow them (#468).
  const available = useQuery({
    queryKey: queryKeys.library.projectAvailableSkills(projectId ?? "_none"),
    queryFn: () => libraryApi.projectAvailableSkills(projectId ?? ""),
    enabled: Boolean(projectId),
  });
  const loaded = useQuery({
    queryKey: phase12QueryKeys.loadedSkills(sessionId ?? "_none"),
    queryFn: () => sessionSkillsApi.list(sessionId ?? ""),
    enabled: Boolean(sessionId),
  });
  const load = useMutation({
    mutationFn: (skillId: string) => sessionSkillsApi.load(sessionId ?? "", skillId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: phase12QueryKeys.loadedSkills(sessionId ?? "_none") });
    },
  });
  const pendingSkillId = load.isPending ? (load.variables ?? null) : null;

  const loadedById = useMemo(() => {
    const map = new Map<string, LoadedSkill>();
    for (const s of loaded.data?.items ?? []) map.set(s.id, s);
    return map;
  }, [loaded.data]);

  const allowed: ProjectAvailableSkill[] = useMemo(
    () => available.data?.items ?? [],
    [available.data],
  );

  const containerClass =
    variant === "panel"
      ? "flex flex-col gap-3 rounded-lg border bg-card p-3 text-sm"
      : "flex flex-col gap-3";

  return (
    <section
      aria-label="Session skills"
      data-testid="loaded-skills-panel"
      className={containerClass}
    >
      <header>
        <h3 className="text-sm font-semibold">Skills</h3>
        <p className="text-xs text-muted-foreground">
          {projectId
            ? "Skills available to this session."
            : "Open a project to load skills into this session."}
        </p>
      </header>

      {sessionId ? (
        <div data-testid="loaded-skills-list">
          <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Loaded</h4>
          {loaded.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : (loaded.data?.items ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">No skills loaded yet.</p>
          ) : (
            <ol className="space-y-1">
              {(loaded.data?.items ?? []).map((s, idx) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 text-xs"
                  data-testid={`loaded-skill-${s.key}`}
                >
                  <span>
                    <span
                      aria-label={`Order ${idx + 1}`}
                      className="mr-1 inline-block w-5 text-right tabular-nums text-muted-foreground"
                    >
                      {idx + 1}.
                    </span>
                    <strong>{s.name}</strong>
                  </span>
                  <code className="text-[10px] text-muted-foreground">{s.key}</code>
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Start a chat session to load skills.</p>
      )}

      {projectId && sessionId ? (
        <div>
          <h4 className="mb-1 text-xs font-medium uppercase text-muted-foreground">Available</h4>
          {available.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : allowed.length === 0 ? (
            <p className="text-xs text-muted-foreground">No skills available for this project.</p>
          ) : (
            <ul className="space-y-1" data-testid="available-skills-list">
              {allowed.map((e) => {
                const isLoaded = loadedById.has(e.skillId);
                const isPendingThis = pendingSkillId === e.skillId;
                const ariaLabel = isLoaded
                  ? `Skill ${e.skillKey} already loaded`
                  : isPendingThis
                    ? `Loading skill ${e.skillKey}`
                    : `Load skill ${e.skillKey}`;
                return (
                  <li key={e.skillId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0">
                      <strong className="block truncate">{e.name || e.skillKey}</strong>
                      <code className="text-[10px] text-muted-foreground">{e.skillKey}</code>
                    </span>
                    <Button
                      size="sm"
                      variant={isLoaded ? "outline" : "default"}
                      disabled={isLoaded || load.isPending}
                      onClick={() => load.mutate(e.skillId)}
                      aria-label={ariaLabel}
                      data-testid={`load-skill-${e.skillKey}`}
                    >
                      {isLoaded ? "Loaded" : isPendingThis ? "Loading\u2026" : "Load"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {load.isError ? (
            <p
              role="alert"
              className="mt-2 rounded border border-destructive p-1 text-xs text-destructive"
            >
              {(load.error as Error).message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
