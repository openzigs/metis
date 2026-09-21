/**
 * Unit tests for the clarify CSV export/import analysis-api client functions.
 *
 * Both go through streamFetch (raw response, no JSON-stringify): export reads a
 * blob + Content-Disposition filename; import posts a FormData and parses the
 * `{ success, data }` envelope, throwing the server message on failure.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
const mockStreamFetch = vi.fn();

vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  streamFetch: (...args: unknown[]) => mockStreamFetch(...args),
}));

const { analysisApi } = await import("../../src/lib/analysis-api");

function makeResponse(opts: {
  ok: boolean;
  body?: unknown;
  blobBody?: string;
  disposition?: string;
}): Response {
  return {
    ok: opts.ok,
    statusText: "Bad Request",
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-disposition" ? (opts.disposition ?? null) : null,
    },
    blob: async () => new Blob([opts.blobBody ?? ""], { type: "text/csv" }),
    json: async () => opts.body,
  } as unknown as Response;
}

beforeEach(() => {
  mockStreamFetch.mockReset();
  mockApiFetch.mockReset();
});

describe("analysisApi.exportClarifyCsv", () => {
  it("requests the export endpoint with format=csv and returns blob + filename", async () => {
    mockStreamFetch.mockResolvedValue(
      makeResponse({
        ok: true,
        blobBody: "questionId,answer\r\n",
        disposition: 'attachment; filename="clarifying-questions-ana-1.csv"',
      }),
    );
    const { blob, filename } = await analysisApi.exportClarifyCsv("proj-1", "ana-1");
    expect(filename).toBe("clarifying-questions-ana-1.csv");
    expect(blob).toBeInstanceOf(Blob);
    const [path, init] = mockStreamFetch.mock.calls[0];
    expect(path).toBe("/projects/proj-1/analyses/ana-1/clarify/export");
    expect(init.method).toBe("GET");
    expect(init.params).toEqual({ format: "csv" });
  });

  it("falls back to a default filename when no disposition header", async () => {
    mockStreamFetch.mockResolvedValue(makeResponse({ ok: true, blobBody: "x" }));
    const { filename } = await analysisApi.exportClarifyCsv("proj-1", "ana-9");
    expect(filename).toBe("clarifying-questions-ana-9.csv");
  });

  it("throws the parsed error message on a non-ok response", async () => {
    mockStreamFetch.mockResolvedValue(
      makeResponse({ ok: false, body: { error: { message: "no questions" } } }),
    );
    await expect(analysisApi.exportClarifyCsv("proj-1", "ana-1")).rejects.toThrow("no questions");
  });
});

describe("analysisApi.importClarifyAnswers", () => {
  it("posts a FormData with the file and returns the summary on success", async () => {
    mockStreamFetch.mockResolvedValue(
      makeResponse({
        ok: true,
        body: { success: true, data: { applied: 2, skipped: 1, unmatched: ["q-x"] } },
      }),
    );
    const file = new File(["questionId,answer\nq-1,yes"], "answers.csv", { type: "text/csv" });
    const result = await analysisApi.importClarifyAnswers("proj-1", "ana-1", file);
    expect(result).toEqual({ applied: 2, skipped: 1, unmatched: ["q-x"] });
    const [path, init] = mockStreamFetch.mock.calls[0];
    expect(path).toBe("/projects/proj-1/analyses/ana-1/clarify/import");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBe(file);
  });

  it("throws the server error message when success is false", async () => {
    mockStreamFetch.mockResolvedValue(
      makeResponse({ ok: false, body: { success: false, error: { message: "bad headers" } } }),
    );
    const file = new File(["x"], "answers.csv", { type: "text/csv" });
    await expect(analysisApi.importClarifyAnswers("proj-1", "ana-1", file)).rejects.toThrow(
      "bad headers",
    );
  });

  it("throws a generic message when the error envelope lacks a message", async () => {
    mockStreamFetch.mockResolvedValue(makeResponse({ ok: false, body: { success: false } }));
    const file = new File(["x"], "answers.csv", { type: "text/csv" });
    await expect(analysisApi.importClarifyAnswers("proj-1", "ana-1", file)).rejects.toThrow(
      "Import failed",
    );
  });
});
