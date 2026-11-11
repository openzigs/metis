"use client";

/**
 * Issue #537 — Project Scope Selector for the Chat page.
 *
 * #1368 — this was a multi-select, but chat then supported ONE project: two
 * selected projects silently became an UNSCOPED session with no retrieval, so
 * it was made single-select.
 *
 * #2238 — chat now searches every project in a multi-product scope (and every
 * project of a workspace), so the multi-select is back: ticking projects adds
 * them to the scope, and the server keeps the whole scope on the session.
 *
 * Options:
 * - "All my projects" (default, deliberately unscoped: no retrieval)
 * - "Every project in <workspace>" (the active workspace, searched each turn)
 * - One or more projects
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";
import {
  projectSwitcherQuery,
  readStoredActiveProjectId,
  resolveActiveProjectId,
} from "@/lib/active-project";
import {
  useActiveWorkspaceId,
  useValidatedActiveWorkspaceId,
  workspaceListQuery,
} from "@/lib/active-workspace";

const STORAGE_KEY = "metis.chat.projectScope";

export type ProjectScope = {
  /**
   * `all`: unscoped. `selected`: the projects in `projectIds` (one binds the
   * session to that project; 2+ make a multi-product session, #2238).
   * `workspace` (#2238): every project of `workspaceId`.
   */
  mode: "all" | "selected" | "workspace";
  projectIds: string[];
  workspaceId?: string;
};

interface AccessibleProject {
  id: string;
  name: string;
}

/**
 * Coerce any scope — including one persisted by an older build — into a shape
 * the session API takes. Exported for test.
 */
export function normaliseScope(scope: ProjectScope): ProjectScope {
  if (scope.mode === "workspace") {
    return scope.workspaceId
      ? { mode: "workspace", projectIds: [], workspaceId: scope.workspaceId }
      : { mode: "all", projectIds: [] };
  }
  if (scope.mode !== "selected" || scope.projectIds.length === 0) {
    return { mode: "all", projectIds: [] };
  }
  return { mode: "selected", projectIds: [...new Set(scope.projectIds)] };
}

/** The scope last picked in this selector, or `null` when the user has never picked one. */
export function loadStoredScope(): ProjectScope | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "mode" in parsed) {
      return normaliseScope(parsed as ProjectScope);
    }
  } catch {
    /* ignore corrupt localStorage */
  }
  return null;
}

/**
 * #1139 — the scope `/chat` opens on: the project active in the top bar. The
 * scope stored by this selector is used only when no project is active (the
 * user has none, or their list cannot be read); with neither, "All projects".
 *
 * Before, a stored scope always won, so chat opened on whichever project was
 * last picked HERE — in the walkthrough, a different project from the one the
 * top bar showed. (#18's "start grounded in your only project" still holds: a
 * user with one project has it active.)
 *
 * #2238 — a stored multi-product scope that includes the active project, or a
 * stored workspace scope on the active workspace, agrees with the top bar, so
 * chat reopens on it (and a reload resumes that conversation).
 */
export function initialChatScope(
  activeProjectId: string | null,
  stored: ProjectScope | null,
  activeWorkspaceId: string | null = null,
): ProjectScope {
  if (activeProjectId) {
    if (stored?.mode === "selected" && stored.projectIds.includes(activeProjectId)) return stored;
    if (stored?.mode === "workspace" && stored.workspaceId === activeWorkspaceId) return stored;
    return { mode: "selected", projectIds: [activeProjectId] };
  }
  return stored ?? { mode: "all", projectIds: [] };
}

function storeScope(scope: ProjectScope): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
  } catch {
    /* Safari private mode */
  }
}

async function fetchAccessibleProjects(): Promise<AccessibleProject[]> {
  const res = await apiFetch<AccessibleProject[]>("/search/projects");
  return res;
}

interface Props {
  value: ProjectScope;
  onChange: (scope: ProjectScope) => void;
  disabled?: boolean;
}

export function ProjectScopeSelector({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["search", "accessible-projects"],
    queryFn: fetchAccessibleProjects,
  });
  // #2238 — the workspace the top bar is on, offered as a scope of its own.
  const { workspaceId: activeWorkspaceId } = useValidatedActiveWorkspaceId();
  const { data: workspaces = [] } = useQuery(workspaceListQuery);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;

  // Self-heal a stale persisted scope: once the accessible-projects list has
  // loaded, drop any selected id that is no longer accessible (e.g. the project
  // was deleted or a local DB was reset). This stops the selector from showing
  // a phantom scope and prevents a dead id from being sent to the session API.
  // If pruning empties the selection we revert to "all".
  useEffect(() => {
    if (isLoading || value.mode !== "selected") return;
    const live = new Set(projects.map((p) => p.id));
    const kept = value.projectIds.filter((id) => live.has(id));
    if (kept.length === value.projectIds.length) return; // nothing stale
    const next = normaliseScope({ mode: "selected", projectIds: kept });
    onChange(next);
    storeScope(next);
  }, [isLoading, projects, value, onChange]);

  function pick(next: ProjectScope, close: boolean) {
    onChange(next);
    storeScope(next);
    if (close) setOpen(false);
  }

  function toggleProject(projectId: string) {
    // #2238 — ticking adds the project to the scope, unticking removes it; an
    // emptied selection is "all". From "all" or a workspace, it starts afresh.
    const current = value.mode === "selected" ? value.projectIds : [];
    const ids = current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId];
    pick(normaliseScope({ mode: "selected", projectIds: ids }), false);
  }

  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name;
  const label = (() => {
    if (value.mode === "all") return "All projects";
    if (value.mode === "workspace") {
      const ws = workspaces.find((w) => w.id === value.workspaceId);
      return ws ? `All of ${ws.name}` : "Workspace";
    }
    // #1368 AC — name the project instead of counting it, so the active scope
    // is visible without reopening the dropdown.
    const first = nameOf(value.projectIds[0]) ?? (isLoading ? "Loading…" : "1 project");
    const more = value.projectIds.length - 1;
    if (more === 0) return first;
    if (more === 1) return `${first} + ${nameOf(value.projectIds[1]) ?? "1 more"}`;
    return `${first} + ${more} more`;
  })();

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-label="Project scope"
        data-testid="project-scope-selector"
        className="flex items-center gap-1.5 rounded-full border bg-background px-3 py-1 text-xs font-medium disabled:opacity-50"
        onClick={() => setOpen(!open)}
        disabled={disabled || isLoading}
      >
        <svg
          className="h-3.5 w-3.5 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <span>{label}</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md border bg-popover p-2 shadow-md"
          role="dialog"
          aria-label="Select projects to search"
        >
          <button
            type="button"
            className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
              value.mode === "all" ? "bg-accent font-medium" : ""
            }`}
            onClick={() => pick({ mode: "all", projectIds: [] }, true)}
          >
            All my projects
          </button>
          {activeWorkspace ? (
            <button
              type="button"
              data-testid="project-scope-workspace"
              className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
                value.mode === "workspace" && value.workspaceId === activeWorkspace.id
                  ? "bg-accent font-medium"
                  : ""
              }`}
              onClick={() =>
                pick({ mode: "workspace", projectIds: [], workspaceId: activeWorkspace.id }, true)
              }
            >
              Every project in {activeWorkspace.name}
            </button>
          ) : null}
          <hr className="my-1 border-border" />
          <div className="max-h-48 overflow-y-auto" role="group" aria-label="Projects to search">
            {projects.map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="rounded border-input"
                  checked={value.mode === "selected" && value.projectIds.includes(p.id)}
                  onChange={() => toggleProject(p.id)}
                />
                <span className="truncate">{p.name}</span>
              </label>
            ))}
            {projects.length === 0 && !isLoading && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No projects found</p>
            )}
          </div>
          <p className="mt-1 px-2 text-xs text-muted-foreground">
            Tick several projects to ask about all of them at once.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The chat's project scope: it starts on {@link initialChatScope} (the top
 * bar's active project, else the stored scope) and follows the selector after.
 */
export function useProjectScope() {
  const [scope, setScope] = useState<ProjectScope>({ mode: "all", projectIds: [] });
  // #1367 — the starting scope is known only once the project list is read, so
  // a consumer that keys work off `scope` would otherwise act once on the
  // default and again on the real value. `hydrated` lets it wait for the real one.
  const [hydrated, setHydrated] = useState(false);
  // #1139 — the top bar's own list, so the active project is the one it shows.
  const activeWorkspaceId = useActiveWorkspaceId();
  const projects = useQuery(projectSwitcherQuery(activeWorkspaceId));

  useEffect(() => {
    if (hydrated) return;
    if (projects.isSuccess) {
      const active = resolveActiveProjectId(readStoredActiveProjectId(), projects.data.items);
      setScope(initialChatScope(active, loadStoredScope(), activeWorkspaceId));
      setHydrated(true);
    } else if (projects.isError) {
      setScope(initialChatScope(null, loadStoredScope()));
      setHydrated(true);
    }
  }, [hydrated, projects.isSuccess, projects.isError, projects.data, activeWorkspaceId]);

  return { scope, setScope, hydrated };
}
