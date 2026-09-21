/**
 * Epic #396 (MVP-2) — `/speckit.constitution` command.
 *
 * Validates incoming text against the heuristic schema, applies semver
 * bump rules, and persists both the artifact body and the metadata row.
 * RBAC: requires `speckit.constitution.write` (gated by the route layer).
 */
import { upsertConstitution, type UpsertConstitutionResult } from "../constitution-meta.js";
import { SpecKitArtifactError } from "../artifacts.js";

export interface ConstitutionInput {
  projectId: string;
  content: string;
  actorId?: string | null;
}

export interface ConstitutionResult extends UpsertConstitutionResult {
  message: string;
}

export async function runConstitution(input: ConstitutionInput): Promise<ConstitutionResult> {
  const trimmed = (input.content ?? "").trim();
  if (trimmed.length === 0) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_EMPTY_INPUT",
      "/speckit.constitution requires the constitution body in the request input.",
    );
  }
  const result = await upsertConstitution({
    projectId: input.projectId,
    content: trimmed,
    actorId: input.actorId ?? null,
  });
  return {
    ...result,
    message: `Constitution updated ${result.fromVersion} → ${result.toVersion} (${result.bump} bump).`,
  };
}
