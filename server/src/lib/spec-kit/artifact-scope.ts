/**
 * #786 — where a Spec Kit command reads and writes its artifacts.
 *
 * The v1.2 commands (`/tasks`, `/clarify`, `/analyze`, `/implement`) were
 * written against the project-level `.specify/` set. The per-feature pipeline
 * (`specs/<slug>/`, Epic #396) reused them through `dispatchNamespaced`, which
 * dropped the `featureSlug`: `speckit.tasks` for a feature regenerated the
 * project's `tasks.md` instead and the feature's `tasks.md` could never exist.
 *
 * A command now takes an {@link ArtifactScope}: the project's `.specify/` set
 * (the default, unchanged) or one feature's `specs/<slug>/` set.
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { getArtifact, writeArtifact } from "./artifacts.js";
import {
  getFeatureArtifact,
  writeFeatureArtifact,
  type FeatureArtifactDto,
} from "./feature-artifacts.js";
import type { SpecKitFeatureDto } from "./features.js";

/** An artifact as either scope returns it. */
export type ScopedArtifact = SpecKitArtifactDto | FeatureArtifactDto;

export interface ArtifactScope {
  readonly kind: "project" | "feature";
  /** Where the artifacts live, for messages: `.specify/` or `specs/<slug>/`. */
  readonly location: string;
  /** The feature's slug, when the scope is one feature. */
  readonly featureSlug: string | null;
  get(name: string): Promise<ScopedArtifact | null>;
  write(name: string, content: string, actorId: string | null): Promise<ScopedArtifact>;
}

/** The project-level `.specify/` artifact set (the v1.2 behaviour). */
export function projectArtifactScope(projectId: string): ArtifactScope {
  return {
    kind: "project",
    location: ".specify/",
    featureSlug: null,
    get: (name) => getArtifact(projectId, name),
    write: (name, content, actorId) => writeArtifact({ projectId, name, content, actorId }),
  };
}

/** One feature's `specs/<slug>/` artifact set. */
export function featureArtifactScope(
  feature: Pick<SpecKitFeatureDto, "id" | "slug">,
): ArtifactScope {
  return {
    kind: "feature",
    location: `specs/${feature.slug}/`,
    featureSlug: feature.slug,
    get: (name) => getFeatureArtifact(feature.id, name),
    write: (name, content, actorId) =>
      writeFeatureArtifact({ featureId: feature.id, key: name, content, actorId }),
  };
}

/** ` for <slug>` in a feature scope, empty for the project — for result messages. */
export function forFeature(scope: ArtifactScope): string {
  return scope.featureSlug ? ` for ${scope.featureSlug}` : "";
}

/**
 * The command a missing artifact names in an error: `/speckit.tasks` with the
 * feature's slug for a feature, the legacy `/tasks` for the project.
 */
export function commandHint(scope: ArtifactScope, command: string): string {
  return scope.kind === "feature"
    ? `/speckit.${command} with featureSlug ${scope.featureSlug}`
    : `/${command}`;
}
