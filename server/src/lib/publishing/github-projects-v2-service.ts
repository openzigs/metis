/**
 * GitHub Projects v2 settings — Epic #163, Issue #108.
 *
 * Per-project board id + field mapping persistence. Listing visible boards
 * for the field-mapping wizard is also handled here so the routes stay
 * thin.
 */
import { audit } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";
import { acquirePublishOctokit, rateLimitConfigFromEnv } from "./octokit-factory.js";
import { listProjectsV2, parseFieldMappings, type ProjectsV2Board } from "./projects-v2.js";
import { resolveVaultRef } from "../connectors/vault-resolver.js";
import { getVaultService } from "../vault/vault-service.js";
import { resolvePublishTarget } from "./host-allowlist.js";
import { PublishError } from "./types.js";

export interface GitHubProjectV2Settings {
  githubProjectId: string | null;
  fieldMappings: ReturnType<typeof parseFieldMappings>;
}

export async function getGitHubProjectV2Settings(
  projectId: string,
): Promise<GitHubProjectV2Settings> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { githubProjectId: true, githubProjectFieldMappings: true },
  });
  if (!row) throw new PublishError(404, "PROJECT_NOT_FOUND", "project not found");
  return {
    githubProjectId: row.githubProjectId ?? null,
    fieldMappings: parseFieldMappings(row.githubProjectFieldMappings),
  };
}

export interface UpdateGitHubProjectV2Input {
  githubProjectId: string | null;
  /** Pass `null` to clear; otherwise an object that will be JSON-serialized. */
  fieldMappings: Record<string, unknown> | null;
}

export async function updateGitHubProjectV2Settings(
  projectId: string,
  input: UpdateGitHubProjectV2Input,
  actorId: string,
): Promise<GitHubProjectV2Settings> {
  const existing = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!existing) throw new PublishError(404, "PROJECT_NOT_FOUND", "project not found");
  const fieldsRaw = input.fieldMappings ? JSON.stringify(input.fieldMappings) : null;
  await prisma.project.update({
    where: { id: projectId },
    data: {
      githubProjectId: input.githubProjectId ?? null,
      githubProjectFieldMappings: fieldsRaw,
    },
  });
  audit({
    actor: { id: actorId },
    action: "project.github_projects_v2.update",
    target: { type: "project", id: projectId },
    metadata: {
      githubProjectId: input.githubProjectId ?? null,
      fieldsCount: input.fieldMappings ? Object.keys(input.fieldMappings).length : 0,
    },
  });
  return getGitHubProjectV2Settings(projectId);
}

export interface ListBoardsInput {
  /** Vault ref for the GitHub PAT. */
  secretRef: string;
  /** Owner whose host pinning + base URL we should use. Defaults to api.github.com. */
  targetOwner: string;
  targetRepo?: string;
  targetBaseUrl?: string | null;
}

export async function listGitHubProjectsV2Boards(
  input: ListBoardsInput,
): Promise<ProjectsV2Board[]> {
  const target = await resolvePublishTarget({
    owner: input.targetOwner,
    repo: input.targetRepo ?? "ignored",
    baseUrl: input.targetBaseUrl ?? null,
  });
  const token = await resolveVaultRef(input.secretRef, getVaultService());
  if (!token) {
    throw new PublishError(400, "TOKEN_REQUIRED", "vault returned no token");
  }
  const client = await acquirePublishOctokit({
    owner: target.owner,
    baseUrl: target.baseUrl,
    token,
    pinnedAddress: target.pinnedAddress,
    pinnedFamily: target.pinnedFamily,
    rateLimit: rateLimitConfigFromEnv(),
  });
  return listProjectsV2(client);
}
