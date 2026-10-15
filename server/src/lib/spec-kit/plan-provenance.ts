/**
 * #1134 — which `plan.md` a derived artifact was generated from, and whether
 * that plan is still current.
 *
 * `/speckit.tasks`, `/speckit.analyze` and `/speckit.checklist` read plan.md.
 * Re-running `/speckit.plan` gives plan.md a new version and left those
 * artifacts on the earlier design with nothing on the page saying so (run 8:
 * tasks.md still named `entry_handlers.go` after plan v2 moved the change to
 * `user_handlers.go`).
 *
 * Each derived artifact now carries one stamp line naming the plan version it
 * was generated from. It is an HTML comment, so it travels with the artifact
 * into the target repository and needs no schema column. The Spec Kit viewer's
 * markdown renderer shows raw HTML as text, so `displayArtifactText` in
 * ui/src/lib/spec-kit-display.ts hides the line from the page.
 * An artifact written before the stamp existed (or with the stamp edited out)
 * is judged by time instead: older than plan.md ⇒ out of date, version unknown.
 */

/** Artifacts generated from plan.md. Checklists are `checklist-<domain>.md`. */
export function isPlanDerivedArtifact(key: string): boolean {
  return key === "tasks.md" || key === "analysis.md" || /^checklist-[\w-]+\.md$/.test(key);
}

const STAMP_RE = /^<!-- metis: generated from plan\.md v(\d+) -->[ \t]*$/gm;

/** The stamp line for `planVersion`. */
export function planSourceStamp(planVersion: number): string {
  return `<!-- metis: generated from plan.md v${planVersion} -->`;
}

/**
 * `content` with every earlier stamp removed and one stamp for `planVersion`
 * at the end. `planVersion` null (no plan.md — a forced gate) removes the
 * stamps and adds none: the artifact was not generated from any plan.
 */
export function stampPlanSource(content: string, planVersion: number | null): string {
  const bare = content.replace(STAMP_RE, "").trimEnd();
  return planVersion === null ? `${bare}\n` : `${bare}\n\n${planSourceStamp(planVersion)}\n`;
}

/** The plan version the last stamp in `content` names, or null when it has none. */
export function readPlanSource(content: string): number | null {
  let version: number | null = null;
  for (const m of content.matchAll(STAMP_RE)) version = Number(m[1]);
  return version;
}

/** The fields staleness is judged on; both artifact stores' DTOs have them. */
export interface VersionedArtifact {
  content: string;
  version: number;
  updatedAt: string;
}

export interface StaleArtifact {
  key: string;
  /** The plan.md version it was generated from; null when it carries no stamp. */
  planVersion: number | null;
  /** The current plan.md version. */
  currentPlanVersion: number;
}

/**
 * Whether `artifact` predates `plan`: its stamp names another version (an earlier
 * one, or a later one when plan.md was deleted and restarted at v1), or —
 * with no stamp — it was last written before plan.md was.
 */
export function stalenessAgainstPlan(
  key: string,
  artifact: VersionedArtifact,
  plan: VersionedArtifact | null,
): StaleArtifact | null {
  if (!plan) return null;
  const source = readPlanSource(artifact.content);
  const stale =
    source !== null
      ? source !== plan.version
      : Date.parse(artifact.updatedAt) < Date.parse(plan.updatedAt);
  return stale ? { key, planVersion: source, currentPlanVersion: plan.version } : null;
}

/** Every plan-derived artifact in a feature's set that predates its plan.md. */
export function findStaleArtifacts(
  artifacts: ReadonlyArray<VersionedArtifact & { key: string }>,
): StaleArtifact[] {
  const plan = artifacts.find((a) => a.key === "plan.md") ?? null;
  return artifacts.flatMap((a) => {
    if (!isPlanDerivedArtifact(a.key)) return [];
    const stale = stalenessAgainstPlan(a.key, a, plan);
    return stale ? [stale] : [];
  });
}

/** "generated from plan.md v1; plan.md is now v2" — for messages and the page. */
export function describeStale(stale: StaleArtifact): string {
  const from =
    stale.planVersion === null
      ? `generated before plan.md v${stale.currentPlanVersion}`
      : `generated from plan.md v${stale.planVersion}`;
  return `${stale.key} was ${from}; plan.md is now v${stale.currentPlanVersion}`;
}
