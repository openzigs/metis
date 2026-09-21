/**
 * Epic #396 (MVP-2) — Spec Kit `/speckit.constitution` semver + heuristic
 * validation + preamble loader.
 *
 * The constitution is supreme law for every other Spec Kit phase. It is
 * stored in two places, kept in sync:
 *   1. `SpecKitArtifact { name: 'constitution.md', content }` — the
 *      authoritative blob, surfaced by the existing v1.2 routes.
 *   2. `SpecKitConstitution { version, ratifiedAt, lastAmendedAt }` — the
 *      semver metadata that lets agents decide whether to re-read.
 *
 * Heuristic validation matches upstream spec-kit (no JSON schema):
 *   - Required sections: `# History`, `# Governance`, `# (Core )?Principles`.
 *   - Required metadata: `Version: x.y.z`, `Ratified: YYYY-MM-DD`,
 *     `Last Amended: YYYY-MM-DD`.
 *
 * Semver bump rules:
 *   - principle ADDED → minor bump.
 *   - wording change only → patch bump.
 *   - principle REMOVED → major bump.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { writeArtifact, getArtifact, SpecKitArtifactError } from "./artifacts.js";

export const REQUIRED_SECTIONS = [/^# History/m, /^# Governance/m, /^#+ (Core )?Principles/m];
export const REQUIRED_META = [
  /^Version:\s*\d+\.\d+\.\d+/m,
  /^Ratified:\s*\d{4}-\d{2}-\d{2}/m,
  /^Last Amended:\s*\d{4}-\d{2}-\d{2}/m,
];

export interface ConstitutionValidation {
  ok: boolean;
  failures: string[];
}

export function validateConstitution(content: string): ConstitutionValidation {
  const failures: string[] = [];
  for (const re of REQUIRED_SECTIONS) {
    if (!re.test(content)) failures.push(`missing required section: ${re}`);
  }
  for (const re of REQUIRED_META) {
    if (!re.test(content)) failures.push(`missing required metadata line: ${re}`);
  }
  return { ok: failures.length === 0, failures };
}

export type SemverBump = "major" | "minor" | "patch";

export function bumpSemver(current: string, kind: SemverBump): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_INVALID_SEMVER",
      `Cannot bump non-semver string: ${current}`,
    );
  }
  let [maj, min, pat] = [
    Number.parseInt(m[1]!, 10),
    Number.parseInt(m[2]!, 10),
    Number.parseInt(m[3]!, 10),
  ];
  if (kind === "major") {
    maj += 1;
    min = 0;
    pat = 0;
  } else if (kind === "minor") {
    min += 1;
    pat = 0;
  } else {
    pat += 1;
  }
  return `${maj}.${min}.${pat}`;
}

/** Extract `## ` headings under the Principles section, returning their normalized titles. */
export function extractPrinciples(content: string): string[] {
  const idx = content.search(/^#+ (Core )?Principles/m);
  if (idx === -1) return [];
  const after = content.slice(idx);
  // Stop at the next top-level `# ` heading that isn't the Principles header itself.
  const next = after.slice(1).search(/\n# [^\n]/);
  const block = next === -1 ? after : after.slice(0, next + 1);
  const principles: string[] = [];
  const re = /^##+\s+([^\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const title = m[1]!.trim().toLowerCase();
    if (title.startsWith("core principles") || title === "principles") continue;
    principles.push(title);
  }
  return principles;
}

/**
 * Compare two constitutions and decide which semver bump applies.
 *   - any principle removed → major
 *   - any principle added → minor (unless major already)
 *   - else → patch
 */
export function detectBump(prev: string | null, next: string): SemverBump {
  if (!prev) return "patch"; // initial write — caller will start at 0.1.0 directly
  const before = new Set(extractPrinciples(prev));
  const after = new Set(extractPrinciples(next));
  for (const p of before) if (!after.has(p)) return "major";
  for (const p of after) if (!before.has(p)) return "minor";
  return "patch";
}

export interface ConstitutionMeta {
  version: string;
  ratifiedAt: string | null;
  lastAmendedAt: string | null;
}

export async function getConstitutionMeta(projectId: string): Promise<ConstitutionMeta | null> {
  const row = await prisma.specKitConstitution.findUnique({
    where: { projectId },
  });
  if (!row) return null;
  return {
    version: row.version,
    ratifiedAt: row.ratifiedAt ? row.ratifiedAt.toISOString() : null,
    lastAmendedAt: row.lastAmendedAt ? row.lastAmendedAt.toISOString() : null,
  };
}

export interface UpsertConstitutionInput {
  projectId: string;
  /** Free-text body the user submitted (post-validation). */
  content: string;
  actorId?: string | null;
}

export interface UpsertConstitutionResult {
  meta: ConstitutionMeta;
  fromVersion: string;
  toVersion: string;
  bump: SemverBump;
}

/**
 * Validate, version, and persist the constitution. Throws
 * `SpecKitArtifactError(400, 'SPECKIT_CONSTITUTION_INVALID', …)` when
 * heuristic validation fails — content is never persisted in that case.
 */
export async function upsertConstitution(
  input: UpsertConstitutionInput,
): Promise<UpsertConstitutionResult> {
  const validation = validateConstitution(input.content);
  if (!validation.ok) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_CONSTITUTION_INVALID",
      `Constitution failed heuristic validation: ${validation.failures.join("; ")}`,
    );
  }
  const previousArtifact = await getArtifact(input.projectId, "constitution.md");
  const previousContent = previousArtifact?.content ?? null;
  const previousMeta = await getConstitutionMeta(input.projectId);

  // Initial write: version starts at 0.1.0; ratifiedAt = now.
  let newVersion: string;
  let bump: SemverBump;
  let fromVersion: string;
  let ratifiedAt: Date;
  const now = new Date();
  if (!previousMeta) {
    fromVersion = "0.0.0";
    newVersion = "0.1.0";
    bump = "minor";
    ratifiedAt = now;
  } else {
    fromVersion = previousMeta.version;
    bump = detectBump(previousContent, input.content);
    newVersion = bumpSemver(previousMeta.version, bump);
    ratifiedAt = previousMeta.ratifiedAt ? new Date(previousMeta.ratifiedAt) : now;
  }

  await writeArtifact({
    projectId: input.projectId,
    name: "constitution.md",
    content: input.content,
    actorId: input.actorId ?? null,
  });

  await prisma.specKitConstitution.upsert({
    where: { projectId: input.projectId },
    update: { version: newVersion, lastAmendedAt: now },
    create: {
      projectId: input.projectId,
      version: newVersion,
      ratifiedAt,
      lastAmendedAt: now,
    },
  });

  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "speckit.constitution_updated",
    target: { type: "speckit_constitution", id: input.projectId },
    metadata: {
      fromVersion,
      toVersion: newVersion,
      bump,
      sectionsChanged: diffPrincipleSet(previousContent, input.content),
    },
  });

  return {
    meta: {
      version: newVersion,
      ratifiedAt: ratifiedAt.toISOString(),
      lastAmendedAt: now.toISOString(),
    },
    fromVersion,
    toVersion: newVersion,
    bump,
  };
}

function diffPrincipleSet(prev: string | null, next: string): string[] {
  const before = new Set(prev ? extractPrinciples(prev) : []);
  const after = new Set(extractPrinciples(next));
  const changed: string[] = [];
  for (const p of after) if (!before.has(p)) changed.push(`+${p}`);
  for (const p of before) if (!after.has(p)) changed.push(`-${p}`);
  return changed;
}

/**
 * Build the preamble block injected into every other Spec Kit command's
 * system prompt. Format: marker fence + version + ratification dates +
 * full constitution body.
 */
export async function loadAsPreamble(projectId: string): Promise<string | null> {
  const artifact = await getArtifact(projectId, "constitution.md");
  if (!artifact || artifact.content.trim().length === 0) return null;
  const meta = await getConstitutionMeta(projectId);
  const header = meta
    ? `<!-- speckit.constitution v${meta.version} ratified ${meta.ratifiedAt ?? "n/a"} amended ${meta.lastAmendedAt ?? "n/a"} -->`
    : "<!-- speckit.constitution (untracked metadata) -->";
  return `${header}\n${artifact.content.trim()}\n<!-- end speckit.constitution -->\n`;
}
