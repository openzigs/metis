/**
 * Typed wrappers around the workspace governing-document routes — Epic #1866
 * (#1869 store, #1870 rules, #1871 this page).
 *
 * The wire shapes are `@metis/shared`'s (`packages/shared/src/governing.ts`);
 * the routes are `server/src/routes/governing-documents.ts`, which adds
 * `isCurrent` to each revision. Every route answers 404 while
 * `GOVERNING_DOCS_ENABLED` is off, so a 404 from the list means "hide the page".
 *
 * `apiFetch` JSON-encodes its body, so the two multipart uploads make their own
 * `fetch` against the same Next.js proxy, like `documentsApi.upload`.
 */
import { useQuery } from "@tanstack/react-query";
import type { GoverningDocument, GoverningDocumentRevision, GoverningRule } from "@metis/shared";
import { ApiError, apiErrorMessage, apiFetch } from "@/lib/api-client";
import { API_BASE } from "@/lib/config";

export type { GoverningRule };

/** A revision as the routes send it: the stored shape plus whether it is current. */
export type GoverningRevision = GoverningDocumentRevision & { isCurrent: boolean };

export interface GoverningDocumentListItem extends GoverningDocument {
  currentRevision: GoverningRevision | null;
}

export interface GoverningDocumentDetail extends GoverningDocument {
  revisions: GoverningRevision[];
}

export interface GoverningRuleListing {
  documentId: string;
  revision: Pick<
    GoverningRevision,
    | "id"
    | "revisionLabel"
    | "extractionState"
    | "extractionError"
    | "droppedUnverified"
    | "isCurrent"
  >;
  rules: GoverningRule[];
}

export interface UploadedRevision {
  documentId: string;
  revisionId: string;
}

export interface GoverningUploadInput {
  file: File;
  title: string;
  revisionLabel: string;
  effectiveDate: string;
  framework?: string;
}

export interface GoverningRevisionInput {
  file: File;
  revisionLabel: string;
  effectiveDate: string;
}

export type GoverningRulePatch = { summary?: string; controlId?: string } | { deleted: true };

const base = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/governing-documents`;

/** POST a multipart form to the proxy and unwrap the `{ success, data, error }` envelope. */
async function postMultipart<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  const text = await res.text();
  let payload:
    { success?: boolean; data?: unknown; error?: { code?: string; message?: string } } | undefined;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  if (!res.ok || payload?.success === false) {
    throw new ApiError(
      res.status,
      apiErrorMessage(payload?.error, res.statusText || "Upload failed"),
      payload?.error?.code,
    );
  }
  return payload?.data as T;
}

export const governingApi = {
  list: (workspaceId: string) =>
    apiFetch<{ documents: GoverningDocumentListItem[] }>(base(workspaceId)),

  get: (workspaceId: string, documentId: string) =>
    apiFetch<{ document: GoverningDocumentDetail }>(
      `${base(workspaceId)}/${encodeURIComponent(documentId)}`,
    ),

  rules: (workspaceId: string, documentId: string, revisionId?: string) =>
    apiFetch<GoverningRuleListing>(`${base(workspaceId)}/${encodeURIComponent(documentId)}/rules`, {
      params: { revisionId },
    }),

  upload: (workspaceId: string, input: GoverningUploadInput) => {
    const form = new FormData();
    form.append("file", input.file);
    form.append("title", input.title);
    form.append("revisionLabel", input.revisionLabel);
    form.append("effectiveDate", input.effectiveDate);
    if (input.framework) form.append("framework", input.framework);
    return postMultipart<UploadedRevision>(base(workspaceId), form);
  },

  addRevision: (workspaceId: string, documentId: string, input: GoverningRevisionInput) => {
    const form = new FormData();
    form.append("file", input.file);
    form.append("revisionLabel", input.revisionLabel);
    form.append("effectiveDate", input.effectiveDate);
    return postMultipart<UploadedRevision>(
      `${base(workspaceId)}/${encodeURIComponent(documentId)}/revisions`,
      form,
    );
  },

  retryExtraction: (workspaceId: string, documentId: string, revisionId: string) =>
    apiFetch<{ scheduled: true }>(
      `${base(workspaceId)}/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(
        revisionId,
      )}/rule-extraction`,
      { method: "POST" },
    ),

  editRule: (workspaceId: string, ruleId: string, patch: GoverningRulePatch) =>
    apiFetch<{ rule: GoverningRule; changed: boolean }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/governing-rules/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body: patch },
    ),
};

export const governingKeys = {
  all: (workspaceId: string) => ["governing", workspaceId] as const,
  list: (workspaceId: string) => [...governingKeys.all(workspaceId), "list"] as const,
  document: (workspaceId: string, documentId: string) =>
    [...governingKeys.all(workspaceId), "document", documentId] as const,
  /** Every revision's rules of one document: the prefix a settled extraction invalidates (#1996). */
  documentRules: (workspaceId: string, documentId: string) =>
    [...governingKeys.all(workspaceId), "rules", documentId] as const,
  rules: (workspaceId: string, documentId: string, revisionId?: string) =>
    [...governingKeys.documentRules(workspaceId, documentId), revisionId ?? "current"] as const,
};

/**
 * The page and its tab exist only when the list route answers: a 404 is the
 * flag off (or no such workspace for this user), so the tab stays hidden.
 */
export function isGoverningUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * #1871 — whether the workspace nav shows the Governing documents tab: only
 * once the list has answered. Loading, a 404 (flag off) and any other error
 * all leave it hidden. Shares the panel's list query, so it costs one request.
 */
export function useGoverningTabVisible(workspaceId: string): boolean {
  const list = useQuery({
    queryKey: governingKeys.list(workspaceId),
    queryFn: () => governingApi.list(workspaceId),
    enabled: workspaceId !== "",
  });
  return list.isSuccess;
}

/**
 * Who may upload, add a revision, retry an extraction and edit or remove a rule:
 * a workspace owner or admin, or a deployment admin (mirrors the server's
 * `requireWorkspaceRole("admin")`, which a deployment admin bypasses). The
 * server enforces it either way; this only decides which controls render.
 */
export function canManageGoverning(
  members: readonly { role: string; user: { id: string } }[] | undefined,
  user: { id: string; role: string } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const role = members?.find((m) => m.user.id === user.id)?.role;
  return role === "owner" || role === "admin";
}
