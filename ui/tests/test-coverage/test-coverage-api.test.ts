/**
 * Tests for `testCoverageApi` client (Epic #856 issue #865).
 *
 * Focus: the binary `exportRun` path that bypasses `apiFetch`, the
 * filename extraction from `Content-Disposition`, and `downloadBlob`.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { testCoverageApi, downloadBlob } from "@/lib/test-coverage-api";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  apiFetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("testCoverageApi.exportRun", () => {
  it("returns blob + filename derived from Content-Disposition", async () => {
    const blob = new Blob(["hello"], { type: "application/zip" });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "content-disposition"
            ? 'attachment; filename="my-export.xlsx"'
            : null,
      },
      blob: async () => blob,
    });
    const r = await testCoverageApi.exportRun("proj-1", {
      runId: "run-1",
      target: "excel",
    });
    if (r.kind !== "file") throw new Error("expected file result");
    expect(r.filename).toBe("my-export.xlsx");
    expect(r.blob).toBe(blob);
  });

  it("falls back to a default filename when header is missing", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      blob: async () => new Blob(["x"]),
    });
    const r = await testCoverageApi.exportRun("p", {
      runId: "abc",
      target: "gherkin",
    });
    if (r.kind !== "file") throw new Error("expected file result");
    expect(r.filename).toBe("coverage-abc.bin");
  });

  it("throws an enriched Error on non-ok response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({
        error: {
          code: "LOW_CONFIDENCE_BLOCKED",
          message: "blocked",
          details: { suggestionIds: ["s1"] },
        },
      }),
    });
    await expect(
      testCoverageApi.exportRun("p", {
        runId: "r",
        target: "gherkin",
      }),
    ).rejects.toMatchObject({
      message: "blocked",
      code: "LOW_CONFIDENCE_BLOCKED",
      details: { suggestionIds: ["s1"] },
    });
  });

  it("uses generic message when error body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => {
        throw new Error("not json");
      },
    });
    await expect(testCoverageApi.exportRun("p", { runId: "r", target: "excel" })).rejects.toThrow(
      /Export failed \(500\)/,
    );
  });
});

describe("testCoverageApi.uploadImport", () => {
  it("posts a FormData payload", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { id: "imp-1" } }),
    });
    const file = new File(["a,b\n1,2"], "cases.csv", { type: "text/csv" });
    const r = await testCoverageApi.uploadImport("p", file);
    expect(r.id).toBe("imp-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("throws on non-ok with message from envelope", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 415,
      json: async () => ({ error: { message: "unsupported" } }),
    });
    const file = new File(["x"], "x.bin", { type: "application/octet-stream" });
    await expect(testCoverageApi.uploadImport("p", file)).rejects.toThrow(/unsupported/);
  });
});

describe("testCoverageApi (apiFetch-backed methods)", () => {
  it("listImports calls the right path", async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    await testCoverageApi.listImports("p1");
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/p1/test-coverage/imports");
  });

  it("pasteImport posts JSON", async () => {
    apiFetchMock.mockResolvedValueOnce({ id: "i" });
    await testCoverageApi.pasteImport("p", {
      source: "csv",
      text: "a,b\n1,2",
      label: "L",
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/projects/p/test-coverage/imports/paste",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("listRuns + getRun + createRun delegate to apiFetch", async () => {
    apiFetchMock.mockResolvedValue({ id: "r" });
    await testCoverageApi.listRuns("p");
    await testCoverageApi.getRun("p", "r");
    await testCoverageApi.createRun("p", { budgetCents: 100 });
    expect(apiFetchMock.mock.calls[0][0]).toBe("/projects/p/test-coverage/runs");
    expect(apiFetchMock.mock.calls[1][0]).toBe("/projects/p/test-coverage/runs/r");
    expect(apiFetchMock.mock.calls[2][1]).toMatchObject({ method: "POST" });
  });

  it("getReport + getBudget hit run-scoped sub-paths", async () => {
    apiFetchMock.mockResolvedValue({});
    await testCoverageApi.getReport("p", "r");
    await testCoverageApi.getBudget("p", "r");
    expect(apiFetchMock.mock.calls[0][0]).toBe("/projects/p/test-coverage/runs/r/report");
    expect(apiFetchMock.mock.calls[1][0]).toBe("/projects/p/test-coverage/runs/r/budget");
  });

  it("overrideMapping + updateSuggestion patch their resources", async () => {
    apiFetchMock.mockResolvedValue({});
    await testCoverageApi.overrideMapping("p", "m", { status: "COVERED" });
    await testCoverageApi.updateSuggestion("p", "s", { status: "accepted" });
    expect(apiFetchMock.mock.calls[0]).toEqual([
      "/projects/p/test-coverage/mappings/m",
      expect.objectContaining({ method: "PATCH" }),
    ]);
    expect(apiFetchMock.mock.calls[1]).toEqual([
      "/projects/p/test-coverage/suggestions/s",
      expect.objectContaining({ method: "PATCH" }),
    ]);
  });
});

describe("downloadBlob", () => {
  it("creates an anchor and triggers a click", () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL } as unknown as typeof URL);
    const blob = new Blob(["x"]);

    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLAnchorElement;
      if (tag === "a") {
        el.click = clickSpy;
      }
      return el;
    });

    downloadBlob(blob, "x.xlsx");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
  });
});
