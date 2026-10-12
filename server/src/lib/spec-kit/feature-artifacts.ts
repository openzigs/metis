/**
 * Epic #396 (MVP-5/6/7) — per-feature artifact store.
 *
 * Wraps the `SpecKitFeatureArtifact` model. Keys are free-form so the
 * installer can write `spec.md`, `plan.md`, `research.md`, `data-model.md`,
 * `tasks.md`, `quickstart.md`, `analysis.md`, `clarify.md`,
 * `checklist-security.md`, `contracts/api.openapi.yaml`, etc.
 *
 * Key validation: alphanumeric, dot, hyphen, underscore, forward slash;
 * must NOT contain `..` segments (defence-in-depth for MVP-7 path-guard).
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { SpecKitArtifactError } from "./artifacts.js";
import { specKitJobCommitPoint } from "./job-scope.js";

const KEY_RE = /^[a-zA-Z0-9._/-]{1,128}$/;

export interface FeatureArtifactDto {
  id: string;
  featureId: string;
  key: string;
  content: string;
  version: number;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FeatureArtifactRow {
  id: string;
  featureId: string;
  key: string;
  content: string;
  version: number;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: FeatureArtifactRow): FeatureArtifactDto {
  return {
    id: row.id,
    featureId: row.featureId,
    key: row.key,
    content: row.content,
    version: row.version,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertKey(key: string): string {
  if (!KEY_RE.test(key)) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_INVALID_ARTIFACT_KEY",
      `Artifact key must match ${KEY_RE} (got: ${key})`,
    );
  }
  if (key.split("/").includes("..") || key.startsWith("/")) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_INVALID_ARTIFACT_KEY",
      `Artifact key may not contain '..' or be absolute (got: ${key})`,
    );
  }
  return key;
}

export async function getFeatureArtifact(
  featureId: string,
  key: string,
): Promise<FeatureArtifactDto | null> {
  assertKey(key);
  const row = await prisma.specKitFeatureArtifact.findUnique({
    where: { featureId_key: { featureId, key } },
  });
  return row ? toDto(row) : null;
}

export async function listFeatureArtifacts(featureId: string): Promise<FeatureArtifactDto[]> {
  const rows = await prisma.specKitFeatureArtifact.findMany({
    where: { featureId },
    orderBy: { key: "asc" },
  });
  return rows.map(toDto);
}

export interface WriteFeatureArtifactInput {
  featureId: string;
  key: string;
  content: string;
  actorId?: string | null;
}

/**
 * Every check {@link writeFeatureArtifact} makes before it touches the database
 * (key shape, content type, size cap). Exported so a command that writes
 * several artifacts can refuse the whole set before writing the first one.
 * Returns the validated key.
 */
export function assertFeatureArtifactWritable(key: string, content: unknown): string {
  const valid = assertKey(key);
  if (typeof content !== "string") {
    throw new SpecKitArtifactError(400, "SPECKIT_INVALID_CONTENT", "Content must be a string");
  }
  if (content.length > 200_000) {
    throw new SpecKitArtifactError(
      413,
      "SPECKIT_CONTENT_TOO_LARGE",
      "Spec Kit artifacts are capped at 200,000 characters",
    );
  }
  return valid;
}

export async function writeFeatureArtifact(
  input: WriteFeatureArtifactInput,
): Promise<FeatureArtifactDto> {
  const key = assertFeatureArtifactWritable(input.key, input.content);
  // #1059 — inside a job this is the gate every write passes: the job's row
  // must still be its own in the DATABASE (not cancelled, timed out or failed
  // by another replica), or this throws and nothing is written.
  await specKitJobCommitPoint();
  const existing = await prisma.specKitFeatureArtifact.findUnique({
    where: { featureId_key: { featureId: input.featureId, key } },
  });
  let row: FeatureArtifactRow;
  if (!existing) {
    row = await prisma.specKitFeatureArtifact.create({
      data: {
        featureId: input.featureId,
        key,
        content: input.content,
        version: 1,
        updatedById: input.actorId ?? null,
      },
    });
  } else {
    row = await prisma.specKitFeatureArtifact.update({
      where: { id: existing.id },
      data: {
        content: input.content,
        version: existing.version + 1,
        updatedById: input.actorId ?? null,
      },
    });
  }
  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "speckit.feature_artifact.written",
    target: { type: "speckit_feature_artifact", id: row.id },
    metadata: { featureId: input.featureId, key, version: row.version },
  });
  return toDto(row);
}

export async function deleteFeatureArtifact(
  featureId: string,
  key: string,
  actorId?: string | null,
): Promise<void> {
  assertKey(key);
  const existing = await prisma.specKitFeatureArtifact.findUnique({
    where: { featureId_key: { featureId, key } },
  });
  if (!existing) return;
  await prisma.specKitFeatureArtifact.delete({ where: { id: existing.id } });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "speckit.feature_artifact.deleted",
    target: { type: "speckit_feature_artifact", id: existing.id },
    metadata: { featureId, key },
  });
}
