/**
 * Spec Kit Mode API client (Epic #193).
 *
 * Wraps the `/api/projects/:id/spec-kit/*` endpoints with the same
 * `apiFetch` helper used by every other UI surface so the 401-refresh
 * dance works automatically.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  SpecKitArtifactDto,
  SpecKitArtifactName,
  SpecKitNamespacedCommand,
} from "@metis/shared";

export interface SpecKitFilesResponse {
  enabled: boolean;
  artifacts: SpecKitArtifactDto[];
}

/** #789 — a Spec Kit feature (`specs/<slug>/`), as `GET /features` returns it. */
export interface SpecKitFeature {
  id: string;
  slug: string;
  title: string;
  /** `draft` … `archived`. */
  status: string;
  branchName: string | null;
  updatedAt: string;
}

/** #789 — one artifact under `specs/<slug>/` (`key` may be nested: `contracts/…`). */
export interface SpecKitFeatureArtifact {
  id: string;
  key: string;
  content: string;
  version: number;
  updatedAt: string;
}

/** #789 — `GET /features/:slug/status`: which phase gates the feature has met. */
export interface SpecKitFeatureStatus {
  slug: string;
  specGate: boolean;
  planGate: boolean;
  tasksGate: boolean;
  implementGate: boolean;
  lastUpdated: string;
}

/** Body fields a `speckit.*` command accepts besides `input`. */
export interface SpecKitRunOptions {
  input?: string;
  featureSlug?: string;
  mode?: "merge" | "overwrite";
  dryRun?: boolean;
  /** `speckit.taskstoissues` (#953): the `${vault:label}` GitHub token — never a raw token. */
  secretRef?: string;
  /** `speckit.taskstoissues` (#953): the dry run a live export must reproduce. */
  expectedPlan?: { tasksVersion: number; digest: string };
  /** `speckit.taskstoissues` (#962): "Clear stuck export" instead of an export. */
  clearStuckClaims?: true;
}

/**
 * The union of what the `speckit.*` commands return. Every command carries a
 * `message`; the rest depends on the command: `artifactName` for
 * tasks/clarify/analyze (the feature key when run in a feature),
 * `speckit.specify`'s new `feature`, `speckit.plan`'s and
 * `speckit.checklist`'s `artifacts`, `speckit.implement`'s handoff as
 * `artifact: { context, orchestratorRoute }`, `speckit.taskstoissues`'s `created`.
 */
export interface SpecKitCommandResult {
  message: string;
  artifactName?: SpecKitArtifactName | null;
  artifact?:
    SpecKitArtifactDto | { key: string } | { context: string[]; orchestratorRoute: string } | null;
  artifacts?: Array<{ key: string }>;
  feature?: SpecKitFeature;
  featureSlug?: string;
  count?: number;
  /** `speckit.taskstoissues`: one row per task; `title` is the planned or created issue title. */
  created?: Array<{
    taskId: string;
    title?: string;
    issueNumber: number;
    url: string;
    /** True when the task was already exported: a run creates no issue for it. */
    upserted?: boolean;
    /**
     * #962 — `new` (would create), `exported`, `in_progress` (another export
     * holds it), `reconcile` (an abandoned export's claim: looked up on GitHub
     * first), or `adopted` (found there by a live run).
     */
    state?: "new" | "exported" | "in_progress" | "reconcile" | "adopted";
  }>;
  /** "Clear stuck export" (#962): claims deleted, issues recorded, claims still live. */
  cleared?: string[];
  adopted?: Array<{ taskId: string; issueNumber: number; url: string }>;
  inProgress?: string[];
  /** `speckit.taskstoissues`: the resolved target repository. */
  repo?: { owner: string; name: string };
  /** `speckit.taskstoissues` (#936): whether a non-dry run would reach a real issue client. */
  publishAvailable?: boolean;
  /** `speckit.taskstoissues` (#953): the `tasks.md` version the run read. */
  tasksVersion?: number;
  /** `speckit.taskstoissues` (#953): the dry run's plan, which Publish sends back. */
  planDigest?: string;
  /** `speckit.taskstoissues` dry run (#953): whether the vault secret binds. */
  credentialCheck?: "resolved" | "missing" | "unresolved";
  tokensUsed?: number;
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
  ): Promise<{
    artifact: SpecKitArtifactDto | null;
    contentLength: number;
    /** #788 — true when derived from project knowledge, false for the skeleton. */
    grounded?: boolean;
    /** #788 — what was written, and why only a skeleton when that is the case. */
    message?: string;
    /** #788 — semver metadata of the tracked constitution; null for the skeleton. */
    meta?: { version: string; ratifiedAt: string | null; lastAmendedAt: string | null } | null;
  }> {
    return apiFetch(`/projects/${encodeURIComponent(projectId)}/spec-kit/constitution`, {
      method: "POST",
      body: projectOverrides ? { projectOverrides } : {},
    });
  },
  /** #789 — always the canonical `speckit.*` route (no `Deprecation` alias). */
  runCommand(
    projectId: string,
    command: SpecKitNamespacedCommand,
    options: SpecKitRunOptions = {},
  ): Promise<SpecKitCommandResult> {
    const { input = "", ...rest } = options;
    return apiFetch(
      `/projects/${encodeURIComponent(projectId)}/spec-kit/commands/${encodeURIComponent(command)}`,
      { method: "POST", body: { input, ...rest } },
    );
  },
  listFeatures(
    projectId: string,
    includeArchived: boolean,
  ): Promise<{ features: SpecKitFeature[] }> {
    return apiFetch(`${featuresBase(projectId)}${includeArchived ? "?includeArchived=true" : ""}`);
  },
  listFeatureArtifacts(
    projectId: string,
    slug: string,
  ): Promise<{ feature: SpecKitFeature; artifacts: SpecKitFeatureArtifact[] }> {
    return apiFetch(`${featuresBase(projectId)}/${encodeURIComponent(slug)}/artifacts`);
  },
  featureStatus(projectId: string, slug: string): Promise<SpecKitFeatureStatus> {
    return apiFetch(`${featuresBase(projectId)}/${encodeURIComponent(slug)}/status`);
  },
  archiveFeature(projectId: string, slug: string): Promise<{ feature: SpecKitFeature }> {
    return apiFetch(`${featuresBase(projectId)}/${encodeURIComponent(slug)}/archive`, {
      method: "POST",
    });
  },
  restoreFeature(projectId: string, slug: string): Promise<{ feature: SpecKitFeature }> {
    return apiFetch(`${featuresBase(projectId)}/${encodeURIComponent(slug)}/restore`, {
      method: "POST",
      body: {},
    });
  },
  deleteFeatureArtifact(projectId: string, slug: string, key: string): Promise<void> {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return apiFetch(`${featuresBase(projectId)}/${encodeURIComponent(slug)}/artifacts/${path}`, {
      method: "DELETE",
    });
  },
};

function featuresBase(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/spec-kit/features`;
}
