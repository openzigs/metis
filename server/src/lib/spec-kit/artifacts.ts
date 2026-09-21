/**
 * Spec Kit `.specify/` artifact service (Epic #193).
 *
 * v1.2 stores artifact content in the `spec_kit_artifacts` table. Projects
 * with an attached working repo can mirror the same content to a real
 * `.specify/` directory in a future iteration; the DB row is the
 * authoritative source for both surfaces.
 */
import {
  isSpecKitArtifactName,
  type SpecKitArtifactDto,
  type SpecKitArtifactName,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";

export class SpecKitArtifactError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "SpecKitArtifactError";
    this.status = status;
    this.code = code;
  }
}

interface ArtifactRow {
  id: string;
  projectId: string;
  name: string;
  content: string;
  version: number;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: ArtifactRow): SpecKitArtifactDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name as SpecKitArtifactName,
    content: row.content,
    version: row.version,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertName(name: string): SpecKitArtifactName {
  if (!isSpecKitArtifactName(name)) {
    throw new SpecKitArtifactError(
      400,
      "SPEC_KIT_INVALID_NAME",
      `Unknown Spec Kit artifact: ${name}`,
    );
  }
  return name;
}

export interface SpecKitArtifactStore {
  list(projectId: string): Promise<SpecKitArtifactDto[]>;
  get(projectId: string, name: string): Promise<SpecKitArtifactDto | null>;
  write(input: WriteArtifactInput): Promise<SpecKitArtifactDto>;
  delete(projectId: string, name: string, actorId?: string): Promise<void>;
}

export interface WriteArtifactInput {
  projectId: string;
  name: string;
  content: string;
  actorId?: string | null;
}

export async function listArtifacts(projectId: string): Promise<SpecKitArtifactDto[]> {
  const rows = await prisma.specKitArtifact.findMany({
    where: { projectId },
    orderBy: { name: "asc" },
  });
  return rows.map(toDto);
}

export async function getArtifact(
  projectId: string,
  name: string,
): Promise<SpecKitArtifactDto | null> {
  assertName(name);
  const row = await prisma.specKitArtifact.findUnique({
    where: { projectId_name: { projectId, name } },
  });
  return row ? toDto(row) : null;
}

export async function writeArtifact(input: WriteArtifactInput): Promise<SpecKitArtifactDto> {
  const name = assertName(input.name);
  if (typeof input.content !== "string") {
    throw new SpecKitArtifactError(400, "SPEC_KIT_INVALID_CONTENT", "Content must be a string");
  }
  if (input.content.length > 200_000) {
    throw new SpecKitArtifactError(
      413,
      "SPEC_KIT_CONTENT_TOO_LARGE",
      "Spec Kit artifacts are capped at 200,000 characters",
    );
  }
  const existing = await prisma.specKitArtifact.findUnique({
    where: { projectId_name: { projectId: input.projectId, name } },
  });
  let row: ArtifactRow;
  if (!existing) {
    row = await prisma.specKitArtifact.create({
      data: {
        projectId: input.projectId,
        name,
        content: input.content,
        version: 1,
        updatedById: input.actorId ?? null,
      },
    });
  } else {
    row = await prisma.specKitArtifact.update({
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
    action: "spec_kit.artifact.written",
    target: { type: "spec_kit_artifact", id: row.id },
    metadata: { projectId: input.projectId, name, version: row.version },
  });
  return toDto(row);
}

export async function deleteArtifact(
  projectId: string,
  name: string,
  actorId?: string,
): Promise<void> {
  assertName(name);
  const existing = await prisma.specKitArtifact.findUnique({
    where: { projectId_name: { projectId, name } },
  });
  if (!existing) return;
  await prisma.specKitArtifact.delete({ where: { id: existing.id } });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "spec_kit.artifact.deleted",
    target: { type: "spec_kit_artifact", id: existing.id },
    metadata: { projectId, name },
  });
}

/** Returns the project's `specKitEnabled` flag. Throws 404 when the project is missing. */
export async function isSpecKitEnabled(projectId: string): Promise<boolean> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { specKitEnabled: true },
  });
  if (!row) {
    throw new SpecKitArtifactError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }
  return row.specKitEnabled;
}

/** Update the `Project.specKitEnabled` flag, returning the new value. */
export async function setSpecKitEnabled(
  projectId: string,
  enabled: boolean,
  actorId?: string,
): Promise<boolean> {
  const row = await prisma.project.update({
    where: { id: projectId },
    data: { specKitEnabled: enabled },
    select: { specKitEnabled: true },
  });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: enabled ? "spec_kit.enabled" : "spec_kit.disabled",
    target: { type: "project", id: projectId },
  });
  return row.specKitEnabled;
}
