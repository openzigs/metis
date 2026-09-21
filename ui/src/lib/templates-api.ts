/**
 * Templates API client — Epic #595 / Issue #614.
 */
import { apiFetch } from "@/lib/api-client";

export interface TemplateSectionData {
  key: string;
  label: string;
  type: "text" | "markdown" | "checklist" | "number" | "select" | "tags";
  required: boolean;
  validation?: Record<string, unknown>;
  defaultValue?: unknown;
  placeholder?: string;
}

export interface TemplateSchemaData {
  name: string;
  platform: "github" | "jira" | "universal";
  templateType: "epic" | "feature" | "story" | "bug" | "task";
  sections: TemplateSectionData[];
  platformFields?: Record<string, Record<string, string>>;
}

export interface TemplateData {
  id: string;
  projectId: string;
  name: string;
  platform: string;
  templateType: string;
  schema: string;
  defaultValues: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateInput {
  name: string;
  platform: "github" | "jira" | "universal";
  templateType: "epic" | "feature" | "story" | "bug" | "task";
  schema: TemplateSchemaData;
  defaultValues?: Record<string, unknown>;
}

export interface UpdateTemplateInput {
  name?: string;
  platform?: "github" | "jira" | "universal";
  templateType?: "epic" | "feature" | "story" | "bug" | "task";
  schema?: TemplateSchemaData;
  defaultValues?: Record<string, unknown>;
}

export const templatesApi = {
  list: (projectId: string) => apiFetch<TemplateData[]>(`/projects/${projectId}/templates`),

  get: (projectId: string, id: string) =>
    apiFetch<TemplateData>(`/projects/${projectId}/templates/${id}`),

  create: (projectId: string, body: CreateTemplateInput) =>
    apiFetch<TemplateData>(`/projects/${projectId}/templates`, {
      method: "POST",
      body,
    }),

  update: (projectId: string, id: string, body: UpdateTemplateInput) =>
    apiFetch<TemplateData>(`/projects/${projectId}/templates/${id}`, {
      method: "PUT",
      body,
    }),

  delete: (projectId: string, id: string) =>
    apiFetch<{ deleted: boolean }>(`/projects/${projectId}/templates/${id}`, {
      method: "DELETE",
    }),
};
