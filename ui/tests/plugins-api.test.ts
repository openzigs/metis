/**
 * Issue #123 — Plugins API client unit tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
const mockStreamFetch = vi.fn();

vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  streamFetch: (...args: unknown[]) => mockStreamFetch(...args),
}));

const { pluginsApi, triggerDownload } = await import("../src/lib/plugins-api");

function makeResponse(opts: { ok: boolean; body?: unknown; disposition?: string }): Response {
  return {
    ok: opts.ok,
    statusText: "Bad Request",
    headers: {
      get: (k: string) => (k === "content-disposition" ? (opts.disposition ?? null) : null),
    },
    blob: async () => new Blob([JSON.stringify(opts.body ?? {})], { type: "application/json" }),
    json: async () => opts.body,
  } as unknown as Response;
}

describe("pluginsApi.exportPlugin", () => {
  beforeEach(() => {
    mockStreamFetch.mockReset();
    mockApiFetch.mockReset();
  });

  it("posts the export payload and returns blob + filename from disposition", async () => {
    mockStreamFetch.mockResolvedValue(
      makeResponse({
        ok: true,
        body: { manifest: { name: "p" } },
        disposition: 'attachment; filename="metis-plugin-p.json"',
      }),
    );
    const { blob, filename } = await pluginsApi.exportPlugin({
      name: "p",
      version: "1.0.0",
      skillIds: ["s1"],
    });
    expect(filename).toBe("metis-plugin-p.json");
    expect(blob).toBeInstanceOf(Blob);
    const [path, init] = mockStreamFetch.mock.calls[0];
    expect(path).toBe("/plugins/export");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ name: "p", skillIds: ["s1"] });
  });

  it("falls back to a default filename when no disposition header", async () => {
    mockStreamFetch.mockResolvedValue(makeResponse({ ok: true, body: {} }));
    const { filename } = await pluginsApi.exportPlugin({ name: "demo", version: "1.0.0" });
    expect(filename).toBe("metis-plugin-demo.json");
  });

  it("throws a parsed error message on a non-ok response", async () => {
    mockStreamFetch.mockResolvedValue(
      makeResponse({ ok: false, body: { error: { message: "bad name" } } }),
    );
    await expect(pluginsApi.exportPlugin({ name: "x", version: "1.0.0" })).rejects.toThrow(
      "bad name",
    );
  });
});

describe("pluginsApi.importPlugin", () => {
  beforeEach(() => mockApiFetch.mockReset());

  it("posts the envelope through apiFetch", async () => {
    mockApiFetch.mockResolvedValue({
      manifest: { name: "p", version: "1.0.0", description: "" },
      installed: { skills: 1, agents: 0, hooks: 0 },
    });
    const result = await pluginsApi.importPlugin("proj1", { manifest: { name: "p" } });
    expect(mockApiFetch).toHaveBeenCalledWith("/plugins/import", {
      method: "POST",
      body: { projectId: "proj1", envelope: { manifest: { name: "p" } } },
    });
    expect(result.installed.skills).toBe(1);
  });
});

describe("triggerDownload", () => {
  it("creates and clicks a transient anchor", () => {
    const createObjectURL = vi.fn(() => "blob:abc");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    triggerDownload(new Blob(["x"]), "out.json");

    expect(createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:abc");
    clickSpy.mockRestore();
  });
});
