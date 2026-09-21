/**
 * Spec Kit Mode API client (Epic #193).
 *
 * Wraps the `/api/projects/:id/spec-kit/*` endpoints with the same
 * `apiFetch` helper used by every other UI surface so the 401-refresh
 * dance works automatically.
 */
import { apiFetch } from "@/lib/api-client";
import type { SpecKitArtifactDto, SpecKitArtifactName, SpecKitCommand } from "@metis/shared";

export interface SpecKitFilesResponse {
  enabled: boolean;
  artifacts: SpecKitArtifactDto[];
}

export interface SpecKitCommandResult {
  command: SpecKitCommand;
  artifactName: SpecKitArtifactName | null;
  artifact: SpecKitArtifactDto | { context: string[]; orchestratorRoute: string } | null;
  message: string;
  tokensUsed: number;
}

export const specKitApi = {
  getEnabled(projectId: string): Promise<{ enabled: boolean }> {
    return apiFetch(`/projects/${encodeURIComponent(projectId)}/spec-kit/enabled`);
  },
  setEnabled(projectId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    return apiFetch(`/projects/${encodeURIComponent(projectId)}/spec-kit/enabled`, {
      method: "PUT",
      body: { enabled },
    });
  },
  listFiles(projectId: string): Promise<SpecKitFilesResponse> {
    return apiFetch(`/projects/${encodeURIComponent(projectId)}/spec-kit/files`);
  },
  getFile(projectId: string, name: SpecKitArtifactName): Promise<{ artifact: SpecKitArtifactDto }> {
    return apiFetch(
      `/projects/${encodeURIComponent(projectId)}/spec-kit/files/${encodeURIComponent(name)}`,
    );
  },
  putFile(
    projectId: string,
    name: SpecKitArtifactName,
    content: string,
  ): Promise<{ artifact: SpecKitArtifactDto }> {
    return apiFetch(
      `/projects/${encodeURIComponent(projectId)}/spec-kit/files/${encodeURIComponent(name)}`,
      { method: "PUT", body: { content } },
    );
  },
  deleteFile(projectId: string, name: SpecKitArtifactName): Promise<void> {
    return apiFetch(
      `/projects/${encodeURIComponent(projectId)}/spec-kit/files/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  },
  generateConstitution(
    projectId: string,
    projectOverrides?: string,
  ): Promise<{ artifact: SpecKitArtifactDto | null; contentLength: number }> {
    return apiFetch(`/projects/${encodeURIComponent(projectId)}/spec-kit/constitution`, {
      method: "POST",
      body: projectOverrides ? { projectOverrides } : {},
    });
  },
  runCommand(
    projectId: string,
    command: SpecKitCommand,
    input: string,
  ): Promise<SpecKitCommandResult> {
    return apiFetch(
      `/projects/${encodeURIComponent(projectId)}/spec-kit/commands/${encodeURIComponent(command)}`,
      { method: "POST", body: { input } },
    );
  },
};
