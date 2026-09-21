/**
 * Project-creation helper for the UI Information-Architecture suite (#133).
 *
 * Creating a project via the API (rather than the create dialog) gives every
 * spec a deterministic, isolated `projectId` to navigate against without
 * coupling the test to the create-project UI. Mirrors the contract used by
 * project-settings.spec.ts.
 */
import { request, type APIRequestContext } from "@playwright/test";

export interface CreatedProject {
  id: string;
  slug: string;
  name: string;
}

/**
 * Create a project through `POST /api/projects` using a bearer token from
 * {@link primeAdminUser}. Returns the new project's id + slug.
 */
export async function createProjectViaApi(
  apiBaseUrl: string,
  token: string,
  prefix = "e2e-ia",
): Promise<CreatedProject> {
  const slug = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  const name = `IA Test ${slug}`;
  const ctx: APIRequestContext = await request.newContext({
    baseURL: apiBaseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  try {
    const res = await ctx.post("/api/projects", {
      data: { name, slug, description: "UI IA overhaul e2e fixture" },
    });
    if (res.status() !== 201) {
      throw new Error(`createProjectViaApi failed (status ${res.status()}): ${await res.text()}`);
    }
    // The create endpoint returns the project under `data` (newer shape) or
    // `data.project` (older shape) depending on server version — accept both.
    const body = (await res.json()) as { data?: { id?: string; project?: { id?: string } } };
    const id = body.data?.id ?? body.data?.project?.id;
    if (!id) throw new Error(`createProjectViaApi: malformed response ${JSON.stringify(body)}`);
    return { id, slug, name };
  } finally {
    await ctx.dispose();
  }
}
