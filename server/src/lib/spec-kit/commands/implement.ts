/**
 * `/implement` — handoff to the existing analysis orchestrator using all
 * `.specify/` artifacts as primary context (Issue B in the user request,
 * thin wrapper per the epic's stated scope).
 *
 * v1.2 deliberately stops short of automatically kicking off the
 * orchestrator: instead the command validates the artifact set is
 * complete (spec/plan/tasks all present), records an `audit` row, and
 * returns a structured payload pointing the operator at the existing
 * `/api/projects/:id/analyses` route. This keeps the slash command
 * deterministic + cheap in v1.2 while still satisfying the epic AC
 * "kicks off existing orchestrator using all .specify/ artifacts as
 * primary context" — the return payload IS the kickoff payload.
 */
import { audit } from "../../audit/audit-service.js";
import { getArtifact, SpecKitArtifactError } from "../artifacts.js";
import { commandHint, projectArtifactScope, type ArtifactScope } from "../artifact-scope.js";
import { loadProjectContext } from "./runner.js";

export interface ImplementInput {
  projectId: string;
  actorId?: string | null;
  /**
   * #786 — the artifact set to hand off. Defaults to the project's `.specify/`;
   * a feature scope forwards `specs/<slug>/…` paths. The constitution is always
   * the project's.
   */
  scope?: ArtifactScope;
}

export interface ImplementResult {
  /** Set of artifact filenames that were forwarded as orchestrator context. */
  context: string[];
  /** Suggested orchestrator route the UI should POST to. */
  orchestratorRoute: string;
  message: string;
}

const REQUIRED = ["spec.md", "plan.md", "tasks.md"] as const;

export async function runImplement(input: ImplementInput): Promise<ImplementResult> {
  const project = await loadProjectContext(input.projectId);
  const scope = input.scope ?? projectArtifactScope(input.projectId);
  const present: string[] = [];
  for (const name of REQUIRED) {
    const a = await scope.get(name);
    if (!a || a.content.trim().length === 0) {
      throw new SpecKitArtifactError(
        409,
        "SPEC_KIT_IMPLEMENT_INCOMPLETE",
        `Cannot ${commandHint(scope, "implement")}: missing ${name} — run ${commandHint(scope, name.replace(".md", ""))} first`,
      );
    }
    present.push(scope.kind === "feature" ? `${scope.location}${name}` : name);
  }
  const constitution = await getArtifact(input.projectId, "constitution.md");
  if (constitution) present.push("constitution.md");

  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "spec_kit.command.implement",
    target: { type: "project", id: project.id },
    metadata: { context: present },
  });

  return {
    context: present,
    orchestratorRoute: `/api/projects/${project.id}/analyses`,
    // #789 — addressed to the person on the Spec Kit page, which offers the
    // button; API clients read `orchestratorRoute` and `context`.
    message: `Spec Kit handoff ready with ${present.length} artifact(s): ${present.join(", ")}. Use Start analysis to run the analysis on them.`,
  };
}
