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
 * #2351 — rendered by the shared `ScopePicker` (components/scope), with the
 * same three options as impact analysis and the portfolio check:
 * - "This project" (the top bar's active project)
 * - "Chosen products" (one or more projects, ticked); nothing ticked is the
 *   unscoped chat, which answers without searching ("No product chosen")
 * - "Whole workspace" (the active workspace's projects, searched each turn)
 * The scope state, its storage and its opening rule below are unchanged.
 */
import { useEffect, useState } from "react";
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
import { ScopePicker, type ScopeKind } from "@/components/scope/scope-picker";

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
 * user has none, or their list cannot be read); with neither, no product is
 * chosen (#2351: the chat answers without searching).
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
  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["search", "accessible-projects"],
    queryFn: fetchAccessibleProjects,
  });
  // #2238 — the workspace the top bar is on, offered as a scope of its own.
  const { workspaceId: activeWorkspaceId } = useValidatedActiveWorkspaceId();
  const { data: workspaces = [] } = useQuery(workspaceListQuery);
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  // #2351 — "This project" is the top bar's, and "Whole workspace" says how
  // many projects it searches: the top bar's own list of that workspace.
  const switcher = useQuery(projectSwitcherQuery(activeWorkspaceId));
  const switcherItems = Array.isArray(switcher.data?.items) ? switcher.data.items : [];
  const activeId = resolveActiveProjectId(readStoredActiveProjectId(), switcherItems);
  const current = projects.find((p) => p.id === activeId) ?? null;
  const workspaceCount =
    activeWorkspace && switcher.isSuccess && typeof switcher.data?.total === "number"
      ? switcher.data.total
      : null;

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

  function isThisProject(scope: ProjectScope): boolean {
    return scope.projectIds.length === 1 && scope.projectIds[0] === current?.id;
  }

  function pick(next: ProjectScope) {
    onChange(next);
    storeScope(next);
  }

  function toggleProject(projectId: string) {
    // #2238 — ticking adds the project to the scope, unticking removes it; an
    // emptied selection is "all" (no search). From a workspace, or from "This
    // project" (which the picker shows unticked), it starts afresh.
    const currentIds = value.mode === "selected" && !isThisProject(value) ? value.projectIds : [];
    const ids = currentIds.includes(projectId)
      ? currentIds.filter((id) => id !== projectId)
      : [...currentIds, projectId];
    pick(normaliseScope({ mode: "selected", projectIds: ids }));
  }

  // #2351 — the shared picker's three options over chat's scope: one project
  // that is the top bar's is "This project"; any other selection is "Chosen
  // products"; nothing ticked ("all") answers without searching.
  const kind: ScopeKind | null =
    value.mode === "workspace"
      ? "workspace"
      : value.mode === "selected"
        ? isThisProject(value)
          ? "this"
          : "chosen"
        : null;
  // The option names, and picks, the top bar's workspace; a stored scope on
  // another workspace names the button only. With no workspace open the option
  // is disabled and says why, rather than taking a click that does nothing.
  const storedWorkspace =
    value.mode === "workspace" && value.workspaceId !== activeWorkspace?.id
      ? (workspaces.find((w) => w.id === value.workspaceId) ?? null)
      : null;

  return (
    <ScopePicker
      kind={kind}
      chosenIds={value.mode === "selected" ? value.projectIds : []}
      items={projects}
      itemsLoading={isLoading}
      current={current}
      currentNote="No project is open in the top bar."
      workspace={
        activeWorkspace
          ? { id: activeWorkspace.id, name: activeWorkspace.name, count: workspaceCount }
          : null
      }
      workspaceNote="No workspace is open in the top bar."
      scopeWorkspace={storedWorkspace ? { name: storedWorkspace.name, count: null } : null}
      onPickThis={() => {
        if (current) pick({ mode: "selected", projectIds: [current.id] });
      }}
      onPickWorkspace={() => {
        if (activeWorkspace) {
          pick({ mode: "workspace", projectIds: [], workspaceId: activeWorkspace.id });
        }
      }}
      onToggle={(p) => toggleProject(p.id)}
      disabled={disabled || isLoading}
      testIdBase="project-scope"
      ariaLabel="Project scope"
    />
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
