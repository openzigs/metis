/**
 * Tests for the projects-api wrapper. Validates URL building, body shape,
 * and the upload helper's FormData round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { documentsApi, knowledgeApi, projectsApi } from "@/lib/projects-api";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("projectsApi", () => {
  it("list -> GET /api/projects", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0, limit: 25, offset: 0 }));
    await projectsApi.list();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/projects");
  });

  it("create -> POST with JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "proj_aaaa1" }));
    await projectsApi.create({ name: "A", slug: "a" });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "A", slug: "a" }));
  });

  it("archive -> POST /api/projects/:id/archive", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "archived" }));
    await projectsApi.archive("proj_aaaa1");
    expect(fetchMock.mock.calls[0][0]).toContain("/projects/proj_aaaa1/archive");
  });

  it("remove -> DELETE", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await projectsApi.remove("proj_aaaa1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });

  it("update -> PATCH with JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "proj_aaaa1", name: "B" }));
    await projectsApi.update("proj_aaaa1", { name: "B" });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
  });
});

describe("documentsApi.upload", () => {
  it("posts FormData to the project's documents endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ document: { id: "doc_aaaa1" }, ingest: { status: "ready", chunkCount: 1 } }),
    );
    const file = new File([new Uint8Array([1, 2, 3])], "n.md", { type: "text/markdown" });
    const result = await documentsApi.upload("proj_aaaa1", file);
    expect(result.document.id).toBe("doc_aaaa1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/projects/proj_aaaa1/documents");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("throws ApiError on 4xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: { code: "FILE_TOO_LARGE", message: "too big" } }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      ),
    );
    const file = new File([new Uint8Array([1])], "n.md", { type: "text/markdown" });
    await expect(documentsApi.upload("proj_aaaa1", file)).rejects.toMatchObject({
      status: 413,
      code: "FILE_TOO_LARGE",
    });
  });
});

describe("knowledgeApi.search", () => {
  it("posts query + k to the project's retrieve endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hits: [] }));
    await knowledgeApi.search("proj_aaaa1", { query: "test", k: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/projects/proj_aaaa1/retrieve");
    expect(init.body).toBe(JSON.stringify({ query: "test", k: 3 }));
  });
});
