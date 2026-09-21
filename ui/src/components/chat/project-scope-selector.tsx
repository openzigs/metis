"use client";

/**
 * Issue #537 — Project Scope Selector for the Chat page.
 *
 * #1368 — this was a multi-select with checkboxes, but chat only ever supported
 * ONE project. Selecting two did not block the turn: the server degraded to an
 * UNSCOPED session with zero RAG grounding and disclosed it only afterwards, at
 * which point the model reached for the filesystem and shell-grepped METIS's own
 * source tree instead of the user's project. The invalid state is now
 * unreachable rather than merely reported — picking a project REPLACES the
 * selection, so `projectIds` can never hold more than one id.
 *
 * Options:
 * - "All my projects" (default, deliberately unscoped)
 * - Exactly one project
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api-client";

const STORAGE_KEY = "metis.chat.projectScope";

export type ProjectScope = {
  mode: "all" | "selected";
  /** At most one id — see the single-select note above. */
  projectIds: string[];
};

interface AccessibleProject {
  id: string;
  name: string;
}

/**
 * Coerce any scope — including one persisted by the pre-#1368 multi-select —
 * into the single-project invariant. Exported for test; a stored two-project
 * selection would otherwise silently reproduce the unscoped-turn bug on the
 * next visit.
 */
export function normaliseScope(scope: ProjectScope): ProjectScope {
  if (scope.mode !== "selected" || scope.projectIds.length === 0) {
    return { mode: "all", projectIds: [] };
  }
  if (scope.projectIds.length === 1) return scope;
  return { mode: "selected", projectIds: [scope.projectIds[0]] };
}

function loadStoredScope(): ProjectScope {
  if (typeof window === "undefined") return { mode: "all", projectIds: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: "all", projectIds: [] };
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "mode" in parsed) {
      return normaliseScope(parsed as ProjectScope);
    }
  } catch {
    /* ignore corrupt localStorage */
  }
  return { mode: "all", projectIds: [] };
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

  function selectProject(projectId: string) {
    // Single-select: picking a project REPLACES the selection; picking the
    // already-selected one clears back to "all".
    const next: ProjectScope = value.projectIds.includes(projectId)
      ? { mode: "all", projectIds: [] }
      : { mode: "selected", projectIds: [projectId] };
    onChange(next);
    storeScope(next);
    setOpen(false);
  }

  function selectAll() {
    const next: ProjectScope = { mode: "all", projectIds: [] };
    onChange(next);
    storeScope(next);
    setOpen(false);
  }

  // #1368 AC — name the project instead of counting it, so the active scope is
  // visible without reopening the dropdown.
  const selectedProject = projects.find((p) => p.id === value.projectIds[0]);
  const label =
    value.mode === "all"
      ? "All projects"
      : (selectedProject?.name ?? (isLoading ? "Loading…" : "1 project"));

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
          role="listbox"
          aria-label="Select projects to search"
        >
          <button
            type="button"
            className={`w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent ${
              value.mode === "all" ? "bg-accent font-medium" : ""
            }`}
            onClick={selectAll}
          >
            All my projects
          </button>
          <hr className="my-1 border-border" />
          <div className="max-h-48 overflow-y-auto" role="radiogroup" aria-label="Project scope">
            {projects.map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name="metis-chat-project-scope"
                  className="border-input"
                  checked={value.projectIds.includes(p.id)}
                  onChange={() => selectProject(p.id)}
                />
                <span className="truncate">{p.name}</span>
              </label>
            ))}
            {projects.length === 0 && !isLoading && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No projects found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Hook to manage project scope state with localStorage persistence. */
export function useProjectScope() {
  const [scope, setScope] = useState<ProjectScope>({ mode: "all", projectIds: [] });
  // #1367 — the stored scope arrives one tick after mount, so a consumer that
  // keys work off `scope` would otherwise act once on the default and again on
  // the real value. `hydrated` lets it wait for the real one.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setScope(loadStoredScope());
    setHydrated(true);
  }, []);

  return { scope, setScope, hydrated };
}
