/**
 * #469 — Per-project SKILL allowlist toggle (the legible variant).
 *
 * The original `ProjectToggle` (still used for agents) reads ONLY the explicit
 * allowlist rows (`libraryApi.projectSkills`). Under the runtime's default-allow
 * rule (`resolveAllowedSkillIds`: a project with NO explicit rows allows every
 * globally-enabled skill), that view is misleading for skills:
 *
 *   - It shows "Enable" (looks disabled) for a skill that is actually available
 *     by default.
 *   - Clicking "Enable" writes the FIRST explicit row, which silently flips the
 *     project from "all enabled skills allowed" to "ONLY this one allowed",
 *     disallowing every other skill.
 *
 * This component fixes that for skills by combining two sources:
 *   - `libraryApi.projectAvailableSkills` (#468) — the resolved runtime gate, i.e.
 *     what is *effectively* available right now.
 *   - `libraryApi.projectSkills` — the explicit allowlist rows (if any).
 *
 * It renders a three-state, legible control and — when the project has no
 * explicit rows yet — warns that enabling the first skill restricts the project
 * to only the skills you explicitly allow. It writes through the existing
 * `PUT /projects/:id/library/skills/:skillId` endpoint.
 */
"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  libraryApi,
  type ProjectAvailableSkill,
  type ProjectSkillAllowlistEntry,
} from "@/lib/library-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";

/** Effective allow-state of a single skill for a project. */
export type SkillAllowState =
  | "available-by-default" // no explicit rows for the project → allowed by default-allow
  | "explicitly-enabled" // an explicit row with enabled=true
  | "explicitly-disabled"; // an explicit row with enabled=false

export interface SkillAllowResolution {
  state: SkillAllowState;
  /** True when the project has NO explicit allowlist rows (pure default-allow). */
  projectHasNoExplicitRows: boolean;
  /** True when this skill is currently usable by the project's chat sessions. */
  effectivelyAllowed: boolean;
}

/**
 * Pure resolver — given the project's explicit rows and the resolved-available
 * set, decide how a given skill should be presented. Extracted so the
 * legibility logic is unit-testable without a DOM.
 */
export function resolveSkillAllowState(args: {
  skillId: string;
  explicitRows: readonly ProjectSkillAllowlistEntry[];
  availableSkillIds: ReadonlySet<string>;
}): SkillAllowResolution {
  const { skillId, explicitRows, availableSkillIds } = args;
  const projectHasNoExplicitRows = explicitRows.length === 0;
  const row = explicitRows.find((r) => r.skillId === skillId);
  const effectivelyAllowed = availableSkillIds.has(skillId);

  if (projectHasNoExplicitRows) {
    return { state: "available-by-default", projectHasNoExplicitRows, effectivelyAllowed };
  }
  if (row && row.enabled) {
    return { state: "explicitly-enabled", projectHasNoExplicitRows, effectivelyAllowed };
  }
  // Either an explicit disabled row, or no row at all while OTHER explicit rows
  // exist (the list is exhaustive once any row exists → this skill is excluded).
  return { state: "explicitly-disabled", projectHasNoExplicitRows, effectivelyAllowed };
}

const STATE_LABEL: Record<SkillAllowState, string> = {
  "available-by-default": "Default",
  "explicitly-enabled": "Allowed",
  "explicitly-disabled": "Disallowed",
};

const STATE_HINT: Record<SkillAllowState, string> = {
  "available-by-default": "Available by default — no explicit rule yet.",
  "explicitly-enabled": "Explicitly allowed for this project.",
  "explicitly-disabled": "Not allowed for this project.",
};

interface Props {
  projectId: string;
  skillId: string;
  /** Whether the viewer holds `project.update` for this project. */
  canManage: boolean;
}

export function ProjectSkillAllowlistToggle({ projectId, skillId, canManage }: Props) {
  const qc = useQueryClient();

  const explicitQuery = useQuery({
    queryKey: queryKeys.library.projectSkills(projectId),
    queryFn: () => libraryApi.projectSkills(projectId),
  });
  const availableQuery = useQuery({
    queryKey: queryKeys.library.projectAvailableSkills(projectId),
    queryFn: () => libraryApi.projectAvailableSkills(projectId),
  });

  const explicitRows = explicitQuery.data?.items ?? [];
  const availableSkillIds = useMemo(
    () => new Set((availableQuery.data?.items ?? []).map((s: ProjectAvailableSkill) => s.skillId)),
    [availableQuery.data],
  );

  const resolution = resolveSkillAllowState({ skillId, explicitRows, availableSkillIds });

  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => libraryApi.setProjectSkill(projectId, skillId, enabled),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.library.projectSkills(projectId) });
      void qc.invalidateQueries({ queryKey: queryKeys.library.projectAvailableSkills(projectId) });
    },
  });

  const loading = explicitQuery.isLoading || availableQuery.isLoading;

  // The consequential action: creating the FIRST explicit row narrows the
  // project from "all enabled skills" to "only what you allow". Either direction
  // (Allow or Disallow) that writes the first row has this effect, so confirm
  // before it so a user doesn't silently disallow everything else.
  const writesFirstExplicitRow = resolution.projectHasNoExplicitRows;

  const write = (enabled: boolean) => {
    if (
      writesFirstExplicitRow &&
      typeof window !== "undefined" &&
      typeof window.confirm === "function"
    ) {
      const ok = window.confirm(
        "This project currently allows every enabled skill by default. " +
          "Creating an explicit rule restricts it to ONLY the skills you allow — " +
          "every other skill becomes disallowed until you add it. Continue?",
      );
      if (!ok) return;
    }
    setEnabled.mutate(enabled);
  };

  const isAllowedNow =
    resolution.state === "explicitly-enabled" || resolution.state === "available-by-default";

  return (
    <div className="flex flex-col items-end gap-1" data-testid={`project-skill-allow-${skillId}`}>
      <div className="flex items-center gap-2">
        <span
          data-testid={`project-skill-state-${skillId}`}
          className={
            "rounded px-2 py-0.5 text-xs " +
            (resolution.state === "explicitly-enabled"
              ? "bg-green-100 text-green-900"
              : resolution.state === "explicitly-disabled"
                ? "bg-amber-100 text-amber-900"
                : "bg-muted text-muted-foreground")
          }
        >
          {STATE_LABEL[resolution.state]}
        </span>
        {canManage ? (
          isAllowedNow ? (
            <Button
              size="sm"
              variant="outline"
              disabled={loading || setEnabled.isPending}
              onClick={() => write(false)}
              data-testid={`project-skill-disallow-btn-${skillId}`}
            >
              Disallow
            </Button>
          ) : (
            <Button
              size="sm"
              variant="default"
              disabled={loading || setEnabled.isPending}
              onClick={() => write(true)}
              data-testid={`project-skill-allow-btn-${skillId}`}
            >
              Allow
            </Button>
          )
        ) : null}
      </div>
      <p className="max-w-[14rem] text-right text-xs text-muted-foreground">
        {STATE_HINT[resolution.state]}
        {canManage && writesFirstExplicitRow ? (
          <span className="block text-amber-700">
            Allowing the first skill restricts this project to only the skills you allow.
          </span>
        ) : null}
      </p>
    </div>
  );
}
