/**
 * Epic #728 — Collaboration API client (comments, assignments).
 */
import { apiFetch } from "@/lib/api-client";

// ---- Types ------------------------------------------------------------------

export interface CommentAuthor {
  id: string;
  username: string;
  displayName: string;
}

export interface CommentItem {
  id: string;
  threadId: string;
  authorId: string;
  author: CommentAuthor | null;
  body: string | null;
  deleted: boolean;
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommentThread {
  id: string;
  requirementId?: string | null;
  specKitProjectId?: string | null;
  specKitArtifactName?: string | null;
  title: string | null;
  resolved: boolean;
  comments: CommentItem[];
  createdAt: string;
  updatedAt: string;
}

export interface Assignment {
  id: string;
  requirementId: string;
  assigneeId: string;
  assignedById: string;
  assignee: CommentAuthor;
  assignedBy: CommentAuthor;
  slaDeadline: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- API --------------------------------------------------------------------

// NOTE: `apiFetch` already unwraps the `{ success, data }` server envelope and
// returns `payload.data` directly (see api-client.ts). Therefore every call
// below MUST be typed as the *payload* type (e.g. `CommentThread[]`) and return
// the result as-is. Typing as `{ data: T }` + returning `data.data` double-
// unwraps to `undefined`, which crashes React Query ("data cannot be undefined")
// and silently hides comments/assignments (issue #281).

export const commentApi = {
  /** List comment threads for a requirement. */
  async listForRequirement(requirementId: string): Promise<CommentThread[]> {
    return apiFetch<CommentThread[]>(`/requirements/${requirementId}/comments`);
  },

  /** Create a new thread (+ first comment) on a requirement. */
  async createForRequirement(
    requirementId: string,
    payload: { title?: string; body: string },
  ): Promise<CommentThread> {
    return apiFetch<CommentThread>(`/requirements/${requirementId}/comments`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** List comment threads for a Spec Kit artifact. */
  async listForArtifact(projectId: string, artifactName: string): Promise<CommentThread[]> {
    return apiFetch<CommentThread[]>(
      `/projects/${projectId}/spec-kit/artifacts/${encodeURIComponent(artifactName)}/comments`,
    );
  },

  /** Create a new thread on a Spec Kit artifact. */
  async createForArtifact(
    projectId: string,
    artifactName: string,
    payload: { title?: string; body: string },
  ): Promise<CommentThread> {
    return apiFetch<CommentThread>(
      `/projects/${projectId}/spec-kit/artifacts/${encodeURIComponent(artifactName)}/comments`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  },

  /** Reply in an existing thread. */
  async reply(threadId: string, body: string): Promise<CommentItem> {
    return apiFetch<CommentItem>(`/comments/${threadId}/replies`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },

  /** Edit own comment. */
  async edit(commentId: string, body: string): Promise<CommentItem> {
    return apiFetch<CommentItem>(`/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ body }),
    });
  },

  /** Soft-delete own comment. */
  async delete(commentId: string): Promise<void> {
    await apiFetch<void>(`/comments/${commentId}`, { method: "DELETE" });
  },
};

export const assignmentApi = {
  /** List assignments for a requirement. */
  async list(requirementId: string): Promise<Assignment[]> {
    return apiFetch<Assignment[]>(`/requirements/${requirementId}/assignments`);
  },

  /** Assign a user to a requirement. */
  async assign(
    requirementId: string,
    payload: { assigneeId: string; slaDeadline?: string | null },
  ): Promise<Assignment> {
    return apiFetch<Assignment>(`/requirements/${requirementId}/assignments`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  /** Remove an assignment. */
  async unassign(requirementId: string, assigneeId: string): Promise<void> {
    await apiFetch<void>(`/requirements/${requirementId}/assignments/${assigneeId}`, {
      method: "DELETE",
    });
  },
};

export const requirementUpdateApi = {
  /** Update a requirement with optimistic-lock version. */
  async update(
    requirementId: string,
    patch: Record<string, unknown>,
  ): Promise<{ id: string; version: number; updatedAt: string }> {
    return apiFetch<{ id: string; version: number; updatedAt: string }>(
      `/requirements/${requirementId}`,
      {
        method: "PUT",
        body: JSON.stringify(patch),
      },
    );
  },
};
