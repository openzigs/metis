/**
 * traceability-api unit tests — Epic #207 (#226/#227/#228/#229).
 *
 * Verifies each wrapper hits the right path/method against a mocked apiFetch.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { traceabilityApi } from "@/lib/traceability-api";

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ok: true });
});

describe("traceabilityApi", () => {
  it("chain GETs the requirement traceability endpoint", async () => {
    await traceabilityApi.chain("proj-1", "req-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/requirements/req-1/traceability");
  });

  it("byFile passes the filePath query param", async () => {
    await traceabilityApi.byFile("proj-1", "src/auth.ts");
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/traceability/by-file", {
      params: { filePath: "src/auth.ts" },
    });
  });

  it("listSpecLinks GETs the requirement spec-mappings", async () => {
    await traceabilityApi.listSpecLinks("proj-1", "req-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/requirements/req-1/spec-mappings");
  });

  it("listCodeLinks GETs the spec code-mappings", async () => {
    await traceabilityApi.listCodeLinks("proj-1", "spec-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/specs/spec-1/code-mappings");
  });

  it("backfill POSTs the backfill endpoint", async () => {
    await traceabilityApi.backfill("proj-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/traceability/backfill", {
      method: "POST",
    });
  });

  it("returns the parsed response", async () => {
    apiFetchMock.mockResolvedValue([{ id: "x" }]);
    expect(await traceabilityApi.listCodeLinks("p", "s")).toEqual([{ id: "x" }]);
  });
});
