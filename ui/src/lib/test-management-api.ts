/**
 * Typed wrappers around the `/api/test-management/connections` REST surface
 * (Epic #856 / Issue #871 — UI follow-up).
 *
 * Mirrors `jira-api.ts`. Plaintext credentials are sent to the server on
 * create/update only; responses contain redacted vault refs.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  CreateTestManagementConnectionInput,
  UpdateTestManagementConnectionInput,
  TestManagementConnectionDetail,
  TestManagementTestResult,
} from "@metis/shared";

type Id = string;

const base = (id?: Id) => `/test-management/connections${id ? `/${id}` : ""}`;

export const testManagementApi = {
  list: (projectId: Id) =>
    apiFetch<TestManagementConnectionDetail[]>(
      `${base()}?projectId=${encodeURIComponent(projectId)}`,
    ),

  get: (id: Id) => apiFetch<TestManagementConnectionDetail>(base(id)),

  create: (projectId: Id, body: CreateTestManagementConnectionInput) =>
    apiFetch<TestManagementConnectionDetail>(
      `${base()}?projectId=${encodeURIComponent(projectId)}`,
      {
        method: "POST",
        body,
      },
    ),

  update: (id: Id, body: UpdateTestManagementConnectionInput) =>
    apiFetch<TestManagementConnectionDetail>(base(id), { method: "PATCH", body }),

  remove: (id: Id) => apiFetch<void>(base(id), { method: "DELETE" }),

  test: (id: Id) => apiFetch<TestManagementTestResult>(`${base(id)}/test`, { method: "POST" }),
};
