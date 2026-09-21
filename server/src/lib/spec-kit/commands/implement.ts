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
import { loadProjectContext } from "./runner.js";

export interface ImplementInput {
  projectId: string;
  actorId?: string | null;
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
  const present: string[] = [];
  for (const name of REQUIRED) {
    const a = await getArtifact(input.projectId, name);
    if (!a || a.content.trim().length === 0) {
      throw new SpecKitArtifactError(
        409,
        "SPEC_KIT_IMPLEMENT_INCOMPLETE",
        `Cannot /implement: missing ${name} — run /${name.replace(".md", "")} first`,
      );
    }
    present.push(name);
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
    message:
      `Spec Kit handoff ready. POST to ${`/api/projects/${project.id}/analyses`}` +
      ` to start the orchestrator with ${present.length} artifact(s) as context.`,
  };
}
