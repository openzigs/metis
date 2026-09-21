/**
 * GitHub Projects v2 publishing — Epic #163, Issue #108.
 *
 * Wraps the two GraphQL mutations the publisher needs:
 *
 *   addProjectV2ItemById(projectId, contentId)        → projectItemId
 *   updateProjectV2ItemFieldValue(projectId, itemId, fieldId, value)
 *
 * Plus a board lister for the field-mapping wizard:
 *
 *   listProjectsV2(viewerLogin)                       → boards visible to PAT
 *
 * GraphQL is invoked through the existing `client.request<T>` adapter
 * exposed by `octokit-factory` so we reuse the rate-limiter, redactor, and
 * IP pinning. Failures NEVER roll back the underlying issue (per AC #3) —
 * they are recorded and returned to the caller for surfacing in the publish
 * history.
 */
import type { PublishOctokitLike } from "./types.js";

export interface ProjectsV2Board {
  id: string;
  number: number;
  title: string;
  url: string;
}

export interface ProjectV2FieldMapping {
  /** GraphQL field id (`PVTF_xxx`). */
  fieldId: string;
  /** One of: text | number | date | single_select. */
  type: "text" | "number" | "date" | "single_select";
  /** For text/number/date: literal value. For single_select: option id. */
  value: string | number;
}

export type ProjectV2FieldMappings = Record<string, ProjectV2FieldMapping>;

export interface AddItemResult {
  projectItemId: string;
}

export interface FieldUpdateResult {
  fieldId: string;
  ok: boolean;
  error?: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface AddItemData {
  addProjectV2ItemById: { item: { id: string } };
}

interface UpdateFieldData {
  updateProjectV2ItemFieldValue: { projectV2Item: { id: string } };
}

interface ListProjectsData {
  viewer: {
    projectsV2: {
      nodes: Array<{ id: string; number: number; title: string; url: string }>;
    };
  };
}

const ADD_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

const UPDATE_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }
    ) {
      projectV2Item { id }
    }
  }
`;

const LIST_BOARDS_QUERY = `
  query {
    viewer {
      projectsV2(first: 50) {
        nodes { id number title url }
      }
    }
  }
`;

/** Add an issue to a Projects v2 board. */
export async function addProjectItem(
  client: PublishOctokitLike,
  args: { projectId: string; contentId: string },
): Promise<AddItemResult> {
  const res = await graphqlRequest<AddItemData>(client, ADD_ITEM_MUTATION, args);
  if (res.errors?.length) {
    throw new Error(`addProjectV2ItemById failed: ${res.errors[0].message}`);
  }
  if (!res.data?.addProjectV2ItemById?.item?.id) {
    throw new Error("addProjectV2ItemById returned no item id");
  }
  return { projectItemId: res.data.addProjectV2ItemById.item.id };
}

/**
 * Apply each field mapping. Errors are collected — one bad field does not
 * block the others. Caller decides what to do with the result list.
 */
export async function applyFieldMappings(
  client: PublishOctokitLike,
  args: {
    projectId: string;
    itemId: string;
    mappings: ProjectV2FieldMappings;
  },
): Promise<FieldUpdateResult[]> {
  const out: FieldUpdateResult[] = [];
  for (const mapping of Object.values(args.mappings)) {
    try {
      const value = encodeFieldValue(mapping);
      const res = await graphqlRequest<UpdateFieldData>(client, UPDATE_FIELD_MUTATION, {
        projectId: args.projectId,
        itemId: args.itemId,
        fieldId: mapping.fieldId,
        value,
      });
      if (res.errors?.length) {
        out.push({ fieldId: mapping.fieldId, ok: false, error: res.errors[0].message });
      } else {
        out.push({ fieldId: mapping.fieldId, ok: true });
      }
    } catch (err) {
      out.push({
        fieldId: mapping.fieldId,
        ok: false,
        error: (err as Error).message ?? "unknown",
      });
    }
  }
  return out;
}

/** List Projects v2 boards visible to the configured PAT. */
export async function listProjectsV2(client: PublishOctokitLike): Promise<ProjectsV2Board[]> {
  const res = await graphqlRequest<ListProjectsData>(client, LIST_BOARDS_QUERY, {});
  if (res.errors?.length) {
    throw new Error(`listProjectsV2 failed: ${res.errors[0].message}`);
  }
  const nodes = res.data?.viewer?.projectsV2?.nodes ?? [];
  return nodes.map((n) => ({ id: n.id, number: n.number, title: n.title, url: n.url }));
}

// ---- Helpers ---------------------------------------------------------------

export function encodeFieldValue(mapping: ProjectV2FieldMapping): Record<string, unknown> {
  switch (mapping.type) {
    case "text":
      return { text: String(mapping.value) };
    case "number":
      return { number: Number(mapping.value) };
    case "date":
      return { date: String(mapping.value) };
    case "single_select":
      return { singleSelectOptionId: String(mapping.value) };
    default:
      throw new Error(`unsupported field type: ${(mapping as { type: string }).type}`);
  }
}

/**
 * Parse the `Project.githubProjectFieldMappings` JSON column into the
 * strongly typed shape the publisher uses. Returns null when unset/empty.
 */
export function parseFieldMappings(raw: string | null | undefined): ProjectV2FieldMappings | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ProjectV2FieldMappings = {};
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== "object") continue;
      const v = val as Record<string, unknown>;
      const fieldId = typeof v.fieldId === "string" ? v.fieldId : null;
      const type = typeof v.type === "string" ? (v.type as ProjectV2FieldMapping["type"]) : null;
      const value = v.value as string | number | undefined;
      if (!fieldId || !type || (typeof value !== "string" && typeof value !== "number")) {
        continue;
      }
      if (!["text", "number", "date", "single_select"].includes(type)) continue;
      out[key] = { fieldId, type, value };
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function graphqlRequest<T>(
  client: PublishOctokitLike,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphQLResponse<T>> {
  const res = await client.request<GraphQLResponse<T>>({
    method: "POST",
    url: "/graphql",
    data: { query, variables },
  });
  return res.data;
}
