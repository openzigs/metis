/**
 * URL/payload coverage for the runs + AGENTS.md API wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runsApi, agentsMdApi } from "@/lib/runs-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("runsApi", () => {
  it("list() with no filters omits the query string", async () => {
    await runsApi.list();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/runs");
  });

  it("list() encodes every supplied filter and skips empties", async () => {
    await runsApi.list({
      projectId: "p1",
      sessionId: "s1",
      from: "2026-04-01",
      to: "2026-04-25",
      limit: 25,
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/runs?projectId=p1&sessionId=s1&from=2026-04-01&to=2026-04-25&limit=25",
    );
    await runsApi.list({ projectId: "", sessionId: "s1" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/runs?sessionId=s1");
  });

  it("get() / replay() URL-encode the id", async () => {
    await runsApi.get("run id 1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/runs/run%20id%201");
    await runsApi.replay("run id 1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/runs/run%20id%201/replay");
  });
});

describe("agentsMdApi", () => {
  it("preview() URL-encodes the project id and hits the right path", async () => {
    await agentsMdApi.preview("project a");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/project%20a/agents-md/preview");
  });

  it("getMarkdown() fetches text/markdown via fetch + credentials", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "md body" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const text = await agentsMdApi.getMarkdown("project a");
    expect(text).toBe("md body");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project%20a/agents-md", {
      credentials: "include",
    });
  });

  it("getMarkdown() throws on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () => "",
      })) as unknown as typeof fetch,
    );
    await expect(agentsMdApi.getMarkdown("p1")).rejects.toThrow(/403/);
  });
});
