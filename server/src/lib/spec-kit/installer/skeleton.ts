/**
 * Epic #396 (MVP-7) — `.specify/` skeleton + `specs/<slug>/` materializer.
 *
 * Returns a list of `{relPath, content}` writes for the orchestrator to
 * apply. Pure — no filesystem I/O, no Prisma calls.
 */
import type { SpecKitFeatureDto } from "../features.js";
import type { FeatureArtifactDto } from "../feature-artifacts.js";
import { computeStatus, statusJsonBody, type FeatureStatus } from "../gates.js";
import { listFeatureArtifacts } from "../feature-artifacts.js";
import { METIS_INTERNAL_FEATURE_ARTIFACTS } from "../grounding.js";

export interface SkeletonFile {
  relPath: string;
  content: string;
}

export const SPECIFY_SKELETON: SkeletonFile[] = [
  {
    relPath: ".specify/memory/.gitkeep",
    content: "",
  },
  {
    relPath: ".specify/memory/_checklist.md",
    content: "# Checklist memory\n\nManaged by METIS — do not edit by hand.\n",
  },
  {
    relPath: ".specify/scripts/bash/.gitkeep",
    content: "",
  },
  {
    relPath: ".specify/scripts/powershell/.gitkeep",
    content: "",
  },
  {
    relPath: ".specify/templates/.gitkeep",
    content: "",
  },
];

export function constitutionFile(content: string): SkeletonFile {
  return { relPath: ".specify/memory/constitution.md", content };
}

export async function emitFeatureFiles(
  feature: SpecKitFeatureDto,
): Promise<{ files: SkeletonFile[]; status: FeatureStatus }> {
  const artifacts = await listFeatureArtifacts(feature.id);
  const status = await computeStatus(feature.id);
  const dir = `specs/${feature.slug}`;
  // #1060 — `plan-context.md` records what METIS's planner was given. It is not
  // a Spec Kit artifact and means nothing to the tools that read `specs/<slug>/`
  // in the target repository, so it stays in METIS.
  const files: SkeletonFile[] = artifacts
    .filter((a) => !METIS_INTERNAL_FEATURE_ARTIFACTS.has(a.key))
    .map((a) => ({
      relPath: `${dir}/${a.key}`,
      content: a.content,
    }));
  files.push({ relPath: `${dir}/status.json`, content: statusJsonBody(status) });
  return { files, status };
}

export function statusFile(slug: string, status: FeatureStatus): SkeletonFile {
  return { relPath: `specs/${slug}/status.json`, content: statusJsonBody(status) };
}

export function isStatusFileForArtifact(_artifact: FeatureArtifactDto): boolean {
  return true; // status.json is regenerated on every artifact mutation by the installer caller
}
